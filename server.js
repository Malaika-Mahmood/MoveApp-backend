require("dotenv").config();
const express = require("express");
const cors = require("cors");
const pool = require("./config/db");

const authRoutes = require("./routes/authRoutes");
const driverRoutes = require("./routes/driverRoutes");
const operatorProfileRoutes = require("./routes/operatorProfileRoutes");
const operatorRoutes = require("./routes/operatorRoutes");
const adminRoutes = require("./routes/adminRoutes");
const documentRoutes = require("./routes/documentRoutes");
const vehicleRoutes = require("./routes/vehicleRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const cronRoutes = require("./routes/cronRoutes");
const bookingRoutes = require("./routes/bookingRoutes");
const vehicleClassRoutes = require("./routes/vehicleClassRoutes");
const favouriteRoutes = require("./routes/favouriteRoutes");
const ratingRoutes = require("./routes/ratingRoutes");

const app = express();

// Needed for req.ip to be the real client behind Vercel's proxy, which the
// rate limiter keys on. Without it every request looks like one IP.
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json());

app.use("/api/v1/auth", authRoutes);

// Drivers
app.use("/api/v1/drivers", driverRoutes);
app.use("/api/v1/vehicles", vehicleRoutes);

// Operators
//   /operators  — the operator's own onboarding, reviewed by an admin
//   /operator   — the work an approved operator does on drivers
app.use("/api/v1/operators", operatorProfileRoutes);

// Bookings, mounted BEFORE "/api/v1/operator".
//
// Express tries routers in the order they are added. Mounted the other way
// round, every request to /operator/bookings would run operatorRoutes' three
// gates first, find no matching path, and only then fall through to here —
// authenticating twice and making the 404 for a typo come from the wrong
// router. Specific before general.
app.use("/api/v1/operator/bookings", bookingRoutes);

// Favourites — the star on the assignment screen. Mounted before
// "/api/v1/operator" for exactly the same reason as bookings above.
app.use("/api/v1/operator/favourite-drivers", favouriteRoutes);

app.use("/api/v1/operator", operatorRoutes);

// Admins
app.use("/api/v1/admin", adminRoutes);

// Files
app.use("/api/v1/documents", documentRoutes);

// The bell icon — every role uses the same three endpoints
app.use("/api/v1/notifications", notificationRoutes);

// Vehicle classes — a lookup table every role reads
app.use("/api/v1/vehicle-classes", vehicleClassRoutes);

// Ratings — one router for both directions. An operator rating a driver and a
// driver rating an operator are the same operation with the sides swapped, so
// they share endpoints rather than being duplicated under /operator and
// /drivers/me. Every role is let in; each endpoint decides what its caller
// may see.
app.use("/api/v1/ratings", ratingRoutes);


// Scheduled jobs.
//
// Deliberately NOT behind authenticate/authorize: a scheduler has no login and
// cannot obtain a JWT. It carries CRON_SECRET instead, which the route checks
// itself. Nothing else is mounted here — one job, one secret, no surface.
app.use("/api/v1/cron", cronRoutes);

// NOTE: app.use("/uploads", express.static("uploads")) has been REMOVED.
// It made every passport, licence and National Insurance document downloadable
// by anyone who guessed a filename. Files now go through
// GET /api/v1/documents/..., which checks who is asking.

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
