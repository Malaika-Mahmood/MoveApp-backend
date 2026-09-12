const express = require("express");
const router = express.Router();

const {
    getOperators,
    getOperatorDetail,
    getOperatorDocumentsPdf,
    getDrivers,
    runDocumentExpiryJob,
    verifyOperatorDocument,
    verifyCouncil,
    setOperatorSuspension,
    listAdmins,
    createAdmin
} = require("../controllers/adminController");
const { getDriverDocumentsPdfForAdmin } = require("../controllers/documentController");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");

// Mounted at /api/v1/admin
//
// Admins verify operators, exactly as operators verify drivers. There is no
// public route that can create an admin — the first one is inserted by hand,
// and after that an admin creates the others.
router.use(authenticate, authorize("admin"));

// Operator queue
//
// The /documents/pdf route is declared BEFORE "/operators/:id" would swallow
// it. Express matches in order, and "/operators/7/documents/pdf" does not hit
// "/operators/:id" anyway (different segment count) — but keeping the more
// specific path first is the habit that stops this class of bug.
router.get("/operators", getOperators);
router.get("/operators/:id/documents/pdf", getOperatorDocumentsPdf);
router.get("/operators/:id", getOperatorDetail);

// Drivers — an admin can see every driver and download any driver's pack
router.get("/drivers", getDrivers);
router.get("/drivers/:id/documents/pdf", getDriverDocumentsPdfForAdmin);

// Verification
router.patch("/operator-documents/:documentId/verify", verifyOperatorDocument);
router.patch("/councils/:councilId/verify", verifyCouncil);

// Suspension
router.patch("/operators/:id/suspend", setOperatorSuspension);

// Jobs — the daily expiry check, on demand or from a Vercel Cron
router.post("/jobs/expiry", runDocumentExpiryJob);

// Admins
router.get("/admins", listAdmins);
router.post("/admins", createAdmin);

module.exports = router;