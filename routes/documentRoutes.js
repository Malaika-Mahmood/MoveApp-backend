const express = require("express");
const router = express.Router();

const { getDocumentFile } = require("../controllers/documentController");
const { getVehicleDocumentFile } = require("../controllers/vehicleController");
const {
    getOperatorDocumentFile,
    getCouncilFile
} = require("../controllers/operatorProfileController");
const authenticate = require("../middleware/authenticate");

// Files are served through here instead of a public /uploads folder. Each
// request checks who is asking:
//   driver documents  — the owning driver, or an operator
//   vehicle documents — the owning driver, or an operator
//   operator documents— the owning operator, or an admin
//   council licences  — the owning operator, or an admin
//
// When cloud storage arrives these can return a short-lived signed URL
// instead of streaming — the paths stay the same, so the app is unaffected.
//
// The specific prefixes come first; "/:id/file" is the catch-all for driver
// documents and must stay last.

router.get("/vehicle/:id/file", authenticate, getVehicleDocumentFile);
router.get("/operator/:id/file", authenticate, getOperatorDocumentFile);
router.get("/council/:id/file", authenticate, getCouncilFile);
router.get("/:id/file", authenticate, getDocumentFile);

module.exports = router;