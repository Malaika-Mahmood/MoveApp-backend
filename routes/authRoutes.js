const express = require("express");
const router = express.Router();

const {
    registerStart,
    registerVerify,
    registerResend,
    createAccount
} = require("../controllers/authController");
const { deprecated } = require("../controllers/documentController");
const { sendOtp, verifyOtp, sendEmailOtp, verifyEmailOtp } = require("../controllers/otpController");
const { googleLogin } = require("../controllers/googleAuthController");
const rateLimit = require("../middleware/rateLimit");

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

router.post("/create-account", createAccount);   // deprecated -> 410

router.post("/google-login", googleLogin);

// ---------- Phone login ----------
router.post("/send-otp", sendOtp);
router.post("/verify-otp", verifyOtp);

// ---------- Email login ----------
router.post("/send-email-otp", sendEmailOtp);
router.post("/verify-email-otp", verifyEmailOtp);

// ---------- Moved ----------
// Driver documents and details used to live under /auth, which was never the
// right place, and they took the driver id from the URL. They are now under
// /api/v1/drivers/me and read the id from the token.
router.post("/drivers/:id/documents", deprecated);
router.get("/drivers/:id/documents", deprecated);
router.patch("/drivers/:id/details", deprecated);

module.exports = router;