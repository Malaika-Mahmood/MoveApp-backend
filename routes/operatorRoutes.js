const express = require("express");
const { getDriverDocumentsPdfForOperator } = require("../controllers/documentController");
const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const router = express.Router();
const {
    getPendingDrivers,
    verifyDocument,
    getAvailableVehicles,
    assignVehicle,
    unassignVehicle
} = require("../controllers/operatorController");

router.get("/drivers/pending", getPendingDrivers);
router.patch("/documents/:documentId/verify", verifyDocument);
router.get("/drivers/:id/documents/pdf", authenticate, authorize("operator"), getDriverDocumentsPdfForOperator);
router.get("/vehicles/available", getAvailableVehicles);
router.post("/drivers/:id/assign-vehicle", assignVehicle);
router.post("/drivers/:id/unassign-vehicle", unassignVehicle);

module.exports = router;