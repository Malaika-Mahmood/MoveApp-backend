const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const notify = require("../services/notificationService");
const {
    OTP_TTL_MINUTES,
    MAX_VERIFY_ATTEMPTS,
    RESEND_COOLDOWN_SECONDS,
    generateOtp,
    hashOtp,
    otpMatches,
    otpExpiryDate,
    secondsSince,
    shouldExposeOtp,
    isTestIdentifier,
    isTestAdminIdentifier,
    getTestOtp
} = require("../utils/otp");

// LOGIN, not sign-up.
//
// Sign-up lives in authController and writes to pending_registrations — no
// users row exists yet at that point. These four endpoints are for someone who
// already HAS an account and is coming back:
//
//   POST /auth/send-otp          phone   ->  POST /auth/verify-otp
//   POST /auth/send-email-otp    email   ->  POST /auth/verify-email-otp
//
// Both write to otp_codes. Drivers, operators and admins all use these — the
// role is read off the users row, never sent by the app.

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

// What the app gets back after a successful login. Deliberately the same shape
// for every role, so the frontend has one login response to handle.
const toAuthUser = (u) => ({
    id: u.id,
    title: u.title,
    first_name: u.first_name,
    middle_name: u.middle_name,
    last_name: u.last_name,
    full_name: [u.first_name, u.middle_name, u.last_name].filter(Boolean).join(" "),
    email: u.email,
    phone: u.phone,
    role: u.role,
    status: u.status,
    email_verified: u.email_verified,
    phone_verified: u.phone_verified,
    created_at: u.created_at
});

// The most recent code that has not been used yet
const findLiveCode = async (identifier, type) => {
    const result = await pool.query(
        `SELECT * FROM otp_codes
         WHERE identifier = $1 AND otp_type = $2 AND is_used = FALSE
         ORDER BY created_at DESC
         LIMIT 1`,
        [identifier, type]
    );
    return result.rows[0] || null;
};

// Shared by both send endpoints. `type` is 'phone' or 'email'.
const sendLoginCode = async (req, res, type) => {
    const isPhone = type === "phone";
    const field = isPhone ? "phone" : "email";

    try {
        const raw = req.body[field];

        if (!raw) {
            return res.status(400).json({ message: `${field} is required` });
        }

        const identifier = isPhone
            ? String(raw).trim()
            : String(raw).trim().toLowerCase();

        const valid = isPhone
            ? PHONE_REGEX.test(identifier)
            : EMAIL_REGEX.test(identifier);

        if (!valid) {
            return res.status(400).json({
                message: isPhone
                    ? "Please provide a valid phone number"
                    : "Please provide a valid email address"
            });
        }

        const userResult = await pool.query(
            isPhone
                ? "SELECT * FROM users WHERE phone = $1"
                : "SELECT * FROM users WHERE LOWER(email) = $1",
            [identifier]
        );

        const user = userResult.rows[0];

        // Telling a stranger which phone numbers and emails have accounts is
        // how you hand someone a list of your drivers. The response is the
        // same either way; only a real account actually gets a code.
        if (!user) {
            return res.status(200).json({
                message: `If an account exists, a verification code has been sent to your ${field}`,
                expires_in_minutes: OTP_TTL_MINUTES
            });
        }

        // Admins sign in by phone only.
        //
        // An admin can open every driver's passport and every operator's
        // licence, so theirs is the most valuable account in the system. An
        // email inbox is the easiest thing to take over — an old password, a
        // reused one, a leak from some unrelated site. A phone number takes far
        // more effort to steal.
        //
        // This does tell the caller that a particular email belongs to an
        // admin, which is a small leak. It is worth it: there are only three or
        // four admins, they know to use their phone, and knowing WHICH email
        // belongs to an admin does not help anyone get in. The alternative —
        // silently pretending to send a code — would leave a real admin staring
        // at a screen waiting for a message that is never coming.
        if (user.role === "admin" && !isPhone) {
            return res.status(403).json({
                message: "Admins sign in with their phone number, not their email address.",
                error_code: "ADMIN_PHONE_ONLY"
            });
        }

        if (user.status === "suspended") {
            return res.status(403).json({
                message: "This account has been suspended. Please contact support.",
                error_code: "ACCOUNT_SUSPENDED"
            });
        }

        // Is this one of the listed test accounts?
        //
        // An admin needs a third variable naming that exact number, on top of
        // the two the list already needs. The admin app has to be built by
        // somebody who cannot read the server's logs, so this has to be
        // possible — but an admin can open every driver's passport, so it must
        // never happen because somebody added a number to a list.
        //
        // All of it is off unless those variables are set, and they are never
        // set on the live deployment. See utils/otp.js.
        const isTestAccount =
            isTestIdentifier(identifier) &&
            (user.role !== "admin" || isTestAdminIdentifier(identifier));

        const live = await findLiveCode(identifier, type);

        if (live) {
            const waited = secondsSince(live.created_at);

            // The one-minute wait between codes is there to stop somebody
            // hammering the SMS bill. A test account sends no message and
            // costs nothing, and the person using it is asking for a code
            // every thirty seconds while they build a screen.
            if (!isTestAccount && waited < RESEND_COOLDOWN_SECONDS) {
                return res.status(429).json({
                    message: "A code was just sent. Please wait before requesting another.",
                    retry_after_seconds: RESEND_COOLDOWN_SECONDS - waited
                });
            }

            // Only the newest code may be used
            await pool.query(
                "UPDATE otp_codes SET is_used = TRUE WHERE id = $1",
                [live.id]
            );
        }

        // The ONLY difference for a test account: the digits are known in
        // advance. Everything below is the ordinary path — the code is hashed
        // the same way, expires in the same five minutes, can be spent once,
        // and allows the same five attempts. Nothing about verification knows
        // or cares that this was a test account, which is exactly why this
        // change is safe: there is no second way in, only a predictable code.
        const otp = isTestAccount ? getTestOtp() : generateOtp();

        await pool.query(
            `INSERT INTO otp_codes (identifier, otp_hash, otp_type, expires_at)
             VALUES ($1, $2, $3, $4)`,
            [identifier, hashOtp(otp), type, otpExpiryDate()]
        );

        // Nothing is sent for a test account. The number belongs to nobody, and
        // once this goes through a real provider a message to a made-up number
        // is a failed send and a charge. The code is in the database either
        // way, which is all that matters.
        if (!isTestAccount) {
            if (isPhone) {
                await notify.sendSmsOtp(identifier, otp);
            } else {
                await notify.sendEmailOtp(identifier, otp);
            }
        }

        res.status(200).json({
            message: `If an account exists, a verification code has been sent to your ${field}`,
            expires_in_minutes: OTP_TTL_MINUTES,

            // Said out loud so nobody sits waiting for a text that is never
            // coming, and so it is obvious in a screenshot that this was a
            // test account rather than a real login.
            ...(isTestAccount ? { test_account: true } : {}),

            ...(shouldExposeOtp() ? { dev_otp: otp } : {})
        });

    } catch (error) {
        console.error(`Error in sendLoginCode (${type}):`, error);
        res.status(500).json({ message: "Something went wrong while sending the code" });
    }
};

