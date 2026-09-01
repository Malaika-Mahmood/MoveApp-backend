const express = require("express");
const router = express.Router();

const { getMe, updatePersonalInfo, updateDriverType } = require("../controllers/driverController");
const authenticate = require("../middleware/authenticate");

// Every route here is about "the driver who is logged in", so the id always
// comes from the token — never from the URL or the request body. That is what
// stops one driver reading or editing another driver's profile.
router.get("/me", authenticate, getMe);
router.patch("/me/personal", authenticate, updatePersonalInfo);
router.patch("/me/type", authenticate, updateDriverType);

module.exports = router;