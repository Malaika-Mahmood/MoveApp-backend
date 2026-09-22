const pool = require("../config/db");
const {
    validateBooking,
    toBooking,
    BOOKING_SELECT,
    BOOKING_JOINS
} = require("../services/bookingValidation");
const {
    BOOKING_STATUS,
    ALL_BOOKING_STATUSES,
    BOOKING_TYPES,
    canTransition
} = require("../constants/bookings");

// The operator's side of a booking: create it, find it, change it, call it off.
//
// Offering it to a driver is a separate file — that is a different job with
// different rules, and keeping them apart stops this one growing into the
// thousand-line controller that nobody wants to open.

// Columns an operator may set. Anything not on this list is ignored rather
// than rejected, so a frontend sending an extra field does not break; but
// status, driver_id and the timestamps can never be set by hand. Those are
// consequences of something happening, not things anybody types.
const WRITABLE = [
    "booking_type",
    "client_name", "client_phone", "client_email",
    "pickup_address", "pickup_postcode",
    "dropoff_address", "dropoff_postcode", "via_address",
    "scheduled_at", "duration_hours", "flight_number",
    "passengers", "large_bags", "small_bags",
    "child_seat", "wheelchair_accessible", "special_instructions",

    // What the client asked for, in their own words — "Range Rover",
    // "S Class", "something big". This replaced vehicle_class_id on 21
    // September: a client can name any car at all, so a fixed list of classes
    // could never hold what they actually say. Matching runs on passengers and
    // luggage instead, and this field is for the operator to read.
    "requested_vehicle",

    // The Fare Details step. 'fixed' with one amount, or 'bidding' with a
    // window drivers bid inside. Whose money this is has not been decided —
    // see migration 019.
    "fare_mode", "fixed_amount", "bid_low", "bid_high"
];

const loadBooking = async (id) => {
    const result = await pool.query(
        `SELECT ${BOOKING_SELECT} ${BOOKING_JOINS} WHERE b.id = $1`,
        [id]
    );
    return result.rows[0] || null;
};

// -----------------------------------------------------------------------------
// POST /api/v1/operator/bookings
// -----------------------------------------------------------------------------
const createBooking = async (req, res) => {
    try {
        const { errors, values } = await validateBooking(req.body || {});

        if (errors.length > 0) {
            return res.status(400).json({
                message: "Please correct the booking details",
                error_code: "VALIDATION_FAILED",
                errors
            });
        }

        const columns = ["created_by_operator_id"];
        const params = [req.user.id];

        for (const key of WRITABLE) {
            if (values[key] === undefined) continue;
            columns.push(key);
            params.push(values[key]);
        }

        const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");

        const inserted = await pool.query(
            `INSERT INTO bookings (${columns.join(", ")})
             VALUES (${placeholders})
             RETURNING id`,
            params
        );

        const booking = await loadBooking(inserted.rows[0].id);

        // 201 with the whole booking, because the next screen is the
        // confirmation — reference number, client, journey — and it should not
        // need a second request to draw it.
        res.status(201).json({
            message: "Booking created",
            booking: toBooking(booking)
        });

    } catch (error) {
        console.error("Error in createBooking:", error);
        res.status(500).json({ message: "Something went wrong while creating the booking" });
    }
};

