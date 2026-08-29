const express = require("express");
const router = express.Router();

router.use((req, res, next) => {
    console.log("🚗 VEHICLE ROUTE HIT:", req.method, req.originalUrl);
    next();
});

const { addVehicle, getDriverVehicles, uploadVehicleDocument, getVehicleDocuments } = require("../controllers/vehicleController");
const upload = require("../config/multerConfig");

router.post("/", addVehicle);
router.get("/drivers/:id", getDriverVehicles);
router.post("/:id/documents", upload.single("file"), uploadVehicleDocument);
router.get("/:id/documents", getVehicleDocuments);

module.exports = router;