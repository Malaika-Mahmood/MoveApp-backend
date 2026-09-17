const pool = require("../config/db");
const ratings = require("../services/ratings");
const { notifyRatingReceived } = require("../services/appNotifications");
const { RATING_REASONS, RATING_REASON_LABELS } = require("../constants/bookings");

// Ratings — both directions through one set of endpoints.
//
// The plan said two separate routes, one under /operator and one under
// /drivers/me. Building it that way meant two controllers doing the same work
// with the sides swapped, and two places to fix every future bug. So there is
// one: the token says which side you are on, and the service works out who you
// are rating. Asima has one endpoint to call instead of two, which is also
// simpler at her end.
//
// Mounted at /api/v1/ratings.

// -----------------------------------------------------------------------------
// POST /api/v1/ratings/bookings/:id
// -----------------------------------------------------------------------------
// { "score": 4, "reasons": ["dress_code"], "comment": "Arrived in jeans" }
//
// Who is rated is NOT in the body. An operator rates that booking's driver, a
// driver rates that booking's operator, and there is no request shape that can
// point somewhere else.
const rateBooking = async (req, res) => {
    try {
        const { id } = req.params;

        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid booking id" });
        }

        // Admins are turned away here rather than in the service, so the
        // message is a sentence rather than an error code. An admin watching a
        // job is not a party to it.
        if (req.user.role !== "operator" && req.user.role !== "driver") {
            return res.status(403).json({
                message: "Only the operator and the driver on a job can rate it",
                error_code: "NOT_A_PARTY"
            });
        }

        const { errors, value } = ratings.validateRating(req.body || {}, req.user.role);

        if (errors.length > 0) {
            return res.status(400).json({
                message: "Please check the rating",
                error_code: "VALIDATION_ERROR",
                errors,
                // What they were allowed to pick, so a wrong reason code is a
                // self-answering error rather than a trip to the docs.
                allowed_reasons: RATING_REASONS[req.user.role]
            });
        }

        const result = await ratings.rateBooking({
            bookingId: Number(id),
            raterId: req.user.id,
            raterRole: req.user.role,
            ...value
        });

        if (result.error) {
            const status =
                result.error === "NOT_FOUND" ? 404
                    : result.error === "NOT_YOURS" || result.error === "NOT_A_PARTY" ? 403
                        : 409;   // ALREADY_RATED, NOT_COMPLETED, TOO_LATE, NO_DRIVER

            return res.status(status).json({
                message: result.message,
                error_code: result.error,
                ...(result.current_status ? { current_status: result.current_status } : {}),
                ...(result.completed_at ? { completed_at: result.completed_at } : {})
            });
        }

        // Not awaited. A notification that fails must not fail the rating —
        // the rating is the record, the notification is a courtesy.
        notifyRatingReceived(
            result.subjectId,
            result.reference,
            value.score,
            value.reasons
        );

        res.status(201).json({
            message: "Thank you — your rating has been recorded",
            rating: {
                id: result.rating.id,
                score: result.rating.score,
                reasons: result.rating.reasons || [],
                comment: result.rating.comment,
                created_at: result.rating.created_at
            }
        });

    } catch (error) {
        console.error("Error in rateBooking:", error);
        res.status(500).json({ message: "Something went wrong while saving the rating" });
    }
};

