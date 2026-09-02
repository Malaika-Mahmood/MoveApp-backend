const express = require("express");
const router = express.Router();

const { getDocumentFile } = require("../controllers/documentController");
const { getVehicleDocumentFile } = require("../controllers/vehicleController");
const authenticate = require("../middleware/authenticate");

// Files are served through here instead of a public /uploads folder. Each
// request checks who is asking: the owning driver, or an operator. Nobody
// else, and never by guessing a filename.
//
// When cloud storage arrives these can return a short-lived signed URL
// instead of streaming — the paths stay the same, so the app is unaffected.

router.get("/vehicle/:id/file", authenticate, getVehicleDocumentFile);
router.get("/:id/file", authenticate, getDocumentFile);

module.exports = router;