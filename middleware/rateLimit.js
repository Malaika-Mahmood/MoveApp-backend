// MoveApp — lightweight in-memory rate limiter.
//
// No extra dependency, which keeps package.json unchanged for now.
//
// LIMITATION: the counters live in this Node process only. As soon as you run
// more than one instance (PM2 cluster mode, multiple containers, autoscaling),
// each instance keeps its own count and the effective limit multiplies. When
// that happens, swap this for express-rate-limit backed by Redis — the call
// sites in the route files stay exactly the same.
//
// NOTE: this keys on req.ip. If you deploy behind a proxy or load balancer
// (Nginx, Heroku, Render, Cloudflare), add `app.set("trust proxy", 1);` in
// server.js — otherwise every request appears to come from the proxy's IP and
// one user's traffic will rate-limit everybody.

const buckets = new Map();

// Sweep expired buckets every 10 minutes so memory does not grow without bound.
// .unref() lets the process exit normally instead of being held open by this timer.
setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
    }
}, 10 * 60 * 1000).unref();

const rateLimit = ({ windowMs, max, message }) => (req, res, next) => {
    const key = `${req.method}:${req.baseUrl}${req.path}:${req.ip}`;
    const now = Date.now();

    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > max) {
        const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
        res.set("Retry-After", String(retryAfter));
        return res.status(429).json({
            message: message || "Too many requests. Please try again later.",
            retry_after_seconds: retryAfter
        });
    }

    next();
};

module.exports = rateLimit;