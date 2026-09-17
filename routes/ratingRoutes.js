const express = require("express");
const router = express.Router();

const {
    rateBooking,
    getBookingRatings,
    getMyRatings,
    getDriverRatings
} = require("../controllers/ratingController");

const authenticate = require("../middleware/authenticate");

// Mounted at /api/v1/ratings
//
// One router for both directions rather than one under /operator and another
// under /drivers/me. The token says which side you are on; the service works
// out who you are rating. Two copies of that logic with the sides swapped is
// two places for the same bug to live.
//
// No authorize() here. Operators, drivers and admins all reach these, and each
// endpoint decides for itself what its caller may see — which it has to do
// anyway, since "is this your booking?" is not a question about roles.
router.use(authenticate);

// Fixed segments before parameterised ones, as everywhere else in the project.
router.get("/me", getMyRatings);

router.get("/drivers/:id", getDriverRatings);

router.post("/bookings/:id", rateBooking);
router.get("/bookings/:id", getBookingRatings);

module.exports = router;
