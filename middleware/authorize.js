// Role gate. Always used AFTER authenticate, which is what sets req.user.
//
//   router.get("/drivers/pending", authenticate, authorize("operator"), getPendingDrivers);
//
const authorize = (...allowedRoles) => (req, res, next) => {
    if (!req.user) {
        // authenticate was not applied to this route — a wiring mistake, not a
        // client error, so make it loud rather than silently allowing through.
        console.error("authorize() used without authenticate() on", req.originalUrl);
        return res.status(500).json({ message: "Server configuration error" });
    }

    if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({
            message: "You do not have permission to perform this action",
            error_code: "FORBIDDEN"
        });
    }

    next();
};

module.exports = authorize;