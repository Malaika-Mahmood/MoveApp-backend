const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const { sendEmailOtp, sendSmsOtp } = require("../services/notificationService");
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
    shouldExposeOtp,
    isTestIdentifier,
    getTestOtp
} = require("../utils/otp");

const TOKEN_EXPIRY = "7d";
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\+?[0-9\s\-()]{7,20}$/;

// Drivers and operators use exactly the same sign-up flow, from any email
// address. What keeps the system safe is not who may register but what a new
// account may do:
//
//   a new driver   cannot work until an operator approves their documents
//   a new operator cannot review a single driver until an ADMIN approves theirs
//
// The company-email restriction that used to guard operator sign-up is gone —
// admin approval replaced it, and a person deciding is a better gate than an
// email domain anyone can buy.
//
// `admin` is deliberately not accepted here. The first admin is inserted by
// hand; after that an admin creates the others through /api/v1/admin/admins.
//
// This matters more than it used to. Sign-up now issues a fixed code to any
// number on the test list, and the ONLY reason that is safe is that this list
// cannot produce an admin.
const SIGNUP_ROLES = ["driver", "operator"];

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

// ---------------------------------------------------------------------------
// Finding a sign-up in progress
// ---------------------------------------------------------------------------
// The phone is now what identifies a sign-up, because the phone is what the
// code was sent to.
//
// Email lookup is kept alongside it, and deliberately so: anyone who started
// signing up before this deployed has a row keyed on their email and a code in
// their inbox. Removing the email path would leave them stuck at a screen that
// can no longer find them. It costs one small function to not do that to
// people, and it can come out once those rows have expired.
const findActiveRegistrationByPhone = async (phone) => {
    const result = await pool.query(
        `SELECT * FROM pending_registrations
         WHERE phone = $1 AND consumed_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [String(phone).trim()]
    );
    return result.rows[0] || null;
};

const findActiveRegistrationByEmail = async (email) => {
    const result = await pool.query(
        `SELECT * FROM pending_registrations
         WHERE LOWER(email) = $1 AND consumed_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [String(email).trim().toLowerCase()]
    );
    return result.rows[0] || null;
};

