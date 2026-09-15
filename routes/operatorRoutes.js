const express = require("express");
const router = express.Router();

const {
    getPendingDrivers,
    getDriverDetail,
    lookupDriverByShareCode,
    getSharedDriverDocuments,
    verifyDriverDocument,
    verifyVehicleDocument,
    updateDriverDetails,
    updateVehicleDetails,
    setDriverSuspension
} = require("../controllers/operatorController");
const { getDriverDocumentsPdfForOperator } = require("../controllers/documentController");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const requireApprovedOperator = require("../middleware/requireApprovedOperator");

// Mounted at /api/v1/operator — the work an operator does ON DRIVERS.
//
// Three gates, in order:
//   authenticate            is anyone logged in?
//   authorize("operator")   are they an operator?
//   requireApprovedOperator has an admin verified them?
//
// That third gate is what replaced the company-email restriction. An operator
// can register with any email now, but until an admin approves their own
// documents they cannot touch a single driver.
router.use(authenticate, authorize("operator"), requireApprovedOperator);

// Share code
//
// Declared above "/drivers/:id" because these are a different kind of access
// altogether: the queue is drivers this operator is responsible for, this is a
// driver who walked up and showed a code.
router.post("/driver-lookup", lookupDriverByShareCode);
router.get("/shared-drivers/:id/documents", getSharedDriverDocuments);

// Queue
router.get("/drivers/pending", getPendingDrivers);
router.get("/drivers/:id", getDriverDetail);
router.get("/drivers/:id/documents/pdf", getDriverDocumentsPdfForOperator);

// Verification
router.patch("/documents/:documentId/verify", verifyDriverDocument);
router.patch("/vehicle-documents/:documentId/verify", verifyVehicleDocument);

// Details read off the documents
router.patch("/drivers/:id/details", updateDriverDetails);
router.patch("/vehicles/:id/details", updateVehicleDetails);

// Suspension
router.patch("/drivers/:id/suspend", setDriverSuspension);

module.exports = router;