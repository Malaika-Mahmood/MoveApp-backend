const pool = require("../config/db");
const offers = require("../services/bookingOffers");
const {
    toBooking,
    BOOKING_SELECT,
    BOOKING_JOINS,
    vehicleFitsJoined
} = require("../services/bookingValidation");
const { DRIVER_STATUS_STEPS, ALL_FARE_MODES } = require("../constants/bookings");
const {
    notifyOfferAccepted,
    notifyOfferDeclined,
    notifyJobStatusChanged,
    notifyRatingDue,
    notifyBidReceived
} = require("../services/appNotifications");

// Everything the driver's app does with work: go online, see what has been
// offered, take it or turn it down, browse the open pool, and move a job
// along once they have it.
//
// The id always comes from the token, never the URL. A driver can only ever
// see and change their own jobs, and there is no endpoint here that takes a
// driver id at all.

// -----------------------------------------------------------------------------
// PATCH /api/v1/drivers/me/online   { "is_online": true }
// -----------------------------------------------------------------------------
// The Go Online / Offline switch on the home screen. The same fact the
// operator reads as the AVAILABLE badge.
const setOnline = async (req, res) => {
    try {
        if (req.user.role !== "driver") {
            return res.status(403).json({
                message: "Only drivers go online",
                error_code: "FORBIDDEN"
            });
        }

        const { is_online } = req.body || {};

        if (typeof is_online !== "boolean") {
            return res.status(400).json({
                message: "is_online must be true or false",
                error_code: "INVALID_VALUE"
            });
        }

        // A driver locked out by an expired document cannot go online. They can
        // open the app — that is the whole point of the lock, they have to be
        // able to fix it — but they cannot take work until it is fixed.
        if (is_online && req.user.account_locked) {
            return res.status(403).json({
                message: "Upload your replacement document before going online",
                error_code: "ACCOUNT_LOCKED"
            });
        }

        if (is_online && req.user.status !== "approved") {
            return res.status(403).json({
                message: "Your account is not approved for work yet",
                error_code: "NOT_APPROVED"
            });
        }

        await pool.query(
            `UPDATE users
             SET is_online = $2,
                 last_online_at = CASE WHEN $2 THEN NOW() ELSE last_online_at END,
                 updated_at = NOW()
             WHERE id = $1`,
            [req.user.id, is_online]
        );

        res.status(200).json({
            message: is_online ? "You are online" : "You are offline",
            is_online
        });

    } catch (error) {
        console.error("Error in setOnline:", error);
        res.status(500).json({ message: "Something went wrong" });
    }
};

// -----------------------------------------------------------------------------
// GET /api/v1/drivers/me/offers
// -----------------------------------------------------------------------------
const listMyOffers = async (req, res) => {
    try {
        if (req.user.role !== "driver") {
            return res.status(403).json({ message: "Drivers only", error_code: "FORBIDDEN" });
        }

        await offers.expireDueOffers();

        const result = await pool.query(
            `SELECT o.id AS offer_id, o.status AS offer_status,
                    o.offered_at, o.expires_at,
                    ${BOOKING_SELECT}
             FROM booking_offers o
             JOIN bookings b ON b.id = o.booking_id
             LEFT JOIN users d    ON d.id = b.driver_id
             LEFT JOIN vehicles v ON v.id = b.vehicle_id
             WHERE o.driver_id = $1 AND o.status = 'pending'
             ORDER BY o.offered_at DESC`,
            [req.user.id]
        );

        res.status(200).json({
            offers: result.rows.map((row) => ({
                offer_id: row.offer_id,
                status: row.offer_status,
                offered_at: row.offered_at,
                expires_at: row.expires_at,

                // The client's number is never sent to a driver — not here,
                // not after they accept. See the note on toBooking.
                booking: toBooking(row, { includeClientContact: false })
            })),
            pending_count: result.rows.length
        });

    } catch (error) {
        console.error("Error in listMyOffers:", error);
        res.status(500).json({ message: "Something went wrong while fetching your offers" });
    }
};

