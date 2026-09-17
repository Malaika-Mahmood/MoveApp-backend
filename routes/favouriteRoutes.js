const express = require("express");
const router = express.Router();

const {
    listFavourites,
    addFavourite,
    removeFavourite
} = require("../controllers/favouriteController");

const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const requireApprovedOperator = require("../middleware/requireApprovedOperator");

// Mounted at /api/v1/operator/favourite-drivers
//
// IMPORTANT: in server.js this must be mounted BEFORE /api/v1/operator, the
// same way /api/v1/operator/bookings is. Express takes the first prefix that
// matches, so the general mount above the specific one would swallow these.
//
// The same three gates as the rest of the operator's work.
router.use(authenticate, authorize("operator"), requireApprovedOperator);

router.get("/", listFavourites);
router.post("/", addFavourite);
router.delete("/:driverId", removeFavourite);

module.exports = router;
