const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const googleLogin = async (req, res) => {
    try {
        const { idToken, role } = req.body;

        if (!idToken) {
            return res.status(400).json({ message: "idToken is required" });
        }

        // 1. Verify the token with Google's servers
        const ticket = await client.verifyIdToken({
            idToken: idToken,
            audience: process.env.GOOGLE_CLIENT_ID
        });
        const payload = ticket.getPayload();
        const { email, name } = payload;

        // 2. Check if a user with this email already exists
        let userResult = await pool.query(
            "SELECT * FROM users WHERE email = $1",
            [email]
        );

        let user;

        if (userResult.rows.length > 0) {
            user = userResult.rows[0];
        } else {
            if (!role || !["driver", "operator"].includes(role)) {
                return res.status(400).json({
                    message: "role ('driver' or 'operator') is required for first-time Google sign-up"
                });
            }

            const newUser = await pool.query(
                `INSERT INTO users (full_name, email, phone, password, role, status)
                 VALUES ($1, $2, $3, NULL, $4, 'account_created')
                 RETURNING *`,
                [name, email, null, role]
            );
            user = newUser.rows[0];
        }

        const accessToken = jwt.sign(
            { id: user.id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.status(200).json({
            message: "Google login successful",
            accessToken,
            user: {
                id: user.id,
                full_name: user.full_name,
                email: user.email,
                phone: user.phone,
                role: user.role,
                status: user.status
            }
        });

    } catch (error) {
        console.error("Error in googleLogin:", error);
        res.status(500).json({ message: "Something went wrong during Google login" });
    }
};

module.exports = { googleLogin };