// Whichever the app sent. Phone first — that is the new contract, and the one
// the frontend should move to.
const findActiveRegistration = async ({ phone, email }) => {
    if (phone) {
        const byPhone = await findActiveRegistrationByPhone(phone);
        if (byPhone) return byPhone;
    }
    if (email) {
        return findActiveRegistrationByEmail(email);
    }
    return null;
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

        if (!SIGNUP_ROLES.includes(requestedRole)) {
            return res.status(400).json({
                message: "role must be either 'driver' or 'operator'"
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

        // Is this one of the listed test numbers?
        //
        // Sign-up cannot create an admin — SIGNUP_ROLES has two entries and
        // neither is 'admin' — so unlike login there is no admin exception to
        // make here. The worst this can produce is a driver or operator
        // account sitting at 'account_created', which can see nothing and do
        // nothing until a human approves its documents.
        //
        // All of it is off unless TEST_OTP and TEST_PHONE_NUMBERS are both
        // set. See utils/otp.js.
        const isTestAccount = isTestIdentifier(cleanPhone);

        const active = await findActiveRegistrationByPhone(cleanPhone);

        if (active) {
            const waited = secondsSince(active.last_sent_at);

            // The wait between codes exists to stop somebody running up an SMS
            // bill. A test number sends no message and costs nothing, and the
            // person using it is asking for a code every thirty seconds while
            // they build a screen.
            if (!isTestAccount && waited < RESEND_COOLDOWN_SECONDS) {
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

        // The ONLY difference for a test number is that the digits are known
        // in advance. The code is hashed the same way, expires in the same
        // five minutes, is spent once, and allows the same five attempts.
        // Verification neither knows nor cares that this was a test number,
        // which is what makes it safe: there is no second way in, only a
        // predictable code.
        const otp = isTestAccount ? getTestOtp() : generateOtp();

        await pool.query(
            `INSERT INTO pending_registrations
                (first_name, middle_name, last_name, email, phone, role, otp_hash, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [cleanFirstName, cleanMiddleName, cleanLastName, cleanEmail, cleanPhone,
                requestedRole, hashOtp(otp), otpExpiryDate()]
        );

        // Nothing is sent for a test number. It belongs to nobody, and once
        // this runs through a real provider a message to a made-up number is a
        // failed send and a charge. The code is in the database either way,
        // which is all that matters.
        if (!isTestAccount) {
            await sendSmsOtp(cleanPhone, otp);
        }

        res.status(200).json({
            message: "Verification code sent to your phone",

            // Both are returned. The app needs the phone for the next call;
            // the email is echoed so a sign-up screen can show what it is
            // about to create without holding it itself.
            phone: cleanPhone,
            email: cleanEmail,
            role: requestedRole,
            expires_in_minutes: OTP_TTL_MINUTES,

            // Said out loud so nobody sits waiting for a text that is never
            // coming, and so it is obvious in a screenshot that this was a
            // test number rather than a real sign-up.
            ...(isTestAccount ? { test_account: true } : {}),

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
        const { phone, email, otp } = req.body;

        // Phone is the contract from here on. Email is still accepted so that
        // a sign-up begun before this deployed can still be finished.
        if ((!phone && !email) || !otp) {
            return res.status(400).json({ message: "Phone and OTP are required" });
        }

        const cleanOtp = String(otp).trim();

        const pending = await findActiveRegistration({ phone, email });

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

        // Both roles start at the beginning of their own onboarding: a driver
        // has documents and a vehicle to submit, an operator has business
        // documents and council licences.
        await client.query("BEGIN");

        // phone_verified TRUE, email_verified FALSE — the reverse of what this
        // used to write, and the whole point of the change. The code went to
        // the phone, so the phone is what has been proved. The email has been
        // typed and nothing more; saying otherwise would be a lie the next
        // feature builds on.
        const newUser = await client.query(
            `INSERT INTO users
                (first_name, middle_name, last_name, email, phone, role, status,
                 email_verified, phone_verified)
             VALUES ($1, $2, $3, $4, $5, $6, 'account_created', FALSE, TRUE)
             RETURNING id, first_name, middle_name, last_name, email, phone, role, status,
                       email_verified, phone_verified, created_at`,
            [pending.first_name, pending.middle_name, pending.last_name,
            pending.email, pending.phone, pending.role]
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
        const { phone, email } = req.body;

        if (!phone && !email) {
            return res.status(400).json({ message: "Phone is required" });
        }

        const pending = await findActiveRegistration({ phone, email });

        if (!pending) {
            return res.status(404).json({
                message: "No pending registration found for this number. Please start again."
            });
        }

        if (pending.resend_count >= MAX_RESENDS) {
            return res.status(429).json({
                message: "Resend limit reached. Please start registration again."
            });
        }

        const isTestAccount = isTestIdentifier(pending.phone);
        const waited = secondsSince(pending.last_sent_at);

        if (!isTestAccount && waited < RESEND_COOLDOWN_SECONDS) {
            return res.status(429).json({
                message: "Please wait before requesting another code",
                retry_after_seconds: RESEND_COOLDOWN_SECONDS - waited
            });
        }

        const otp = isTestAccount ? getTestOtp() : generateOtp();

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

        if (!isTestAccount) {
            await sendSmsOtp(pending.phone, otp);
        }

        res.status(200).json({
            message: "A new verification code has been sent to your phone",
            expires_in_minutes: OTP_TTL_MINUTES,
            ...(isTestAccount ? { test_account: true } : {}),
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

// Deliberately unused for now, and kept imported so the next person sees it:
// sendEmailOtp still serves login by email (otpController). Sign-up no longer
// uses it. If email verification is ever added back as a second step, this is
// where it goes — after the account exists, not before it.
void sendEmailOtp;