// -----------------------------------------------------------------------------
// PATCH /api/v1/drivers/me/offers/:id   { "decision": "accepted" | "declined" }
// -----------------------------------------------------------------------------
const respondToOffer = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid offer id" });
        }

        if (req.user.role !== "driver") {
            return res.status(403).json({
                message: "Only drivers can answer job offers",
                error_code: "FORBIDDEN"
            });
        }

        const { decision, vehicle_id, reason } = req.body || {};

        if (decision !== "accepted" && decision !== "declined") {
            return res.status(400).json({
                message: "decision must be 'accepted' or 'declined'",
                error_code: "INVALID_DECISION"
            });
        }

        const result = await offers.respondToOffer(
            req.user.id,
            Number(id),
            decision,
            vehicle_id ? Number(vehicle_id) : null
        );

        if (result.error) {
            const status = result.error === "NOT_FOUND" ? 404 : 409;
            return res.status(status).json({
                message: result.message,
                error_code: result.error,
                offer_status: result.offer_status
            });
        }

        if (decision === "declined" && reason) {
            await pool.query(
                "UPDATE booking_offers SET decline_reason = $2 WHERE id = $1",
                [id, String(reason).slice(0, 255)]
            );
        }

        const booking = await pool.query(
            `SELECT ${BOOKING_SELECT} ${BOOKING_JOINS} WHERE b.id = $1`,
            [result.booking_id]
        );

        const driverName = [req.user.first_name, req.user.last_name].filter(Boolean).join(" ");

        if (decision === "accepted") {
            notifyOfferAccepted(booking.rows[0].created_by_operator_id, result.booking_id, driverName);
        } else {
            notifyOfferDeclined(booking.rows[0].created_by_operator_id, result.booking_id, driverName);
        }

        res.status(200).json({
            message: decision === "accepted" ? "Job accepted" : "Job declined",
            // Still no client number, even now. Accepting a job does not
            // create a right to ring the passenger; the office handles that.
            booking: toBooking(booking.rows[0], { includeClientContact: false })
        });

    } catch (error) {
        console.error("Error in respondToOffer:", error);
        res.status(500).json({ message: "Something went wrong while answering the offer" });
    }
};

