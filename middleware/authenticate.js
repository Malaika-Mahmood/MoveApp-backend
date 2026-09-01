const jwt = require("jsonwebtoken");
const pool = require("../config/db");

// Reads the Bearer token, verifies it, loads the user, and attaches req.user.
//
// The user is loaded from the database on every request rather than trusted
// from the token, because role and status change: a driver approved after their
// token was issued, or an operator suspended, must take effect immediately.
// The token only ever supplies the id.
const authenticate = async (req, res, next) => {
    try {
        const header = req.headers.authorization || "";

        if (!header.startsWith("Bearer ")) {
            return res.status(401).json({
                message: "Authentication required",
                error_code: "AUTH_REQUIRED"
            });
        }

        const token = header.slice(7).trim();

        if (!process.env.JWT_SECRET) {
            console.error("JWT_SECRET is not set in the environment");
            return res.status(500).json({ message: "Server configuration error" });
        }

        let payload;
        try {
            payload = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            // Two different codes on purpose: the frontend should refresh
            // silently on TOKEN_EXPIRED, but send the user back to the login
            // screen on TOKEN_INVALID.
            const expired = err.name === "TokenExpiredError";
            return res.status(401).json({
                message: expired ? "Session expired, please log in again" : "Invalid token",
                error_code: expired ? "TOKEN_EXPIRED" : "TOKEN_INVALID"
            });
        }

        const result = await pool.query(
            `SELECT id, title, first_name, middle_name, last_name, email, phone,
                    role, status, email_verified, phone_verified,
                    ni_number, postcode, address, driver_type, driver_type_confirmed,
                    created_at
             FROM users
             WHERE id = $1`,
            [payload.id]
        );

        const user = result.rows[0];

        if (!user) {
            // Token is valid but the account is gone
            return res.status(401).json({
                message: "Account no longer exists",
                error_code: "USER_NOT_FOUND"
            });
        }

        if (user.status === "suspended") {
            return res.status(403).json({
                message: "This account has been suspended. Please contact the operator.",
                error_code: "ACCOUNT_SUSPENDED"
            });
        }

        req.user = user;
        next();

    } catch (error) {
        console.error("Error in authenticate:", error);
        res.status(500).json({ message: "Something went wrong while authenticating" });
    }
};

module.exports = authenticate;