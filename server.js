require("dotenv").config();
const express = require("express");
const cors = require("cors");
const pool = require("./config/db");
const authRoutes = require("./routes/authRoutes");
const operatorRoutes = require("./routes/operatorRoutes");
const app = express();

app.use(cors());
app.use(express.json());
app.use("/api/v1/auth", authRoutes);
app.use("/uploads", express.static("uploads"));
app.use("/api/v1/operator", operatorRoutes);

app.get("/", (req, res) => {
    res.json({
        message: "MoveApp backend is running!"
    });
});

// Test PostgreSQL
app.get("/test-db", async (req, res) => {
    try {
        const result = await pool.query("SELECT NOW()");

        res.json({
            message: "PostgreSQL connected successfully!",
            time: result.rows[0].now
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Database connection failed"
        });
    }
});

const PORT = process.env.PORT || 5000;


app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});