// -----------------------------------------------------------------------------
// GET /api/v1/drivers/me/available-jobs
// -----------------------------------------------------------------------------
// The open pool — "Live Jobs Available Now".
//
// Filters, all optional:
//
//   ?vehicle_id=12                     "today I am driving this one"
//   ?fare_mode=fixed|bidding           the two tabs on the designer's screen
//   ?direction=to_airport|from_airport
//   ?sort=soonest|highest_fare|newest
//
// Distance and Nearest are NOT here, and that is deliberate: driver location
// does not exist anywhere in this system yet, and a filter that silently does
// nothing is worse than a filter that is absent. Payment (Card / Cash /
// Account) is absent for the same kind of reason — a booking has no payment
// method until the payments work lands. The response says both out loud in
// `notes` so the app does not have to guess.
const listAvailableJobs = async (req, res) => {
    try {
        if (req.user.role !== "driver") {
            return res.status(403).json({ message: "Drivers only", error_code: "FORBIDDEN" });
        }

        if (req.user.account_locked) {
            return res.status(403).json({
                message: "Upload your replacement document to see jobs again",
                error_code: "ACCOUNT_LOCKED"
            });
        }

        await offers.expireDueOffers();

        const params = [req.user.id];

        // ---------------------------------------------------------------
        // "Which car am I in today?"
        // ---------------------------------------------------------------
        // A driver can have more than one vehicle. Without this the pool is
        // every job that ANY of their cars could do, which is wrong the moment
        // they are out in the small one and half the list needs the big one.
        //
        // Checked against the driver's own vehicles first. Not for secrecy —
        // there is nothing secret about a vehicle id — but because a filter
        // that silently matches nothing sends somebody hunting for a bug in
        // the wrong place. A 404 says what happened.
        let chosenVehicle = null;

        if (req.query.vehicle_id !== undefined && req.query.vehicle_id !== "") {
            if (!/^\d+$/.test(String(req.query.vehicle_id))) {
                return res.status(400).json({
                    message: "vehicle_id must be a number",
                    error_code: "INVALID_VEHICLE_ID"
                });
            }

            const owned = await pool.query(
                `SELECT id, registration_number, make, model,
                        seats, luggage_large, luggage_small,
                        verification_status, availability_status
                   FROM vehicles
                  WHERE id = $1 AND driver_id = $2`,
                [Number(req.query.vehicle_id), req.user.id]
            );

            chosenVehicle = owned.rows[0] || null;

            if (!chosenVehicle) {
                return res.status(404).json({
                    message: "That is not one of your vehicles",
                    error_code: "VEHICLE_NOT_FOUND"
                });
            }

            // An unapproved or inactive car would match nothing at all. Say
            // why, rather than returning an empty list the driver reads as
            // "there is no work today".
            if (chosenVehicle.verification_status !== "approved") {
                return res.status(409).json({
                    message: "That vehicle is not approved yet, so it cannot be matched to jobs",
                    error_code: "VEHICLE_NOT_APPROVED"
                });
            }

            if (chosenVehicle.availability_status === "inactive") {
                return res.status(409).json({
                    message: "That vehicle is marked inactive",
                    error_code: "VEHICLE_INACTIVE"
                });
            }
        }

        // Only jobs the car can actually do — enough seats, enough room for
        // the bags. A list full of work they cannot take is not a list, it is
        // a tease.
        //
        // "dv" rather than "v": the outer query already uses v for the
        // booking's assigned vehicle, and reusing the alias here would
        // silently compare the wrong car.
        //
        // One vehicle when they picked one, any of theirs when they did not.
        let vehicleClause;

        if (chosenVehicle) {
            params.push(chosenVehicle.id);
            vehicleClause = `EXISTS (
                SELECT 1 FROM vehicles dv
                WHERE dv.id = $${params.length}
                  AND dv.driver_id = $1
                  AND ${vehicleFitsJoined("dv", "b")}
             )`;
        } else {
            vehicleClause = `EXISTS (
                SELECT 1 FROM vehicles dv
                WHERE dv.driver_id = $1
                  AND dv.verification_status = 'approved'
                  AND dv.availability_status <> 'inactive'
                  AND ${vehicleFitsJoined("dv", "b")}
             )`;
        }

        const where = [
            "b.is_open_to_all",
            "b.status = 'pending'",
            vehicleClause
        ];

        // NOTE: the ?vehicle_class= filter is gone. Classes no longer exist —
        // see migration 018. What replaced it is the line above: the driver
        // picks a real car of theirs, and the match runs on that car's seats
        // and luggage rather than on a class name the client never used.

        // ---------------------------------------------------------------
        // Fixed price / Bidding — the two buttons
        // ---------------------------------------------------------------
        // Validated rather than passed through. An unknown value silently
        // returning nothing would look exactly like "no work available".
        if (req.query.fare_mode !== undefined && req.query.fare_mode !== "") {
            const mode = String(req.query.fare_mode).trim().toLowerCase();

            if (!ALL_FARE_MODES.includes(mode)) {
                return res.status(400).json({
                    message: `fare_mode must be one of: ${ALL_FARE_MODES.join(", ")}`,
                    error_code: "INVALID_FARE_MODE"
                });
            }

            params.push(mode);
            where.push(`b.fare_mode = $${params.length}`);
        }

        // "To Airport" / "From Airport". Matched on the address text, which is
        // rough, but it is what there is until addresses are structured.
        if (req.query.direction === "to_airport") {
            where.push("(b.dropoff_address ILIKE '%airport%' OR b.dropoff_address ILIKE '%terminal%')");
        } else if (req.query.direction === "from_airport") {
            where.push("(b.pickup_address ILIKE '%airport%' OR b.pickup_address ILIKE '%terminal%')");
        }

        // ---------------------------------------------------------------
        // Sort
        // ---------------------------------------------------------------
        // "Highest fare" has to read two columns, because a fixed job carries
        // its money in fixed_amount and a bidding job in bid_high. Sorting on
        // either one alone would push the whole other kind of job to the
        // bottom regardless of what it pays.
        //
        // NULLS LAST throughout: a job with no amount named yet — which the
        // operator interview said is normal — belongs at the end of a list
        // sorted by money, not at the top of it.
        //
        // These are fixed strings chosen by a switch, never interpolated from
        // the query string. A sort column is not a value and cannot be a bound
        // parameter, so the safety has to come from the value never reaching
        // the SQL at all.
        const SORTS = {
            soonest: "COALESCE(b.scheduled_at, b.created_at) ASC",
            newest: "b.created_at DESC",
            highest_fare:
                "COALESCE(b.bid_high, b.fixed_amount) DESC NULLS LAST, " +
                "COALESCE(b.scheduled_at, b.created_at) ASC"
        };

        const requestedSort = String(req.query.sort || "soonest").trim().toLowerCase();
        const sort = SORTS[requestedSort] ? requestedSort : "soonest";

        const result = await pool.query(
            `SELECT ${BOOKING_SELECT} ${BOOKING_JOINS}
             WHERE ${where.join(" AND ")}
             ORDER BY ${SORTS[sort]}
             LIMIT 50`,
            params
        );

        res.status(200).json({
            jobs: result.rows.map((b) => toBooking(b, { includeClientContact: false })),
            total: result.rows.length,

            // What the list was actually filtered on, repeated back. An
            // unrecognised sort falls back to "soonest" rather than erroring,
            // so the screen needs to be told which one it got.
            filters: {
                vehicle_id: chosenVehicle ? chosenVehicle.id : null,
                vehicle: chosenVehicle
                    ? {
                        id: chosenVehicle.id,
                        registration_number: chosenVehicle.registration_number,
                        make: chosenVehicle.make,
                        model: chosenVehicle.model,
                        seats: chosenVehicle.seats,
                        luggage_large: chosenVehicle.luggage_large,
                        luggage_small: chosenVehicle.luggage_small
                    }
                    : null,
                fare_mode: req.query.fare_mode ? String(req.query.fare_mode).toLowerCase() : null,
                direction: req.query.direction || null,
                sort
            },

            // Said plainly rather than left for the frontend to discover.
            notes: {
                distance_filter: "Not available yet — driver location is not tracked",
                payment_filter: "Not available yet — bookings carry no payment method until payments are built"
            }
        });

    } catch (error) {
        console.error("Error in listAvailableJobs:", error);
        res.status(500).json({ message: "Something went wrong while fetching jobs" });
    }
};

