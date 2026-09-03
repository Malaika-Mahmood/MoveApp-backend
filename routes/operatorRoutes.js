const express = require("express");
const router = express.Router();

const {
    getPendingDrivers,
    getDriverDetail,
    verifyDriverDocument,
    verifyVehicleDocument,
    updateDriverDetails,
    confirmDriverType,
    updateVehicleDetails,
    setDriverSuspension
} = require("../controllers/operatorController");
const { getDriverDocumentsPdfForOperator } = require("../controllers/documentController");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");

// Every route here now requires a logged-in operator.
//
// Until this change these endpoints were completely open: anyone who knew the
// URL could approve their own documents and become a verified driver.
router.use(authenticate, authorize("operator"));

// Queue
router.get("/drivers/pending", getPendingDrivers);
router.get("/drivers/:id", getDriverDetail);
router.get("/drivers/:id/documents/pdf", getDriverDocumentsPdfForOperator);

// Verification
router.patch("/documents/:documentId/verify", verifyDriverDocument);
router.patch("/vehicle-documents/:documentId/verify", verifyVehicleDocument);

// Details read off the documents
router.patch("/drivers/:id/details", updateDriverDetails);
router.patch("/drivers/:id/type", confirmDriverType);
router.patch("/vehicles/:id/details", updateVehicleDetails);

// Suspension
router.patch("/drivers/:id/suspend", setDriverSuspension);

// REMOVED: /vehicles/available, /drivers/:id/assign-vehicle,
// /drivers/:id/unassign-vehicle — operators no longer assign vehicles.
// Drivers own and manage their own; operators only verify them.

module.exports = router;