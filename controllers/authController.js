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

// Operators use exactly the same sign-up flow as drivers — no credentials are
// handed out — but only from a company email address.
//
// Without this restriction anyone could send role: "operator", then approve
// their own documents and become a verified driver. The whole verification
// system rests on this one check.
//
// Set OPERATOR_EMAIL_DOMAINS in .env (comma-separated for more than one).
const OPERATOR_EMAIL_DOMAINS = (process.env.OPERATOR_EMAIL_DOMAINS || "eurocarslondon.co.uk")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);

if (!process.env.OPERATOR_EMAIL_DOMAINS) {
    console.warn(
        `[auth] OPERATOR_EMAIL_DOMAINS is not set — falling back to: ${OPERATOR_EMAIL_DOMAINS.join(", ")}`
    );
}

const isCompanyEmail = (email) => {
    const at = String(email).lastIndexOf("@");
    if (at === -1) return false;
    return OPERATOR_EMAIL_DOMAINS.includes(String(email).slice(at + 1).toLowerCase());
};

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

const findActiveRegistration = async (email) => {
    const cleanEmail = String(email).trim().toLowerCase();
    const result = await pool.query(
        `SELECT * FROM pending_registrations
         WHERE LOWER(email) = $1 AND consumed_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [cleanEmail]
    );
    return result.rows[0] || null;
};

// STEP 1 OF SIGN-UP
const registerStart = async (req, res) => {
    try {
        const { first_name, middle_name, last_name, email, phone, role } = req.body;

        if (!first_name || !last_name || !email || !phone) {
            return res.status(400).json({
                message: "All fields are required: first_name, last_name, email, phone"
            });
        }

        const cleanFirstName = String(first_name).trim();
        const cleanMiddleName = middle_name ? String(middle_name).trim() : null;
        const cleanLastName = String(last_name).trim();
        const cleanEmail = String(email).trim().toLowerCase();
        const cleanPhone = String(phone).trim();

        // Defaults to driver, so the app does not have to send anything
        const requestedRole = role ? String(role).trim().toLowerCase() : "driver";

        if (!["driver", "operator"].includes(requestedRole)) {
            return res.status(400).json({
                message: "role must be either 'driver' or 'operator'"
            });
        }

        if (requestedRole === "operator" && !isCompanyEmail(cleanEmail)) {
            return res.status(403).json({
                message: "Operator accounts can only be created with a company email address",
                error_code: "OPERATOR_EMAIL_REQUIRED"
            });
        }

        if (cleanFirstName.length < 2 || cleanLastName.length < 2) {
            return res.status(400).json({
                message: "First and last name must be at least 2 characters"
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

        const existingUser = await pool.query(
            "SELECT id FROM users WHERE LOWER(email) = $1 OR phone = $2",
            [cleanEmail, cleanPhone]
        );

        if (existingUser.rows.length > 0) {
            return res.status(409).json({
                message: "An account with this email or phone already exists"
            });
        }

        const active = await findActiveRegistration(cleanEmail);

        if (active) {
            const waited = secondsSince(active.last_sent_at);

            if (waited < RESEND_COOLDOWN_SECONDS) {
                return res.status(429).json({
                    message: "A code was just sent. Please wait before requesting another.",
                    retry_after_seconds: RESEND_COOLDOWN_SECONDS - waited
                });
            }

            await pool.query(
                "UPDATE pending_registrations SET consumed_at = NOW() WHERE id = $1",
                [active.id]
            );
        }

        const otp = generateOtp();

        await pool.query(
            `INSERT INTO pending_registrations
                (first_name, middle_name, last_name, email, phone, role, otp_hash, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [cleanFirstName, cleanMiddleName, cleanLastName, cleanEmail, cleanPhone,
                requestedRole, hashOtp(otp), otpExpiryDate()]
        );

        await sendEmailOtp(cleanEmail, otp);

        res.status(200).json({
            message: "Verification code sent to your email",
            email: cleanEmail,
            role: requestedRole,
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
const registerVerify = async (req, res) => {
    const client = await pool.connect();

    try {
        const { email, otp } = req.body;

        if (!email || !otp) {
            return res.status(400).json({ message: "Email and OTP are required" });
        }

        const cleanEmail = String(email).trim().toLowerCase();
        const cleanOtp = String(otp).trim();

        const pending = await findActiveRegistration(cleanEmail);

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

        if (!otpMatches(cleanOtp, pending.otp_hash)) {
            const updated = await pool.query(
                `UPDATE pending_registrations
                 SET attempt_count = attempt_count + 1
                 WHERE id = $1
                 RETURNING attempt_count`,
                [pending.id]
            );

            const remaining = MAX_VERIFY_ATTEMPTS - updated.rows[0].attempt_count;

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

        // An operator's email domain was already checked at registerStart, and
        // they have no documents to submit, so they start ready to work.
        // A driver starts at the beginning of onboarding.
        const initialStatus = pending.role === "operator" ? "approved" : "account_created";

        await client.query("BEGIN");

        const newUser = await client.query(
            `INSERT INTO users
                (first_name, middle_name, last_name, email, phone, role, status,
                 email_verified, phone_verified)
             VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, FALSE)
             RETURNING id, first_name, middle_name, last_name, email, phone, role, status,
                       email_verified, phone_verified, created_at`,
            [pending.first_name, pending.middle_name, pending.last_name,
            pending.email, pending.phone, pending.role, initialStatus]
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

const registerResend = async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ message: "Email is required" });
        }

        const cleanEmail = String(email).trim().toLowerCase();
        const pending = await findActiveRegistration(cleanEmail);

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

const createAccount = async (req, res) => {
    res.status(410).json({
        message: "This endpoint has been replaced. Use POST /api/v1/auth/register/start, then POST /api/v1/auth/register/verify."
    });
};

module.exports = { registerStart, registerVerify, registerResend, createAccount };