// -----------------------------------------------------------------------------
// POST /api/v1/drivers/me/available-jobs/:id/claim
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// POST /api/v1/drivers/me/available-jobs/:id/bid   { "amount": 95 }
// -----------------------------------------------------------------------------
// This replaced the Claim button on 21 September, and the difference is the
// whole point: a bid does NOT give the driver the job. It tells the operator
// they are willing, at a price where there is one, and the operator decides.
//
// Bidding again on the same job replaces the amount rather than adding a
// second bid, so this is also how a driver changes their mind.
//
// On a fixed-fare job there is nothing to name — send no amount, and it means
// "I will take it at your price".
const placeBid = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid job id" });
        }

        // Checked here, before the service. Without it an operator calling this
        // endpoint fell through to "That driver does not exist" — true in the
        // narrow sense and useless to read, because the person asking is logged
        // in and knows they exist.
        if (req.user.role !== "driver") {
            return res.status(403).json({
                message: "Only drivers can bid on jobs",
                error_code: "FORBIDDEN"
            });
        }

        if (req.user.account_locked) {
            return res.status(403).json({
                message: "Upload your replacement document before bidding",
                error_code: "ACCOUNT_LOCKED"
            });
        }

        const { amount } = req.body || {};

        const result = await offers.placeBid(
            req.user.id,
            Number(id),
            amount === undefined ? null : amount
        );

        if (result.error) {
            const status = result.error === "NOT_FOUND" ? 404
                : result.error === "DRIVER_UNAVAILABLE" ? 409
                    : result.error === "JOB_TAKEN" ? 409
                        : 400;

            return res.status(status).json({
                message: result.message,
                error_code: result.error
            });
        }

        const driverName = [req.user.first_name, req.user.last_name].filter(Boolean).join(" ");

        notifyBidReceived(
            result.operator_id,
            result.booking_id,
            result.reference,
            driverName,
            result.bid.amount === null ? null : Number(result.bid.amount)
        );

        res.status(201).json({
            message: "Your bid is with the operator",
            bid: {
                id: result.bid.id,
                booking_id: result.booking_id,
                reference: result.reference,
                amount: result.bid.amount === null ? null : Number(result.bid.amount),
                status: result.bid.status,
                offered_at: result.bid.offered_at
            }
        });

    } catch (error) {
        console.error("Error in placeBid:", error);
        res.status(500).json({ message: "Something went wrong while placing your bid" });
    }
};

