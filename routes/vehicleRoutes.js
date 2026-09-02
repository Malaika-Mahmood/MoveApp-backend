const express = require("express");
const router = express.Router();

const {
    addVehicle,
    getMyVehicles,
    uploadVehicleDocument,
    getVehicleDocuments
} = require("../controllers/vehicleController");
const authenticate = require("../middleware/authenticate");
const uploadFile = require("../middleware/uploadFile");

// The driver comes from the token. The old GET /vehicles/drivers/:id is gone —
// it let anyone list any driver's vehicles by changing a number in the URL.

router.post("/", authenticate, addVehicle);
router.get("/me", authenticate, getMyVehicles);

router.post("/:id/documents", authenticate, uploadFile("file"), uploadVehicleDocument);
router.get("/:id/documents", authenticate, getVehicleDocuments);

module.exports = router;