// Shared by both verify endpoints.
const verifyLoginCode = async (req, res, type) => {
    const isPhone = type === "phone";
    const field = isPhone ? "phone" : "email";

    try {
        const raw = req.body[field];
        const { otp } = req.body;

        if (!raw || !otp) {
            return res.status(400).json({ message: `${field} and otp are required` });
        }

        const identifier = isPhone
            ? String(raw).trim()
            : String(raw).trim().toLowerCase();

        const cleanOtp = String(otp).trim();

        const live = await findLiveCode(identifier, type);

        if (!live || new Date(live.expires_at) <= new Date()) {
            return res.status(400).json({
                message: "Invalid or expired verification code"
            });
        }

        if (live.attempt_count >= MAX_VERIFY_ATTEMPTS) {
            return res.status(429).json({
                message: "Too many incorrect attempts. Please request a new code."
            });
        }

        // Rows written before the hash existed still carry a plaintext `otp`.
        // Accepting those keeps any code sent just before this deploy working;
        // nothing new is ever written to that column.
        const matches = live.otp_hash
            ? otpMatches(cleanOtp, live.otp_hash)
            : live.otp === cleanOtp;

        if (!matches) {
            const updated = await pool.query(
                `UPDATE otp_codes
                 SET attempt_count = attempt_count + 1
                 WHERE id = $1
                 RETURNING attempt_count`,
                [live.id]
            );

            const remaining = MAX_VERIFY_ATTEMPTS - updated.rows[0].attempt_count;

            if (remaining <= 0) {
                await pool.query(
                    "UPDATE otp_codes SET is_used = TRUE WHERE id = $1",
                    [live.id]
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

        const userResult = await pool.query(
            isPhone
                ? "SELECT * FROM users WHERE phone = $1"
                : "SELECT * FROM users WHERE LOWER(email) = $1",
            [identifier]
        );

        const user = userResult.rows[0];

        if (!user) {
            return res.status(404).json({
                message: "No account found. Please create an account first.",
                error_code: "ACCOUNT_NOT_FOUND"
            });
        }

        // The same rule again, on the way in. The send endpoint already refuses
        // to issue a code to an admin's email, so nothing should reach here —
        // but a code left over from before this rule existed, or a second way
        // into this function added later, would otherwise walk straight past
        // the check. The gate that matters is the one on the door being opened.
        if (user.role === "admin" && !isPhone) {
            return res.status(403).json({
                message: "Admins sign in with their phone number, not their email address.",
                error_code: "ADMIN_PHONE_ONLY"
            });
        }

        if (user.status === "suspended") {
            return res.status(403).json({
                message: "This account has been suspended. Please contact support.",
                error_code: "ACCOUNT_SUSPENDED"
            });
        }

        // A code can only be spent once
        await pool.query(
            "UPDATE otp_codes SET is_used = TRUE WHERE id = $1",
            [live.id]
        );

        // Proving control of the phone or the email verifies that one channel
        const verified = await pool.query(
            isPhone
                ? `UPDATE users SET phone_verified = TRUE, updated_at = NOW()
                   WHERE id = $1 RETURNING *`
                : `UPDATE users SET email_verified = TRUE, updated_at = NOW()
                   WHERE id = $1 RETURNING *`,
            [user.id]
        );

        const fresh = verified.rows[0];

        res.status(200).json({
            message: "Logged in successfully",
            accessToken: issueAccessToken(fresh),
            user: toAuthUser(fresh)
        });

    } catch (error) {
        console.error(`Error in verifyLoginCode (${type}):`, error);
        res.status(500).json({ message: "Something went wrong while verifying the code" });
    }
};

// POST /api/v1/auth/send-otp          { phone }
const sendOtp = (req, res) => sendLoginCode(req, res, "phone");

// POST /api/v1/auth/verify-otp        { phone, otp }
const verifyOtp = (req, res) => verifyLoginCode(req, res, "phone");

// POST /api/v1/auth/send-email-otp    { email }
const sendEmailOtp = (req, res) => sendLoginCode(req, res, "email");

// POST /api/v1/auth/verify-email-otp  { email, otp }
const verifyEmailOtp = (req, res) => verifyLoginCode(req, res, "email");

module.exports = { sendOtp, verifyOtp, sendEmailOtp, verifyEmailOtp };