// -----------------------------------------------------------------------------
// GET /api/v1/ratings/bookings/:id
// -----------------------------------------------------------------------------
// What has been rated on this job, and whether it is this person's turn.
//
// Both sides call it when they open a completed job, so the app knows whether
// to draw the rating form or the rating already given.
const getBookingRatings = async (req, res) => {
    try {
        const { id } = req.params;

        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid booking id" });
        }

        const bookingResult = await pool.query(
            `SELECT id, reference, status, created_by_operator_id, driver_id, completed_at
               FROM bookings WHERE id = $1`,
            [id]
        );

        const booking = bookingResult.rows[0];

        if (!booking) {
            return res.status(404).json({ message: "No booking with that id", error_code: "NOT_FOUND" });
        }

        const isOperator = booking.created_by_operator_id === req.user.id;
        const isDriver = booking.driver_id === req.user.id;
        const isAdmin = req.user.role === "admin";

        if (!isOperator && !isDriver && !isAdmin) {
            return res.status(403).json({
                message: "This is not your booking",
                error_code: "NOT_YOURS"
            });
        }

        const byRole = await ratings.forBooking(Number(id));

        // Their own rating is returned in full; the other side's score is
        // shown too — once a job is over, both parties seeing the same record
        // is fair. What stays hidden everywhere is WHO, and that is handled by
        // there being no name in either object.
        const mine = isOperator ? byRole.operator : isDriver ? byRole.driver : null;
        const theirs = isOperator ? byRole.driver : isDriver ? byRole.operator : null;

        const strip = (rating) => rating && {
            score: rating.score,
            reasons: rating.reasons,
            comment: rating.comment,
            created_at: rating.created_at
        };

        res.status(200).json({
            booking: {
                id: booking.id,
                reference: booking.reference,
                status: booking.status,
                completed_at: booking.completed_at
            },

            // Admin sees both, labelled by side.
            ...(isAdmin
                ? {
                    operator_rating: strip(byRole.operator),
                    driver_rating: strip(byRole.driver)
                }
                : {
                    my_rating: strip(mine),
                    their_rating: strip(theirs),

                    // The single flag the app needs to decide what to draw.
                    can_rate: booking.status === "completed" && !mine,
                    allowed_reasons: RATING_REASONS[req.user.role] || []
                })
        });

    } catch (error) {
        console.error("Error in getBookingRatings:", error);
        res.status(500).json({ message: "Something went wrong" });
    }
};

// -----------------------------------------------------------------------------
// GET /api/v1/ratings/me
// -----------------------------------------------------------------------------
// My own record. The star rating and "847 trips" on the driver's profile
// screen, and the same for an operator.
//
// The raters are not named — see the note in appNotifications.
const getMyRatings = async (req, res) => {
    try {
        const summary = await ratings.summaryFor(req.user.id);

        if (!summary) {
            return res.status(404).json({ message: "User not found" });
        }

        res.status(200).json({
            ...summary,
            ratings: await ratings.listForSubject(req.user.id, { includeRater: false }),
            reason_labels: RATING_REASON_LABELS
        });

    } catch (error) {
        console.error("Error in getMyRatings:", error);
        res.status(500).json({ message: "Something went wrong" });
    }
};

// -----------------------------------------------------------------------------
// GET /api/v1/ratings/drivers/:id
// -----------------------------------------------------------------------------
// The office looking at a driver's record, before deciding whether to offer
// them a job.
//
// Operators and admins only. Here the raters ARE named: this is the office
// reading its own notes, and an operator needs to know whether the two-star
// rating came from a colleague they trust.
const getDriverRatings = async (req, res) => {
    try {
        const { id } = req.params;

        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid driver id" });
        }

        if (req.user.role !== "operator" && req.user.role !== "admin") {
            return res.status(403).json({ message: "Operators only", error_code: "FORBIDDEN" });
        }

        const driver = await pool.query(
            `SELECT id, first_name, last_name, role FROM users WHERE id = $1`,
            [id]
        );

        if (driver.rows.length === 0 || driver.rows[0].role !== "driver") {
            return res.status(404).json({ message: "No driver with that id", error_code: "NOT_FOUND" });
        }

        const summary = await ratings.summaryFor(Number(id));

        res.status(200).json({
            driver: {
                id: driver.rows[0].id,
                full_name: [driver.rows[0].first_name, driver.rows[0].last_name]
                    .filter(Boolean).join(" ")
                // No phone or email. The masking rule does not stop applying
                // because the screen happens to be about ratings.
            },

            ...summary,
            ratings: await ratings.listForSubject(Number(id), { includeRater: true }),
            reason_labels: RATING_REASON_LABELS
        });

    } catch (error) {
        console.error("Error in getDriverRatings:", error);
        res.status(500).json({ message: "Something went wrong" });
    }
};

module.exports = {
    rateBooking,
    getBookingRatings,
    getMyRatings,
    getDriverRatings
};
