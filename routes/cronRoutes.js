const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const { runExpiryCheck } = require("../services/documentExpiry");

// Mounted at /api/v1/cron
//
// The same expiry check that POST /api/v1/admin/jobs/expiry runs, but reachable
// by a machine instead of a person.
//
// Why a separate route at all: a scheduler has no login. It cannot obtain a JWT,
// so it cannot pass through authenticate/authorize the way an admin does. It
// carries one shared secret instead, and that is the only thing this route
// accepts. Everything else about it is deliberately narrow — one job, no
// parameters that can suspend anybody by accident.
//
// Vercel Cron sends a GET with "Authorization: Bearer <CRON_SECRET>", so that is
// the shape supported here. A local scheduler (Windows Task Scheduler, crontab)
// can send the same header with curl, or just run scripts/checkExpiries.js.

// Compare in constant time.
//
// A plain !== leaks the answer through how long it takes: a secret whose first
// character is wrong fails faster than one that matches ten characters. Over
// enough attempts that difference is enough to guess the secret one character
// at a time. timingSafeEqual always takes the same time.
const secretMatches = (given, expected) => {
    if (!given || !expected) return false;

    const a = Buffer.from(String(given));
    const b = Buffer.from(String(expected));

    // timingSafeEqual throws on different lengths, which would itself be a leak,
    // so the lengths are compared first and the result folded in at the end.
    if (a.length !== b.length) return false;

    return crypto.timingSafeEqual(a, b);
};

const authoriseCron = (req, res, next) => {
    const expected = process.env.CRON_SECRET;

    // No secret configured means the route is off, not open. A deployment that
    // forgets the variable must not end up with an expiry job anyone can fire.
    if (!expected) {
        console.error("CRON_SECRET is not set — the cron route is disabled");
        return res.status(503).json({
            message: "Scheduled jobs are not configured",
            error_code: "CRON_NOT_CONFIGURED"
        });
    }

    const header = req.headers.authorization || "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!secretMatches(given, expected)) {
        // 401 with nothing useful in it. A scheduler does not need an
        // explanation and an attacker should not get one.
        return res.status(401).json({
            message: "Unauthorised",
            error_code: "UNAUTHORISED"
        });
    }

    next();
};

// GET /api/v1/cron/expiry
//
// GET rather than POST because that is what Vercel Cron sends. It is not a
// read-only endpoint, which is untidy, but the alternative is a scheduler that
// cannot call it at all.
router.get("/expiry", authoriseCron, async (req, res) => {
    const startedAt = Date.now();

    try {
        const dryRun = req.query.dry_run === "true";
        const summary = await runExpiryCheck({ dryRun });

        // Logged as well as returned. Nobody reads a cron's HTTP response; the
        // log is where you look when a driver asks why they were suspended.
        console.log(
            `[cron] expiry check ${dryRun ? "(dry run) " : ""}— ` +
            `checked ${summary.checked}, ` +
            `warned ${summary.warnings_sent}, ` +
            `suspended ${summary.drivers_suspended}, ` +
            `${Date.now() - startedAt}ms`
        );

        res.status(200).json({
            message: "Expiry check complete",
            dry_run: dryRun,
            ran_at: new Date().toISOString(),
            duration_ms: Date.now() - startedAt,
            ...summary
        });

    } catch (error) {
        console.error("[cron] expiry check FAILED:", error);
        res.status(500).json({ message: "The expiry check failed" });
    }
});

module.exports = router;