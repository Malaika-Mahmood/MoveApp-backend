const pool = require("../config/db");
const offers = require("../services/bookingOffers");
const { toBooking, BOOKING_SELECT, BOOKING_JOINS } = require("../services/bookingValidation");
const { DRIVER_STATUS_STEPS } = require("../constants/bookings");
const {
    notifyOfferAccepted,
    notifyOfferDeclined,
    notifyJobStatusChanged
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
        await offers.expireDueOffers();

        const result = await pool.query(
            `SELECT o.id AS offer_id, o.status AS offer_status,
                    o.offered_at, o.expires_at,
                    ${BOOKING_SELECT}
             FROM booking_offers o
             JOIN bookings b ON b.id = o.booking_id
             LEFT JOIN vehicle_classes vc ON vc.id = b.vehicle_class_id
             LEFT JOIN users d            ON d.id  = b.driver_id
             LEFT JOIN vehicles v         ON v.id  = b.vehicle_id
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

                // The client's number is withheld until the driver accepts.
                // They can see where the job goes and when — everything they
                // need to decide — but not a phone number for a job they have
                // not taken.
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
            // Accepting is what unlocks the client's number — the driver now
            // has a reason to ring them.
            booking: toBooking(booking.rows[0], { includeClientContact: decision === "accepted" })
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
// Filters match the designer's screen: vehicle class, direction, sort. Distance
// is not here because driver location does not exist yet; adding a filter that
// silently does nothing would be worse than leaving it out.
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

        const where = [
            "b.is_open_to_all",
            "b.status = 'pending'",
            // Only jobs this driver's car can actually do. A list full of work
            // they cannot take is not a list, it is a tease.
            `EXISTS (
                SELECT 1 FROM vehicles v
                WHERE v.driver_id = $1
                  AND v.verification_status = 'approved'
                  AND v.availability_status <> 'inactive'
                  AND (b.vehicle_class_id IS NULL OR v.vehicle_class_id = b.vehicle_class_id)
             )`
        ];
        const params = [req.user.id];

        if (req.query.vehicle_class) {
            params.push(req.query.vehicle_class);
            where.push(`vc.code = $${params.length}`);
        }

        // "To Airport" / "From Airport". Matched on the address text, which is
        // rough, but it is what there is until addresses are structured.
        if (req.query.direction === "to_airport") {
            where.push("(b.dropoff_address ILIKE '%airport%' OR b.dropoff_address ILIKE '%terminal%')");
        } else if (req.query.direction === "from_airport") {
            where.push("(b.pickup_address ILIKE '%airport%' OR b.pickup_address ILIKE '%terminal%')");
        }

        const order = req.query.sort === "soonest" || !req.query.sort
            ? "COALESCE(b.scheduled_at, b.created_at) ASC"
            : "b.created_at DESC";

        const result = await pool.query(
            `SELECT ${BOOKING_SELECT} ${BOOKING_JOINS}
             WHERE ${where.join(" AND ")}
             ORDER BY ${order}
             LIMIT 50`,
            params
        );

        res.status(200).json({
            jobs: result.rows.map((b) => toBooking(b, { includeClientContact: false })),
            total: result.rows.length,
            // Said plainly rather than left for the frontend to discover.
            notes: {
                distance_filter: "Not available yet — driver location is not tracked"
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
const claimJob = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid job id" });
        }

        if (req.user.account_locked) {
            return res.status(403).json({
                message: "Upload your replacement document before taking jobs",
                error_code: "ACCOUNT_LOCKED"
            });
        }

        const { vehicle_id } = req.body || {};

        const result = await offers.claimOpenJob(
            req.user.id,
            Number(id),
            vehicle_id ? Number(vehicle_id) : null
        );

        if (result.error) {
            const status = result.error === "NOT_FOUND" ? 404 : 409;
            return res.status(status).json({ message: result.message, error_code: result.error });
        }

        const booking = await pool.query(
            `SELECT ${BOOKING_SELECT} ${BOOKING_JOINS} WHERE b.id = $1`,
            [result.booking_id]
        );

        const driverName = [req.user.first_name, req.user.last_name].filter(Boolean).join(" ");
        notifyOfferAccepted(booking.rows[0].created_by_operator_id, result.booking_id, driverName);

        res.status(200).json({
            message: "Job is yours",
            booking: toBooking(booking.rows[0])
        });

    } catch (error) {
        console.error("Error in claimJob:", error);
        res.status(500).json({ message: "Something went wrong while taking the job" });
    }
};

// -----------------------------------------------------------------------------
// GET /api/v1/drivers/me/jobs?scope=upcoming|today|past|active
// -----------------------------------------------------------------------------
const listMyJobs = async (req, res) => {
    try {
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
            jobs: result.rows.map((b) => toBooking(b)),
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

        const shaped = toBooking(booking);

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

        res.status(200).json({
            message: "Status updated",
            booking: toBooking(booking.rows[0])
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
    claimJob,
    listMyJobs,
    getMyJob,
    updateJobStatus
};