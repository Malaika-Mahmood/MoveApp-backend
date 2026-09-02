const express = require("express");
const router = express.Router();

const { getMe, updatePersonalInfo, updateDriverType } = require("../controllers/driverController");
const { uploadDocument, getMyDocuments, getMyDocumentsPdf } = require("../controllers/documentController");
const authenticate = require("../middleware/authenticate");
const uploadFile = require("../middleware/uploadFile");

// Everything here is about "the driver who is logged in". The id always comes
// from the token, never from the URL or body — that is what stops one driver
// reading or editing another driver's records.

// Profile
router.get("/me", authenticate, getMe);
router.patch("/me/personal", authenticate, updatePersonalInfo);
router.patch("/me/type", authenticate, updateDriverType);

// Documents
router.post("/me/documents", authenticate, uploadFile("file"), uploadDocument);
router.get("/me/documents", authenticate, getMyDocuments);
router.get("/me/documents/pdf", authenticate, getMyDocumentsPdf);

module.exports = router;