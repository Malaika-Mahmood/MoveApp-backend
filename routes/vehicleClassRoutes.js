const express = require("express");
const router = express.Router();

const { listVehicleClasses } = require("../controllers/bookingController");
const authenticate = require("../middleware/authenticate");

// Mounted at /api/v1/vehicle-classes
//
// Not behind a role. An operator needs the list to choose one when taking a
// booking, a driver needs it to say what their car is, and both apps need it
// to put a name next to a code. It is a lookup table, not a secret.
//
// authenticate is still there because nothing in this API answers to a
// stranger — even a harmless list tells you the product exists and what it
// sells.
router.get("/", authenticate, listVehicleClasses);

module.exports = router;