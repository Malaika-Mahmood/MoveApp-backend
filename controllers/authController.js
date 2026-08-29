const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const { sendEmailOtp } = require("../services/notificationService");
const {
    OTP_TTL_MINUTES,
    MAX_VERIFY_ATTEMPTS,
    MAX_RESENDS,
    RESEND_COOLDOWN_SECONDS,
    generateOtp,
    hashOtp,
    otpMatches,
    otpExpiryDate,
    secondsSince,
    shouldExposeOtp
} = require("../utils/otp");

const TOKEN_EXPIRY = "7d";
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\+?[0-9\s\-()]{7,20}$/;

const issueAccessToken = (user) => {
    if (!process.env.JWT_SECRET) {
        throw new Error("JWT_SECRET is not set in the environment");
    }
    return jwt.sign(
        { id: user.id, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: TOKEN_EXPIRY }
    );
};

// The most recent sign-up attempt for an email that has not been used or replaced
const findActiveRegistration = async (email) => {
    const result = await pool.query(
        `SELECT * FROM pending_registrations
         WHERE LOWER(email) = LOWER($1) AND consumed_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [email]
    );
    return result.rows[0] || null;
};

// STEP 1 OF SIGN-UP
// Collect the driver's details and email them a code.
// Nothing is written to `users` yet — the account only exists once verified.
const registerStart = async (req, res) => {
    try {
        const { full_name, email, phone } = req.body;

        if (!full_name || !email || !phone) {
            return res.status(400).json({
                message: "All fields are required: full_name, email, phone"
            });
        }

        const cleanName = String(full_name).trim();
        const cleanEmail = String(email).trim();
        const cleanPhone = String(phone).trim();

        if (cleanName.length < 2) {
            return res.status(400).json({
                message: "full_name must be at least 2 characters"
            });
        }

        if (!EMAIL_REGEX.test(cleanEmail)) {
            return res.status(400).json({
                message: "Please provide a valid email address"
            });
        }

        if (!PHONE_REGEX.test(cleanPhone)) {
            return res.status(400).json({
                message: "Please provide a valid phone number"
            });
        }

        // Is this already a real account?
        const existingUser = await pool.query(
            "SELECT id FROM users WHERE LOWER(email) = LOWER($1) OR phone = $2",
            [cleanEmail, cleanPhone]
        );

        if (existingUser.rows.length > 0) {
            return res.status(409).json({
                message: "An account with this email or phone already exists"
            });
        }

        // Don't let anyone spam a stranger's inbox with codes
        const active = await findActiveRegistration(cleanEmail);

        if (active) {
            const waited = secondsSince(active.last_sent_at);

            if (waited < RESEND_COOLDOWN_SECONDS) {
                return res.status(429).json({
                    message: "A code was just sent. Please wait before requesting another.",
                    retry_after_seconds: RESEND_COOLDOWN_SECONDS - waited
                });
            }

            // A new attempt supersedes the earlier one, so the old code stops working
            await pool.query(
                "UPDATE pending_registrations SET consumed_at = NOW() WHERE id = $1",
                [active.id]
            );
        }

        const otp = generateOtp();

        // Public sign-up creates drivers only. Operator accounts are assigned by
        // the company directly, so `role` is never taken from the request body.
        await pool.query(
            `INSERT INTO pending_registrations
                (full_name, email, phone, role, otp_hash, expires_at)
             VALUES ($1, $2, $3, 'driver', $4, $5)`,
            [cleanName, cleanEmail, cleanPhone, hashOtp(otp), otpExpiryDate()]
        );

        await sendEmailOtp(cleanEmail, otp);

        res.status(200).json({
            message: "Verification code sent to your email",
            email: cleanEmail,
            expires_in_minutes: OTP_TTL_MINUTES,
            ...(shouldExposeOtp() ? { dev_otp: otp } : {})
        });

    } catch (error) {
        console.error("Error in registerStart:", error);
        res.status(500).json({
            message: "Something went wrong while starting registration"
        });
    }
};

// STEP 2 OF SIGN-UP
// Check the code, then create the account.
const registerVerify = async (req, res) => {
    const client = await pool.connect();

    try {
        const { email, otp } = req.body;

        if (!email || !otp) {
            return res.status(400).json({ message: "Email and OTP are required" });
        }

        const pending = await findActiveRegistration(String(email).trim());

        if (!pending || new Date(pending.expires_at) <= new Date()) {
            return res.status(400).json({
                message: "Invalid or expired verification code"
            });
        }

        if (pending.attempt_count >= MAX_VERIFY_ATTEMPTS) {
            return res.status(429).json({
                message: "Too many incorrect attempts. Please request a new code."
            });
        }

        if (!otpMatches(otp, pending.otp_hash)) {
            const updated = await pool.query(
                `UPDATE pending_registrations
                 SET attempt_count = attempt_count + 1
                 WHERE id = $1
                 RETURNING attempt_count`,
                [pending.id]
            );

            const remaining = MAX_VERIFY_ATTEMPTS - updated.rows[0].attempt_count;

            // Burn the code once the attempt budget is gone, so a guessing script
            // cannot keep working on the same 6 digits
            if (remaining <= 0) {
                await pool.query(
                    "UPDATE pending_registrations SET consumed_at = NOW() WHERE id = $1",
                    [pending.id]
                );

                return res.status(429).json({
                    message: "Too many incorrect attempts. Please request a new code."
                });
            }

            return res.status(400).json({
                message: "Invalid or expired verification code",
                attempts_remaining: remaining
            });
        }

        // Correct code. Create the account and consume the request together, so a
        // crash between the two cannot leave a code that works twice.
        await client.query("BEGIN");

        const newUser = await client.query(
            `INSERT INTO users
                (full_name, email, phone, role, status, email_verified, phone_verified)
             VALUES ($1, $2, $3, $4, 'account_created', TRUE, FALSE)
             RETURNING id, full_name, email, phone, role, status,
                       email_verified, phone_verified, created_at`,
            [pending.full_name, pending.email, pending.phone, pending.role]
        );

        await client.query(
            "UPDATE pending_registrations SET consumed_at = NOW() WHERE id = $1",
            [pending.id]
        );

        await client.query("COMMIT");

        const user = newUser.rows[0];
        const accessToken = issueAccessToken(user);

        res.status(201).json({
            message: "Account created successfully",
            accessToken,
            user
        });

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });

        // The unique indexes are the real guard against two simultaneous requests
        if (error.code === "23505") {
            return res.status(409).json({
                message: "An account with this email or phone already exists"
            });
        }

        console.error("Error in registerVerify:", error);
        res.status(500).json({
            message: "Something went wrong while creating the account"
        });

    } finally {
        client.release();
    }
};

// Send the sign-up code again
const registerResend = async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ message: "Email is required" });
        }

        const pending = await findActiveRegistration(String(email).trim());

        if (!pending) {
            return res.status(404).json({
                message: "No pending registration found for this email. Please start again."
            });
        }

        if (pending.resend_count >= MAX_RESENDS) {
            return res.status(429).json({
                message: "Resend limit reached. Please start registration again."
            });
        }

        const waited = secondsSince(pending.last_sent_at);

        if (waited < RESEND_COOLDOWN_SECONDS) {
            return res.status(429).json({
                message: "Please wait before requesting another code",
                retry_after_seconds: RESEND_COOLDOWN_SECONDS - waited
            });
        }

        // A new code replaces the old one, and the attempt budget resets with it
        const otp = generateOtp();

        await pool.query(
            `UPDATE pending_registrations
             SET otp_hash = $1,
                 expires_at = $2,
                 attempt_count = 0,
                 resend_count = resend_count + 1,
                 last_sent_at = NOW()
             WHERE id = $3`,
            [hashOtp(otp), otpExpiryDate(), pending.id]
        );

        await sendEmailOtp(pending.email, otp);

        res.status(200).json({
            message: "A new verification code has been sent to your email",
            expires_in_minutes: OTP_TTL_MINUTES,
            ...(shouldExposeOtp() ? { dev_otp: otp } : {})
        });

    } catch (error) {
        console.error("Error in registerResend:", error);
        res.status(500).json({
            message: "Something went wrong while resending the code"
        });
    }
};

// Replaced by the two-step flow above. Kept so the frontend gets a clear
// message instead of a confusing 404.
const createAccount = async (req, res) => {
    res.status(410).json({
        message: "This endpoint has been replaced. Use POST /api/v1/auth/register/start, then POST /api/v1/auth/register/verify."
    });
};

module.exports = { registerStart, registerVerify, registerResend, createAccount };