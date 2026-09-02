require("dotenv").config();
const express = require("express");
const cors = require("cors");
const pool = require("./config/db");
const authRoutes = require("./routes/authRoutes");
const driverRoutes = require("./routes/driverRoutes");
const documentRoutes = require("./routes/documentRoutes");
const operatorRoutes = require("./routes/operatorRoutes");
const vehicleRoutes = require("./routes/vehicleRoutes");
const app = express();

// Needed for req.ip to be the real client behind Vercel's proxy, which the
// rate limiter keys on. Without it every request looks like one IP.
app.set("trust proxy", 1);

app.use(cors());
app.use((req, res, next) => { console.log("→", req.method, req.originalUrl); next(); });
app.use(express.json());

app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/drivers", driverRoutes);
app.use("/api/v1/documents", documentRoutes);
app.use("/api/v1/operator", operatorRoutes);
app.use("/api/v1/vehicles", vehicleRoutes);

// NOTE: app.use("/uploads", express.static("uploads")) has been REMOVED.
// It made every passport, licence and National Insurance document downloadable
// by anyone who guessed a filename. Files now go through
// GET /api/v1/documents/:id/file, which checks who is asking.

app.get("/", (req, res) => {
    res.json({
        message: "MoveApp backend is running!"
    });
});

app.get("/test-db", async (req, res) => {
    try {
        const result = await pool.query("SELECT NOW()");
        res.json({
            message: "PostgreSQL connected successfully!",
            time: result.rows[0].now
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Database connection failed" });
    }
});

// Unknown routes return JSON, not Express's HTML page
app.use((req, res) => {
    res.status(404).json({
        message: `Route not found: ${req.method} ${req.originalUrl}`,
        error_code: "NOT_FOUND"
    });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});

// Vercel runs this file as a serverless function rather than a long-running
// server, so it needs the app exported. Locally the listen() above is what runs.
module.exports = app;