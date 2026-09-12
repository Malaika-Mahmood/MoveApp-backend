const express = require("express");
const router = express.Router();

const {
    getMyNotifications,
    markAsRead,
    markAllAsRead
} = require("../controllers/notificationController");
const authenticate = require("../middleware/authenticate");

// Mounted at /api/v1/notifications
//
// No authorize() here on purpose — drivers, operators and admins all have a
// bell icon, and a notification already knows whose it is.

router.use(authenticate);

router.get("/", getMyNotifications);

// "/read-all" is declared before "/:id/read" would have a chance to be
// confused with it. They cannot actually collide (different segment counts),
// but keeping the fixed path above the parameterised one is the habit that
// stops the version of this bug that does bite.
router.patch("/read-all", markAllAsRead);
router.patch("/:id/read", markAsRead);

module.exports = router;