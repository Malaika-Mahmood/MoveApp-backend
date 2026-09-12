// An operator may only act on drivers once an admin has verified them.
//
// Without this, anyone could register as an operator and immediately approve
// their own driver documents — which is the hole the company-email restriction
// used to plug. Admin approval is a better guard than an email domain, because
// a person makes the decision.
//
// Always used AFTER authenticate and authorize("operator").
const requireApprovedOperator = (req, res, next) => {
    if (!req.user) {
        console.error("requireApprovedOperator used without authenticate on", req.originalUrl);
        return res.status(500).json({ message: "Server configuration error" });
    }

    if (req.user.status !== "approved") {
        return res.status(403).json({
            message: "Your operator account is still being verified. You cannot review drivers yet.",
            error_code: "OPERATOR_NOT_APPROVED",
            operator_status: req.user.status
        });
    }

    next();
};

module.exports = requireApprovedOperator;