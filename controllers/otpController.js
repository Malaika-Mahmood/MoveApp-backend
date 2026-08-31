const pool = require("../config/db");
const jwt = require("jsonwebtoken");

// ---------- PHONE OTP ----------

const sendOtp = async (req, res) => {
    try {
        const { phone } = req.body;

        if (!phone) {
            return res.status(400).json({ message: "Phone number is required" });
        }

        const cleanPhone = String(phone).trim();

        const userCheck = await pool.query("SELECT id FROM users WHERE phone = $1", [cleanPhone]);
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ message: "No account found with this phone number" });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // Timezone issue fix: Postgres ka native interval use kar rahe hain
        await pool.query(
            `INSERT INTO otp_codes (identifier, otp, expires_at, otp_type) 
             VALUES ($1, $2, NOW() + INTERVAL '5 minutes', 'phone')`,
            [cleanPhone, otp]
        );

        console.log(`OTP for ${cleanPhone}: ${otp}`);

        res.status(200).json({
            message: "OTP sent successfully",
            dev_otp: otp
        });

    } catch (error) {
        console.error("Error in sendOtp:", error);
        res.status(500).json({ message: "Something went wrong while sending OTP" });
    }
};

const verifyOtp = async (req, res) => {
    try {
        const { phone, otp } = req.body;

        if (!phone || !otp) {
            return res.status(400).json({ message: "Phone and OTP are required" });
        }

        const cleanPhone = String(phone).trim();
        const cleanOtp = String(otp).trim();

        const otpRecord = await pool.query(
            `SELECT * FROM otp_codes
             WHERE identifier = $1 AND otp = $2 AND otp_type = 'phone' AND is_used = FALSE AND expires_at > NOW()
             ORDER BY created_at DESC LIMIT 1`,
            [cleanPhone, cleanOtp]
        );

        if (otpRecord.rows.length === 0) {
            return res.status(400).json({ message: "Invalid or expired OTP" });
        }

        await pool.query("UPDATE otp_codes SET is_used = TRUE WHERE id = $1", [otpRecord.rows[0].id]);

        const userResult = await pool.query(
            "SELECT * FROM users WHERE phone = $1",
            [cleanPhone]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }

        const user = userResult.rows[0];
        delete user.password_hash;

        const accessToken = jwt.sign(
            { id: user.id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.status(200).json({ message: "Login successful", accessToken, user });

    } catch (error) {
        console.error("Error in verifyOtp:", error);
        res.status(500).json({ message: "Something went wrong while verifying OTP" });
    }
};
// ---------- EMAIL OTP ----------

const sendEmailOtp = async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ message: "Email is required" });
        }

        const cleanEmail = String(email).trim().toLowerCase();

        const userCheck = await pool.query(
            "SELECT id FROM users WHERE LOWER(email) = $1",
            [cleanEmail]
        );

        if (userCheck.rows.length === 0) {
            return res.status(404).json({ message: "No account found with this email" });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // Timezone issue fix: NOW() + INTERVAL '5 minutes'
        await pool.query(
            `INSERT INTO otp_codes (identifier, otp, expires_at, otp_type) 
             VALUES ($1, $2, NOW() + INTERVAL '5 minutes', 'email')`,
            [cleanEmail, otp]
        );

        console.log(`Email OTP for ${cleanEmail}: ${otp}`);

        res.status(200).json({
            message: "OTP sent successfully",
            dev_otp: otp
        });

    } catch (error) {
        console.error("Error in sendEmailOtp:", error);
        res.status(500).json({ message: "Something went wrong while sending OTP" });
    }
};

const verifyEmailOtp = async (req, res) => {
    try {
        const { email, otp } = req.body;

        if (!email || !otp) {
            return res.status(400).json({ message: "Email and OTP are required" });
        }

        const cleanEmail = String(email).trim().toLowerCase();
        const cleanOtp = String(otp).trim();

        const otpRecord = await pool.query(
            `SELECT * FROM otp_codes
             WHERE LOWER(identifier) = $1 AND otp = $2 AND otp_type = 'email' AND is_used = FALSE AND expires_at > NOW()
             ORDER BY created_at DESC LIMIT 1`,
            [cleanEmail, cleanOtp]
        );

        if (otpRecord.rows.length === 0) {
            return res.status(400).json({ message: "Invalid or expired OTP" });
        }

        // Mark OTP as used
        await pool.query("UPDATE otp_codes SET is_used = TRUE WHERE id = $1", [otpRecord.rows[0].id]);

        // Query modified to fetch all user fields safely
        const userResult = await pool.query(
            "SELECT * FROM users WHERE LOWER(email) = $1",
            [cleanEmail]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }

        const user = userResult.rows[0];

        // Sensitive information exclude kar ke token generate karna
        delete user.password_hash;

        const accessToken = jwt.sign(
            { id: user.id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.status(200).json({
            message: "Login successful",
            accessToken,
            user
        });

    } catch (error) {
        console.error("Error in verifyEmailOtp:", error);
        res.status(500).json({ message: "Something went wrong while verifying OTP" });
    }
};
module.exports = { sendOtp, verifyOtp, sendEmailOtp, verifyEmailOtp };