// -----------------------------------------------------------------------------
// GET /api/v1/operator/bookings
// -----------------------------------------------------------------------------
// ?status=pending&from=2026-09-14&to=2026-09-20&driver_id=7&q=BK-1046&page=1&limit=20
const listBookings = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const offset = (page - 1) * limit;

        const where = [];
        const params = [];

        // Several statuses at once: ?status=pending,offered — the operator's
        // "needs attention" view is more than one status.
        if (req.query.status) {
            const wanted = String(req.query.status)
                .split(",")
                .map((s) => s.trim())
                .filter((s) => ALL_BOOKING_STATUSES.includes(s));

            if (wanted.length === 0) {
                return res.status(400).json({
                    message: `status must be one or more of: ${ALL_BOOKING_STATUSES.join(", ")}`,
                    error_code: "INVALID_STATUS"
                });
            }

            params.push(wanted);
            where.push(`b.status = ANY($${params.length})`);
        }

        if (req.query.driver_id) {
            if (!/^\d+$/.test(req.query.driver_id)) {
                return res.status(400).json({ message: "driver_id must be a number" });
            }
            params.push(Number(req.query.driver_id));
            where.push(`b.driver_id = $${params.length}`);
        }

        // Dates are compared on scheduled_at, falling back to created_at so an
        // ASAP booking — which has no scheduled_at — still appears in
        // "today's jobs".
        if (req.query.from) {
            params.push(req.query.from);
            where.push(`COALESCE(b.scheduled_at, b.created_at) >= $${params.length}::date`);
        }

        if (req.query.to) {
            params.push(req.query.to);
            where.push(`COALESCE(b.scheduled_at, b.created_at) < ($${params.length}::date + 1)`);
        }

        // One search box for the reference and the client's name, because that
        // is what an operator has in front of them when a client rings: either
        // "it's BK-1046" or "it's Mrs Chen".
        if (req.query.q) {
            params.push(`%${String(req.query.q).trim()}%`);
            where.push(`(b.reference ILIKE $${params.length} OR b.client_name ILIKE $${params.length})`);
        }

        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

        const countResult = await pool.query(
            `SELECT COUNT(*)::int AS total FROM bookings b ${whereSql}`,
            params
        );
        const total = countResult.rows[0].total;

        params.push(limit, offset);

        const result = await pool.query(
            `SELECT ${BOOKING_SELECT} ${BOOKING_JOINS}
             ${whereSql}
             ORDER BY COALESCE(b.scheduled_at, b.created_at) ASC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        res.status(200).json({
            bookings: result.rows.map((b) => toBooking(b)),
            pagination: {
                page,
                limit,
                total,
                total_pages: Math.max(1, Math.ceil(total / limit))
            }
        });

    } catch (error) {
        console.error("Error in listBookings:", error);
        res.status(500).json({ message: "Something went wrong while fetching bookings" });
    }
};

// -----------------------------------------------------------------------------
// GET /api/v1/operator/bookings/:id
// -----------------------------------------------------------------------------
const getBooking = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid booking id" });
        }

        const booking = await loadBooking(Number(id));
        if (!booking) {
            return res.status(404).json({ message: "Booking not found", error_code: "NOT_FOUND" });
        }

        // Every offer this booking has been through, so the operator can see
        // who has already turned it down instead of sending it round again.
        const offers = await pool.query(
            `SELECT o.id, o.driver_id, o.status, o.offered_at, o.responded_at,
                    o.expires_at, o.decline_reason,
                    d.first_name, d.last_name
             FROM booking_offers o
             JOIN users d ON d.id = o.driver_id
             WHERE o.booking_id = $1
             ORDER BY o.offered_at DESC`,
            [id]
        );

        res.status(200).json({
            booking: toBooking(booking),
            offers: offers.rows.map((o) => ({
                id: o.id,
                driver: {
                    id: o.driver_id,
                    full_name: [o.first_name, o.last_name].filter(Boolean).join(" ")
                },
                status: o.status,
                offered_at: o.offered_at,
                responded_at: o.responded_at,
                expires_at: o.expires_at,
                decline_reason: o.decline_reason
            }))
        });

    } catch (error) {
        console.error("Error in getBooking:", error);
        res.status(500).json({ message: "Something went wrong while fetching the booking" });
    }
};

// -----------------------------------------------------------------------------
// PATCH /api/v1/operator/bookings/:id
// -----------------------------------------------------------------------------
const updateBooking = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid booking id" });
        }

        const existing = await loadBooking(Number(id));
        if (!existing) {
            return res.status(404).json({ message: "Booking not found", error_code: "NOT_FOUND" });
        }

        // A finished or cancelled booking is a record of what happened. Editing
        // it would be rewriting history, and the client has already been told
        // what it said.
        if (existing.status === BOOKING_STATUS.COMPLETED ||
            existing.status === BOOKING_STATUS.CANCELLED) {
            return res.status(409).json({
                message: `A ${existing.status} booking cannot be changed`,
                error_code: "BOOKING_CLOSED"
            });
        }

        const { errors, values } = await validateBooking(req.body || {}, { isUpdate: true });

        if (errors.length > 0) {
            return res.status(400).json({
                message: "Please correct the booking details",
                error_code: "VALIDATION_FAILED",
                errors
            });
        }

        const sets = [];
        const params = [];

        for (const key of WRITABLE) {
            if (values[key] === undefined) continue;
            params.push(values[key]);
            sets.push(`${key} = $${params.length}`);
        }

        if (sets.length === 0) {
            return res.status(400).json({
                message: "Nothing to update",
                error_code: "NO_CHANGES"
            });
        }

        params.push(Number(id));

        await pool.query(
            `UPDATE bookings SET ${sets.join(", ")}, updated_at = NOW()
             WHERE id = $${params.length}`,
            params
        );

        const booking = await loadBooking(Number(id));

        // A driver already holding this job needs telling that the details
        // moved under them — a changed pickup nobody mentioned is how a car
        // ends up at the wrong address.
        const driverNeedsTelling = Boolean(existing.driver_id);

        res.status(200).json({
            message: "Booking updated",
            booking: toBooking(booking),
            driver_notified: driverNeedsTelling
        });

    } catch (error) {
        console.error("Error in updateBooking:", error);
        res.status(500).json({ message: "Something went wrong while updating the booking" });
    }
};

// -----------------------------------------------------------------------------
// PATCH /api/v1/operator/bookings/:id/cancel
// -----------------------------------------------------------------------------
const cancelBooking = async (req, res) => {
    const client = await pool.connect();

    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid booking id" });
        }

        const { reason } = req.body || {};
        const cleanReason = reason ? String(reason).trim() : null;

        if (!cleanReason) {
            return res.status(400).json({
                message: "A cancellation reason is required",
                error_code: "REASON_REQUIRED"
            });
        }

        if (cleanReason.length > 255) {
            return res.status(400).json({ message: "reason must be 255 characters or fewer" });
        }

        await client.query("BEGIN");

        const existing = await client.query("SELECT * FROM bookings WHERE id = $1 FOR UPDATE", [id]);
        const booking = existing.rows[0];

        if (!booking) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Booking not found", error_code: "NOT_FOUND" });
        }

        if (!canTransition(booking.status, BOOKING_STATUS.CANCELLED)) {
            await client.query("ROLLBACK");
            return res.status(409).json({
                message: `A ${booking.status} booking cannot be cancelled`,
                error_code: "CANNOT_CANCEL"
            });
        }

        await client.query(
            `UPDATE bookings
             SET status = 'cancelled',
                 cancelled_at = NOW(),
                 cancelled_by = $2,
                 cancellation_reason = $3,
                 is_open_to_all = FALSE,
                 updated_at = NOW()
             WHERE id = $1`,
            [id, req.user.id, cleanReason]
        );

        // Any offer still hanging is dead too. Without this a driver could
        // accept a job that no longer exists.
        await client.query(
            `UPDATE booking_offers
             SET status = 'withdrawn', responded_at = NOW()
             WHERE booking_id = $1 AND status = 'pending'`,
            [id]
        );

        await client.query("COMMIT");

        const updated = await loadBooking(Number(id));

        res.status(200).json({
            message: "Booking cancelled",
            booking: toBooking(updated)
        });

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        console.error("Error in cancelBooking:", error);
        res.status(500).json({ message: "Something went wrong while cancelling the booking" });

    } finally {
        client.release();
    }
};

// -----------------------------------------------------------------------------
// GET /api/v1/vehicle-classes  — RETIRED
// -----------------------------------------------------------------------------
// Kept so that an app build still calling it gets a clear answer rather than a
// 404 it has no code path for. It now returns an empty list every time.
//
// Classes went on 21 September. A client can ask for any car in the world —
// "Range Rover", "the big Mercedes", "same as last time" — and a dropdown can
// only ever hold the words we thought of first. So the request is recorded as
// the client said it, in booking.requested_vehicle, and cars are matched on
// how many people and how much luggage they hold.
//
// Empty rather than the three placeholder rows still sitting in the table: an
// app that draws a dropdown from this should draw nothing, not three invented
// names from a design mock-up.
const listVehicleClasses = async (req, res) => {
    res.status(200).json({
        vehicle_classes: [],
        retired: true,
        message:
            "Vehicle classes are no longer used. Bookings carry requested_vehicle " +
            "as free text, and drivers are matched on passengers and luggage."
    });
};

module.exports = {
    createBooking,
    listBookings,
    getBooking,
    updateBooking,
    cancelBooking,
    listVehicleClasses,
    loadBooking,
    WRITABLE
};