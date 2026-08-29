const { Pool } = require("pg");

// SSL handling
// ------------
// Hosted Postgres (Render, Neon, Supabase, RDS...) requires SSL.
// A local Postgres install has SSL switched off by default and will reject the
// connection with "The server does not support SSL connections".
//
// Rules, in order:
//   1. DB_SSL=true  in .env  -> always use SSL
//   2. DB_SSL=false in .env  -> never use SSL
//   3. Not set               -> off for localhost, on for everything else
//
// So local development works with no .env change, and a deployed database
// still gets SSL by default.
const resolveSsl = () => {
    const host = (process.env.DB_HOST || "").toLowerCase();
    const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "";

    if (process.env.DB_SSL === "true") return { rejectUnauthorized: false };
    if (process.env.DB_SSL === "false") return false;

    return isLocal ? false : { rejectUnauthorized: false };
};

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
    ssl: resolveSsl()
});

// Errors on idle clients (network drop, database restart) surface here
pool.on("error", (err) => {
    console.error("Database connection error:", err);
});

// Check the connection at start-up rather than discovering a bad config through
// a 500 on the first real request.
pool.query("SELECT 1")
    .then(() => {
        console.log(
            `PostgreSQL connected (host=${process.env.DB_HOST}, ssl=${resolveSsl() ? "on" : "off"})`
        );
    })
    .catch((err) => {
        console.error("PostgreSQL connection FAILED:", err.message);
        console.error("Check DB_HOST / DB_USER / DB_PASSWORD / DB_NAME / DB_SSL in your .env");
    });

module.exports = pool;