// -----------------------------------------------------------------------------
// DELETE /api/v1/drivers/me/bids/:id
// -----------------------------------------------------------------------------
// Taking a bid back, before the operator has chosen.
const withdrawBid = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid bid id" });
        }

        if (req.user.role !== "driver") {
            return res.status(403).json({ message: "Drivers only", error_code: "FORBIDDEN" });
        }

        const withdrawn = await offers.withdrawBid(req.user.id, Number(id));

        if (!withdrawn) {
            // One message for "not yours", "already answered" and "never
            // existed". Telling a driver that somebody else's bid exists is a
            // small leak with no upside.
            return res.status(409).json({
                message: "That bid is no longer live",
                error_code: "BID_NOT_LIVE"
            });
        }

        res.status(200).json({
            message: "Bid withdrawn",
            booking_id: withdrawn.booking_id
        });

    } catch (error) {
        console.error("Error in withdrawBid:", error);
        res.status(500).json({ message: "Something went wrong" });
    }
};

// -----------------------------------------------------------------------------
// GET /api/v1/drivers/me/bids
// -----------------------------------------------------------------------------
// "View My Bids" on the driver's screen. Live ones first — those are the only
// ones they can still do anything about.
const listMyBids = async (req, res) => {
    try {
        if (req.user.role !== "driver") {
            return res.status(403).json({ message: "Drivers only", error_code: "FORBIDDEN" });
        }

        const result = await pool.query(
            `SELECT o.id, o.amount, o.status, o.offered_at, o.responded_at,
                    ${BOOKING_SELECT}
             FROM booking_offers o
             JOIN bookings b      ON b.id = o.booking_id
             LEFT JOIN users d    ON d.id = b.driver_id
             LEFT JOIN vehicles v ON v.id = b.vehicle_id
             WHERE o.driver_id = $1 AND o.offer_kind = 'bid'
             ORDER BY (o.status = 'pending') DESC, o.offered_at DESC
             LIMIT 50`,
            [req.user.id]
        );

        res.status(200).json({
            bids: result.rows.map((row) => ({
                id: row.id,
                amount: row.amount === null ? null : Number(row.amount),
                status: row.status,
                offered_at: row.offered_at,
                responded_at: row.responded_at,

                // A rejected bid can be replaced with another one; a lost job
                // cannot. Said plainly so the app does not have to work out
                // which button to show from the status word.
                can_bid_again: row.status === "rejected",

                booking: toBooking(row, { includeClientContact: false })
            })),

            live_count: result.rows.filter((r) => r.status === "pending").length
        });

    } catch (error) {
        console.error("Error in listMyBids:", error);
        res.status(500).json({ message: "Something went wrong while fetching your bids" });
    }
};

const listMyJobs = async (req, res) => {
    try {
        if (req.user.role !== "driver") {
            return res.status(403).json({ message: "Drivers only", error_code: "FORBIDDEN" });
        }

        const scope = ["upcoming", "today", "past", "active"].includes(req.query.scope)
            ? req.query.scope
            : "upcoming";

        const where = ["b.driver_id = $1"];
        const params = [req.user.id];

        if (scope === "active") {
            where.push("b.status IN ('accepted','en_route','arrived','in_progress')");
        } else if (scope === "today") {
            where.push("COALESCE(b.scheduled_at, b.created_at)::date = CURRENT_DATE");
        } else if (scope === "upcoming") {
            where.push("b.status NOT IN ('completed','cancelled')");
        } else {
            where.push("b.status IN ('completed','cancelled')");
        }

        const order = scope === "past"
            ? "COALESCE(b.completed_at, b.cancelled_at, b.created_at) DESC"
            : "COALESCE(b.scheduled_at, b.created_at) ASC";

        const result = await pool.query(
            `SELECT ${BOOKING_SELECT} ${BOOKING_JOINS}
             WHERE ${where.join(" AND ")}
             ORDER BY ${order}
             LIMIT 100`,
            params
        );

        res.status(200).json({
            scope,
            jobs: result.rows.map((b) => toBooking(b, { includeClientContact: false })),
            total: result.rows.length
        });

    } catch (error) {
        console.error("Error in listMyJobs:", error);
        res.status(500).json({ message: "Something went wrong while fetching your jobs" });
    }
};

