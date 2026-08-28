const express = require("express");
const router = express.Router();
const { createAccount } = require("../controllers/authController");
const { uploadDocument, getDriverDocuments, updateDriverDetails } = require("../controllers/documentController");
const { sendOtp, verifyOtp, sendEmailOtp, verifyEmailOtp } = require("../controllers/otpController");
const { googleLogin } = require("../controllers/googleAuthController");
const upload = require("../config/multerConfig");

router.post("/create-account", createAccount);
router.post("/google-login", googleLogin);

router.post("/drivers/:id/documents", upload.single("file"), uploadDocument);
router.get("/drivers/:id/documents", getDriverDocuments);
router.patch("/drivers/:id/details", updateDriverDetails);

// Phone login
router.post("/send-otp", sendOtp);
router.post("/verify-otp", verifyOtp);

// Email login
router.post("/send-email-otp", sendEmailOtp);
router.post("/verify-email-otp", verifyEmailOtp);

module.exports = router;