const express = require("express");
const router = express.Router();

const {
    createBooking,
    listBookings,
    getBooking,
    updateBooking,
    cancelBooking
} = require("../controllers/bookingController");

const authenticate = require("../middleware/authenticate");
const authorize = require("../middleware/authorize");
const requireApprovedOperator = require("../middleware/requireApprovedOperator");

// Mounted at /api/v1/operator/bookings
//
// The same three gates as the rest of the operator's work:
//   authenticate            logged in?
//   authorize("operator")   an operator?
//   requireApprovedOperator approved by an admin?
//
// Its own file rather than more lines in operatorRoutes.js, because bookings
// are about to grow — offers, statuses, ratings — and a route file that
// describes one subject is a route file somebody can still read next year.
router.use(authenticate, authorize("operator"), requireApprovedOperator);

router.post("/", createBooking);
router.get("/", listBookings);

// "/:id/cancel" is declared before "/:id" for the habit's sake. They cannot
// actually collide — different segment counts, different methods — but the
// fixed path above the parameterised one is what stops the version of this
// bug that does bite.
router.patch("/:id/cancel", cancelBooking);

router.get("/:id", getBooking);
router.patch("/:id", updateBooking);

module.exports = router;