// -----------------------------------------------------------------------------
// GET /api/v1/drivers/me/jobs/:id
// -----------------------------------------------------------------------------
const getMyJob = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid job id" });
        }

        const result = await pool.query(
            `SELECT ${BOOKING_SELECT},
                    o.first_name AS operator_first_name,
                    o.last_name  AS operator_last_name
             ${BOOKING_JOINS}
             LEFT JOIN users o ON o.id = b.created_by_operator_id
             WHERE b.id = $1 AND b.driver_id = $2`,
            [id, req.user.id]
        );

        const booking = result.rows[0];
        if (!booking) {
            return res.status(404).json({ message: "No job with that id", error_code: "NOT_FOUND" });
        }

        const shaped = toBooking(booking, { includeClientContact: false });

        // The driver is told who they are working for — name and company, no
        // number. That is not a break in the masking rule: masking was always
        // about contact details. Somebody doing a job should know who gave it
        // to them.
        shaped.operator = {
            id: booking.created_by_operator_id,
            full_name: [booking.operator_first_name, booking.operator_last_name]
                .filter(Boolean).join(" "),
            phone: null,
            contact_masked: true
        };

        // What the driver's button should say next.
        const nextStep = {
            accepted: "en_route",
            en_route: "arrived",
            arrived: "in_progress",
            in_progress: "completed"
        }[booking.status] || null;

        shaped.next_status = nextStep;

        res.status(200).json({ booking: shaped });

    } catch (error) {
        console.error("Error in getMyJob:", error);
        res.status(500).json({ message: "Something went wrong while fetching the job" });
    }
};

// -----------------------------------------------------------------------------
// PATCH /api/v1/drivers/me/jobs/:id/status   { "status": "en_route" }
// -----------------------------------------------------------------------------
const updateJobStatus = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid job id" });
        }

        const { status } = req.body || {};
        const allowed = Object.keys(DRIVER_STATUS_STEPS);

        if (!allowed.includes(status)) {
            return res.status(400).json({
                message: `status must be one of: ${allowed.join(", ")}`,
                error_code: "INVALID_STATUS"
            });
        }

        const result = await offers.updateJobStatus(req.user.id, Number(id), status);

        if (result.error) {
            const code = result.error === "NOT_FOUND" ? 404 : 409;
            return res.status(code).json({
                message: result.message,
                error_code: result.error,
                current_status: result.current_status
            });
        }

        const booking = await pool.query(
            `SELECT ${BOOKING_SELECT} ${BOOKING_JOINS} WHERE b.id = $1`,
            [id]
        );

        notifyJobStatusChanged(
            booking.rows[0].created_by_operator_id,
            Number(id),
            status,
            [req.user.first_name, req.user.last_name].filter(Boolean).join(" ")
        );

        // The client's SMS hangs off this same moment — see Part C. Nothing is
        // sent yet; when it is, it goes here, and a failure to send must never
        // stop the driver's status changing.

        // The job is over — ask both sides to rate it.
        //
        // Once, here, and never again. A reminder that repeats collects
        // ratings given to stop the reminder, and those are worth less than no
        // rating at all.
        if (result.completed) {
            notifyRatingDue(result.booking.operator_id, Number(id), result.booking.reference);
            notifyRatingDue(req.user.id, Number(id), result.booking.reference);
        }

        res.status(200).json({
            message: "Status updated",
            booking: toBooking(booking.rows[0], { includeClientContact: false }),

            // So the app can put the rating form straight in front of the
            // driver instead of making them find the finished job again.
            ...(result.completed ? { rating_due: true } : {})
        });

    } catch (error) {
        console.error("Error in updateJobStatus:", error);
        res.status(500).json({ message: "Something went wrong while updating the job" });
    }
};

module.exports = {
    setOnline,
    listMyOffers,
    respondToOffer,
    listAvailableJobs,
    placeBid,
    withdrawBid,
    listMyBids,
    listMyJobs,
    getMyJob,
    updateJobStatus
};