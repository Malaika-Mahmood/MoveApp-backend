const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");

const TOKEN_EXPIRY = "7d";

// Google gives the Android app and a web build different client IDs, and the
// token has to be checked against whichever one issued it. Accepting a
// comma-separated list means adding a platform later is an .env change, not a
// code change.
//
// GOOGLE_CLIENT_IDS is preferred; GOOGLE_CLIENT_ID still works so nothing
// breaks for an existing setup.
const getAudience = () => {
    const raw = process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_CLIENT_ID || "";
    const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);

    if (ids.length === 0) {
        throw new Error("GOOGLE_CLIENT_ID (or GOOGLE_CLIENT_IDS) is not set in the environment");
    }

    return ids;
};

const client = new OAuth2Client();

// The same user shape the OTP login endpoints return. Three ways in, one shape
// out — the app has a single login response to handle.
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

// POST /api/v1/auth/google-login
// Body: { idToken }
//
// LOGIN ONLY — this never creates an account.
//
// It used to. The problem is that Google hands over a name and an email and
// nothing else, while a MoveApp account needs a phone number: the operator has
// to be able to reach the driver, and phone OTP is a login route. An account
// created here would have had a NULL phone and no way to fix it, so a driver
// who tapped "Sign in with Google" first would end up in a half-made account
// that could never be completed.
//
// So a driver registers through /auth/register/start and /auth/register/verify,
// which collects the phone number and verifies the email. After that, Google is
// simply a faster way back in.
const googleLogin = async (req, res) => {
    try {
        const { idToken } = req.body;

        if (!idToken) {
            return res.status(400).json({
                message: "idToken is required",
                error_code: "ID_TOKEN_MISSING"
            });
        }

        let payload;

        try {
            const ticket = await client.verifyIdToken({
                idToken,
                audience: getAudience()
            });
            payload = ticket.getPayload();
        } catch (err) {
            // A bad, expired or forged token is the caller's problem, not a
            // server fault — it must not come back as a 500.
            console.error("Google token verification failed:", err.message);
            return res.status(401).json({
                message: "Google sign-in could not be verified. Please try again.",
                error_code: "GOOGLE_TOKEN_INVALID"
            });
        }

        // Google will hand over an address it has not confirmed the person
        // owns. Trusting that would let someone sign in as another driver by
        // putting their address on a fresh Google account.
        if (!payload || !payload.email || payload.email_verified !== true) {
            return res.status(401).json({
                message: "This Google account does not have a verified email address.",
                error_code: "GOOGLE_EMAIL_UNVERIFIED"
            });
        }

        const email = String(payload.email).trim().toLowerCase();

        // LOWER(email) everywhere, because the unique index in the database is
        // on LOWER(email). Matching on the raw string would miss an account
        // stored as Faris@gmail.com and then fail on the unique index.
        const result = await pool.query(
            "SELECT * FROM users WHERE LOWER(email) = $1",
            [email]
        );

        const user = result.rows[0];

        if (!user) {
            return res.status(404).json({
                message: "No MoveApp account uses this Google address. Please create an account first.",
                error_code: "ACCOUNT_NOT_FOUND"
            });
        }

        // Admins sign in by phone only — the same rule as the email OTP route.
        // Without this, closing the email door would have left this one open,
        // and an admin's Gmail is exactly the account an attacker would go for.
        if (user.role === "admin") {
            return res.status(403).json({
                message: "Admins sign in with their phone number, not with Google.",
                error_code: "ADMIN_PHONE_ONLY"
            });
        }

        if (user.status === "suspended") {
            return res.status(403).json({
                message: "This account has been suspended. Please contact support.",
                error_code: "ACCOUNT_SUSPENDED"
            });
        }

        // Google has confirmed the person controls this address, which is the
        // same thing the email OTP proves.
        const updated = await pool.query(
            `UPDATE users
             SET email_verified = TRUE, updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [user.id]
        );

        const fresh = updated.rows[0];

        if (!process.env.JWT_SECRET) {
            throw new Error("JWT_SECRET is not set in the environment");
        }

        const accessToken = jwt.sign(
            { id: fresh.id, role: fresh.role },
            process.env.JWT_SECRET,
            { expiresIn: TOKEN_EXPIRY }
        );

        res.status(200).json({
            message: "Logged in successfully",
            accessToken,
            user: toAuthUser(fresh)
        });

    } catch (error) {
        console.error("Error in googleLogin:", error);
        res.status(500).json({ message: "Something went wrong during Google login" });
    }
};

module.exports = { googleLogin };