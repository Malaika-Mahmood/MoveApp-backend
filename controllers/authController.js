const bcrypt = require("bcrypt");
const pool = require("../config/db");

// CREATE ACCOUNT (Driver or Operator)
const createAccount = async (req, res) => {
    try {
        const { full_name, email, phone, password, role } = req.body;

        // 1. Basic validation
        if (!full_name || !email || !phone || !password || !role) {
            return res.status(400).json({
                message: "All fields are required: full_name, email, phone, password, role"
            });
        }

        if (!["driver", "operator"].includes(role)) {
            return res.status(400).json({
                message: "Role must be either 'driver' or 'operator'"
            });
        }

        // 2. Check if email or phone already exists
        const existingUser = await pool.query(
            "SELECT id FROM users WHERE email = $1 OR phone = $2",
            [email, phone]
        );

        if (existingUser.rows.length > 0) {
            return res.status(409).json({
                message: "An account with this email or phone already exists"
            });
        }

        // 3. Hash the password (never store plain text passwords)
        const hashedPassword = await bcrypt.hash(password, 10);

        // 4. Insert new user into database
        const newUser = await pool.query(
            `INSERT INTO users (full_name, email, phone, password, role, status)
             VALUES ($1, $2, $3, $4, $5, 'account_created')
             RETURNING id, full_name, email, phone, role, status, created_at`,
            [full_name, email, phone, hashedPassword, role]
        );

        // 5. Send response back (never send the password back!)
        res.status(201).json({
            message: "Account created successfully",
            user: newUser.rows[0]
        });

    } catch (error) {
        console.error("Error in createAccount:", error);
        res.status(500).json({
            message: "Something went wrong while creating the account"
        });
    }
};

module.exports = { createAccount };