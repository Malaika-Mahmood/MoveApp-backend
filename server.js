require("dotenv").config();
const express = require("express");
const cors = require("cors");
const pool = require("./config/db");
const authRoutes = require("./routes/authRoutes");
const driverRoutes = require("./routes/driverRoutes");
const operatorRoutes = require("./routes/operatorRoutes");
const vehicleRoutes = require("./routes/vehicleRoutes");
const app = express();

// Needed for req.ip to be the real client behind Vercel's proxy, which the
// rate limiter keys on. Without it every request looks like one IP.
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json());

app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/drivers", driverRoutes);
app.use("/uploads", express.static("uploads"));
app.use("/api/v1/operator", operatorRoutes);
app.use("/api/v1/vehicles", vehicleRoutes);

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

// Vercel runs this file as a serverless function rather than a long-running
// server, so it needs the app exported. Locally the listen() above is what runs.
module.exports = app;