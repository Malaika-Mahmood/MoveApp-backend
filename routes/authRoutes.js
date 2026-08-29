const express = require("express");
const router = express.Router();

const {
    registerStart,
    registerVerify,
    registerResend,
    createAccount
} = require("../controllers/authController");
const { uploadDocument, getDriverDocuments, updateDriverDetails } = require("../controllers/documentController");
const { sendOtp, verifyOtp, sendEmailOtp, verifyEmailOtp } = require("../controllers/otpController");
const { googleLogin } = require("../controllers/googleAuthController");
const upload = require("../config/multerConfig");
const rateLimit = require("../middleware/rateLimit");

// Sending a code costs an email (and later, money per SMS), so throttle it
// harder than verifying one.
const sendCodeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: "Too many verification codes requested. Please try again later."
});

const verifyCodeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: "Too many verification attempts. Please try again later."
});

// ---------- Driver registration (email OTP verified) ----------
router.post("/register/start", sendCodeLimiter, registerStart);
router.post("/register/verify", verifyCodeLimiter, registerVerify);
router.post("/register/resend", sendCodeLimiter, registerResend);

// Deprecated — responds 410 pointing at the two-step flow above
router.post("/create-account", createAccount);

router.post("/google-login", googleLogin);

// ---------- Driver documents / details ----------
// NOTE: these still have no authentication. That lands in Step 3.
router.post("/drivers/:id/documents", upload.single("file"), uploadDocument);
router.get("/drivers/:id/documents", getDriverDocuments);
router.patch("/drivers/:id/details", updateDriverDetails);

// ---------- Phone login (hardening comes in Step 2) ----------
router.post("/send-otp", sendOtp);
router.post("/verify-otp", verifyOtp);

// ---------- Email login (hardening comes in Step 2) ----------
router.post("/send-email-otp", sendEmailOtp);
router.post("/verify-email-otp", verifyEmailOtp);

module.exports = router;