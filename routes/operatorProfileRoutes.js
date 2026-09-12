const express = require("express");
const router = express.Router();

const {
    getMe,
    getMyDocumentsPdf,
    updateProfile,
    uploadDocument,
    addCouncil,
    removeCouncil
} = require("../controllers/operatorProfileController");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const uploadFile = require("../middleware/uploadFile");

// Mounted at /api/v1/operators
//
// NOTE the difference from /api/v1/operator (singular):
//   /api/v1/operators/me   the operator's OWN onboarding — their documents,
//                          their councils, reviewed by an admin
//   /api/v1/operator/...   the work an approved operator does ON DRIVERS
//
// An operator uses these while still unverified, so there is no
// requireApprovedOperator here — that gate belongs on the driver-facing work.

router.use(authenticate, authorize("operator"));

router.get("/me", getMe);
router.patch("/me", updateProfile);

router.post("/me/documents", uploadFile("file"), uploadDocument);

// The operator's own pack, without review status on it
router.get("/me/documents/pdf", getMyDocumentsPdf);

router.post("/me/councils", uploadFile("file"), addCouncil);
router.delete("/me/councils/:id", removeCouncil);

module.exports = router;