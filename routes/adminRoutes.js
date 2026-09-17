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

const {
    getDashboard,
    getBookings,
    getBookingDetail,
    getDriverDetail,
    getOperatorsOverview,
    getAccessLog
} = require("../controllers/adminOverviewController");

const { getDriverDocumentsPdfForAdmin } = require("../controllers/documentController");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");

// Mounted at /api/v1/admin
//
// Admins verify operators, exactly as operators verify drivers. There is no
// public route that can create an admin — the first one is inserted by hand,
// and after that an admin creates the others.
//
// Two controllers behind one router. adminController.js is the verification
// queue — approving operators, checking councils, suspending. The new
// adminOverviewController.js is the firm-wide view the CEO asked for on 16
// September: every booking, every record, and who created what. Splitting them
// keeps each file about one subject.
router.use(authenticate, authorize("admin"));

// -----------------------------------------------------------------------------
// The whole operation at a glance
// -----------------------------------------------------------------------------
router.get("/dashboard", getDashboard);

// -----------------------------------------------------------------------------
// Bookings — new. Until now bookings were operator-only and an admin could not
// see them at all.
// -----------------------------------------------------------------------------
router.get("/bookings", getBookings);
router.get("/bookings/:id", getBookingDetail);

// -----------------------------------------------------------------------------
// Operator queue
// -----------------------------------------------------------------------------
// "/operators/overview" MUST come before "/operators/:id". Express matches in
// order, and "overview" would otherwise be read as an id — the handler would
// receive the string "overview" where it expects a number and fail there
// instead of here. Same reasoning as "/documents/pdf" below.
router.get("/operators/overview", getOperatorsOverview);

router.get("/operators", getOperators);
router.get("/operators/:id/documents/pdf", getOperatorDocumentsPdf);
router.get("/operators/:id", getOperatorDetail);

// -----------------------------------------------------------------------------
// Drivers — an admin can see every driver and download any driver's pack
// -----------------------------------------------------------------------------
router.get("/drivers", getDrivers);
router.get("/drivers/:id/documents/pdf", getDriverDocumentsPdfForAdmin);

// The full record behind a name on that list. Declared after the
// /documents/pdf path above, which is the more specific one.
router.get("/drivers/:id", getDriverDetail);

// -----------------------------------------------------------------------------
// Who looked at whom
// -----------------------------------------------------------------------------
// The other half of "an admin sees everything". An admin can read this,
// including their own entries — there is deliberately no way to hide from it.
router.get("/access-log", getAccessLog);

// -----------------------------------------------------------------------------
// Verification
// -----------------------------------------------------------------------------
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