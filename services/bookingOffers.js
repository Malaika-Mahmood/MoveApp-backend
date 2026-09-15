const pool = require("../config/db");
const {
    BOOKING_STATUS,
    OFFER_STATUS,
    offerTimeoutFor,
    canTransition,
    DRIVER_STATUS_STEPS
} = require("../constants/bookings");

// Getting a job from an operator to a driver, and through to the end of the
// journey.
//
// Two routes in, and they are genuinely different:
//
//   An OFFER goes to one named driver. This is how a chauffeur firm works — a
//   regular client gets the driver they know, and the operator picks them.
//
//   A PUBLISHED job sits in the open pool and any driver who is online may
//   claim it. This is what fills the gaps at 2am.
//
// Both end in the same place: booking.driver_id set, status 'accepted'.
//
// Everything here that changes a booking does it inside a transaction with the
// row locked. Two drivers tapping Accept at the same instant is not a rare
// case to be tidied up later — with an open pool it is the normal case, and
// the answer has to be that exactly one of them gets the job.

// -----------------------------------------------------------------------------
// Who may be given a job
// -----------------------------------------------------------------------------

// A driver can take work only if all of this is true. Checked in one query
// because checking it in five and then acting would leave room for the answer
// to change in between.
//
// The vehicle matters as much as the driver: a booking asks for a class, and
// the driver's car has to be that class and have passed verification. This is
// also the only place the fleet question is settled — a company car and an
// outside driver's car are judged by exactly the same rule.
//
// Matched on vehicle_class_id, never on the old free-text vehicle_class. One
// driver wrote "Executive Saloon" where the class list says "saloon", and
// string comparison found nothing — no error, just an empty list of drivers
// and no clue why. See migration 015.
const loadAssignableDriver = async (client, driverId, booking) => {
    const result = await client.query(
        `SELECT u.id, u.first_name, u.last_name, u.status,
                u.suspension_reason, u.is_online,
                v.id AS vehicle_id, v.registration_number, v.vehicle_class
         FROM users u
         LEFT JOIN vehicles v
                ON v.driver_id = u.id
               AND v.verification_status = 'approved'
               AND v.availability_status <> 'inactive'
               AND ($2::int IS NULL OR v.vehicle_class_id = $2)
         WHERE u.id = $1 AND u.role = 'driver'
         ORDER BY v.id ASC
         LIMIT 1`,
        [driverId, booking.vehicle_class_id || null]
    );

    return result.rows[0] || null;
};

// Why this driver cannot be given this job, in words an operator can act on.
// Null means they can.
const reasonDriverCannotTake = (driver, booking) => {
    if (!driver) return "That driver does not exist";

    if (driver.status === "suspended") {
        return driver.suspension_reason === "document_expired"
            ? "That driver is locked out — one of their documents has expired"
            : "That driver is suspended";
    }

    if (driver.status !== "approved") {
        return "That driver has not been fully verified yet";
    }

    if (!driver.vehicle_id) {
        return booking.vehicle_class_name
            ? `That driver has no approved ${booking.vehicle_class_name}`
            : "That driver has no approved vehicle";
    }

    return null;
};

// -----------------------------------------------------------------------------
// Expiry
// -----------------------------------------------------------------------------

// ASAP offers nobody answered. Three minutes, then the booking goes back in
// the pile so the operator can try somebody else.
//
// Swept lazily — at the top of anything that reads offers — rather than by a
// job. A stale offer only matters at the moment somebody looks at it, and a
// second cron for three-minute work would be a lot of machinery for a small
// question. It runs inside the caller's transaction where there is one, so an
// offer cannot expire halfway through being accepted.
const expireDueOffers = async (client = pool) => {
    const expired = await client.query(
        `UPDATE booking_offers
         SET status = 'expired', responded_at = NOW()
         WHERE status = 'pending'
           AND expires_at IS NOT NULL
           AND expires_at <= NOW()
         RETURNING id, booking_id, driver_id`
    );

    if (expired.rows.length === 0) return [];

    // The bookings those offers were holding go back to pending — but only if
    // they are still waiting on that offer. A booking that moved on in the
    // meantime must not be dragged backwards.
    const bookingIds = expired.rows.map((r) => r.booking_id);

    await client.query(
        `UPDATE bookings
         SET status = 'pending', updated_at = NOW()
         WHERE id = ANY($1) AND status = 'offered'`,
        [bookingIds]
    );

    return expired.rows;
};

// -----------------------------------------------------------------------------
// Offering
// -----------------------------------------------------------------------------

const offerToDriver = async (bookingId, driverId, operatorId) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");
        await expireDueOffers(client);

        const bookingResult = await client.query(
            `SELECT b.*, vc.code AS vehicle_class_code, vc.name AS vehicle_class_name
             FROM bookings b
             LEFT JOIN vehicle_classes vc ON vc.id = b.vehicle_class_id
             WHERE b.id = $1
             FOR UPDATE OF b`,
            [bookingId]
        );
        const booking = bookingResult.rows[0];

        if (!booking) {
            await client.query("ROLLBACK");
            return { error: "NOT_FOUND", message: "Booking not found" };
        }

        if (booking.status !== BOOKING_STATUS.PENDING) {
            await client.query("ROLLBACK");

            // Naming the current state is the difference between an operator
            // who knows what to do next and one who presses the button again.
            const message = booking.status === BOOKING_STATUS.OFFERED
                ? "This booking is already with a driver. Withdraw that offer first."
                : `A ${booking.status} booking cannot be offered`;

            return { error: "CANNOT_OFFER", message };
        }

        const driver = await loadAssignableDriver(client, driverId, booking);
        const refusal = reasonDriverCannotTake(driver, booking);

        if (refusal) {
            await client.query("ROLLBACK");
            return { error: "DRIVER_UNAVAILABLE", message: refusal };
        }

        // Has this driver already turned this job down? Offering it again is
        // not forbidden — an operator may well ring back and ask a second time
        // — but the operator should know they are doing it.
        const previous = await client.query(
            `SELECT status FROM booking_offers
             WHERE booking_id = $1 AND driver_id = $2 AND status = 'declined'
             LIMIT 1`,
            [bookingId, driverId]
        );

        const timeout = offerTimeoutFor(booking.booking_type);

        const offer = await client.query(
            `INSERT INTO booking_offers
                (booking_id, driver_id, offered_by_operator_id, expires_at)
             VALUES ($1, $2, $3, ${timeout ? `NOW() + INTERVAL '${timeout} minutes'` : "NULL"})
             RETURNING *`,
            [bookingId, driverId, operatorId]
        );

        await client.query(
            `UPDATE bookings SET status = 'offered', updated_at = NOW() WHERE id = $1`,
            [bookingId]
        );

        await client.query("COMMIT");

        return {
            offer: offer.rows[0],
            driver,
            previously_declined: previous.rows.length > 0,
            expires_in_minutes: timeout
        };

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        throw error;

    } finally {
        client.release();
    }
};

// The operator takes it back — the driver is not answering, or the client
// asked for somebody else.
const withdrawOffer = async (bookingId) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const withdrawn = await client.query(
            `UPDATE booking_offers
             SET status = 'withdrawn', responded_at = NOW()
             WHERE booking_id = $1 AND status = 'pending'
             RETURNING id, driver_id`,
            [bookingId]
        );

        if (withdrawn.rows.length === 0) {
            await client.query("ROLLBACK");
            return { error: "NO_PENDING_OFFER", message: "There is no offer waiting on this booking" };
        }

        await client.query(
            `UPDATE bookings
             SET status = 'pending', updated_at = NOW()
             WHERE id = $1 AND status = 'offered'`,
            [bookingId]
        );

        await client.query("COMMIT");
        return { withdrawn: withdrawn.rows };

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        throw error;

    } finally {
        client.release();
    }
};

// Into the open pool.
const publishToPool = async (bookingId) => {
    const result = await pool.query(
        `UPDATE bookings
         SET is_open_to_all = TRUE, published_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING id`,
        [bookingId]
    );

    return result.rows.length > 0;
};

const unpublishFromPool = async (bookingId) => {
    const result = await pool.query(
        `UPDATE bookings
         SET is_open_to_all = FALSE, updated_at = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING id`,
        [bookingId]
    );

    return result.rows.length > 0;
};

// -----------------------------------------------------------------------------
// The driver answering
// -----------------------------------------------------------------------------

// Accept or decline. Returns { booking } on an accept, { declined: true } on a
// decline, or { error } if the job moved on while the driver was looking at it.
const respondToOffer = async (driverId, offerId, decision, vehicleId = null) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");
        await expireDueOffers(client);

        const offerResult = await client.query(
            `SELECT * FROM booking_offers WHERE id = $1 AND driver_id = $2 FOR UPDATE`,
            [offerId, driverId]
        );
        const offer = offerResult.rows[0];

        // 404 rather than 403 for somebody else's offer: "this exists but is
        // not yours" is itself a leak.
        if (!offer) {
            await client.query("ROLLBACK");
            return { error: "NOT_FOUND", message: "No offer with that id" };
        }

        if (offer.status !== OFFER_STATUS.PENDING) {
            await client.query("ROLLBACK");

            const reason = {
                accepted: "You have already accepted this job",
                declined: "You have already declined this job",
                expired: "This offer has expired",
                withdrawn: "The operator has withdrawn this offer"
            }[offer.status] || "This offer is no longer open";

            return { error: "OFFER_CLOSED", message: reason, offer_status: offer.status };
        }

        if (decision === "declined") {
            await client.query(
                `UPDATE booking_offers
                 SET status = 'declined', responded_at = NOW()
                 WHERE id = $1`,
                [offerId]
            );

            await client.query(
                `UPDATE bookings
                 SET status = 'pending', updated_at = NOW()
                 WHERE id = $1 AND status = 'offered'`,
                [offer.booking_id]
            );

            await client.query("COMMIT");
            return { declined: true, booking_id: offer.booking_id };
        }

        // ---- Accepting ------------------------------------------------------
        const bookingResult = await client.query(
            `SELECT b.*, vc.code AS vehicle_class_code, vc.name AS vehicle_class_name
             FROM bookings b
             LEFT JOIN vehicle_classes vc ON vc.id = b.vehicle_class_id
             WHERE b.id = $1
             FOR UPDATE OF b`,
            [offer.booking_id]
        );
        const booking = bookingResult.rows[0];

        if (!booking || booking.status !== BOOKING_STATUS.OFFERED) {
            await client.query("ROLLBACK");
            return {
                error: "BOOKING_MOVED_ON",
                message: "This job is no longer available"
            };
        }

        const driver = await loadAssignableDriver(client, driverId, booking);
        const refusal = reasonDriverCannotTake(driver, booking);

        // Checked again at the moment of accepting, not only when offering. A
        // document can expire between the two, and a driver whose licence ran
        // out overnight must not pick up a client in the morning.
        if (refusal) {
            await client.query("ROLLBACK");
            return { error: "DRIVER_UNAVAILABLE", message: refusal };
        }

        const chosenVehicle = vehicleId || driver.vehicle_id;

        await client.query(
            `UPDATE booking_offers
             SET status = 'accepted', responded_at = NOW()
             WHERE id = $1`,
            [offerId]
        );

        await client.query(
            `UPDATE bookings
             SET status = 'accepted',
                 driver_id = $2,
                 vehicle_id = $3,
                 accepted_at = NOW(),
                 is_open_to_all = FALSE,
                 updated_at = NOW()
             WHERE id = $1`,
            [offer.booking_id, driverId, chosenVehicle]
        );

        await client.query("COMMIT");
        return { accepted: true, booking_id: offer.booking_id };

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        throw error;

    } finally {
        client.release();
    }
};

// A driver takes a job out of the open pool.
//
// The whole thing turns on one UPDATE with `status = 'pending' AND
// is_open_to_all` in its WHERE. Whoever's statement runs first changes the
// row; the second finds nothing to change and is told the job has gone. There
// is no window between checking and acting, because there is no separate
// check.
const claimOpenJob = async (driverId, bookingId, vehicleId = null) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const bookingResult = await client.query(
            `SELECT b.*, vc.code AS vehicle_class_code, vc.name AS vehicle_class_name
             FROM bookings b
             LEFT JOIN vehicle_classes vc ON vc.id = b.vehicle_class_id
             WHERE b.id = $1
             FOR UPDATE OF b`,
            [bookingId]
        );
        const booking = bookingResult.rows[0];

        if (!booking) {
            await client.query("ROLLBACK");
            return { error: "NOT_FOUND", message: "Job not found" };
        }

        if (!booking.is_open_to_all || booking.status !== BOOKING_STATUS.PENDING) {
            await client.query("ROLLBACK");
            return {
                error: "JOB_TAKEN",
                message: "Another driver has taken this job"
            };
        }

        const driver = await loadAssignableDriver(client, driverId, booking);
        const refusal = reasonDriverCannotTake(driver, booking);

        if (refusal) {
            await client.query("ROLLBACK");
            return { error: "DRIVER_UNAVAILABLE", message: refusal };
        }

        const chosenVehicle = vehicleId || driver.vehicle_id;

        const claimed = await client.query(
            `UPDATE bookings
             SET status = 'accepted',
                 driver_id = $2,
                 vehicle_id = $3,
                 accepted_at = NOW(),
                 is_open_to_all = FALSE,
                 updated_at = NOW()
             WHERE id = $1 AND status = 'pending' AND is_open_to_all
             RETURNING id`,
            [bookingId, driverId, chosenVehicle]
        );

        if (claimed.rows.length === 0) {
            await client.query("ROLLBACK");
            return { error: "JOB_TAKEN", message: "Another driver has taken this job" };
        }

        // The claim is recorded as an offer too, so that "how did this driver
        // get this job?" has one answer to look up rather than two.
        await client.query(
            `INSERT INTO booking_offers (booking_id, driver_id, status, responded_at)
             VALUES ($1, $2, 'accepted', NOW())`,
            [bookingId, driverId]
        );

        await client.query("COMMIT");
        return { claimed: true, booking_id: bookingId };

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        throw error;

    } finally {
        client.release();
    }
};

// -----------------------------------------------------------------------------
// The journey
// -----------------------------------------------------------------------------

// On way → Arrived → passenger on board → Completed.
//
// The step is refused if it is not the next one. A driver who taps Completed
// from the pickup would otherwise leave a booking with no arrival time and no
// journey time, and neither can be reconstructed afterwards.
const updateJobStatus = async (driverId, bookingId, nextStatus) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const result = await client.query(
            "SELECT * FROM bookings WHERE id = $1 FOR UPDATE",
            [bookingId]
        );
        const booking = result.rows[0];

        if (!booking || booking.driver_id !== driverId) {
            await client.query("ROLLBACK");
            return { error: "NOT_FOUND", message: "No job with that id" };
        }

        if (!canTransition(booking.status, nextStatus)) {
            await client.query("ROLLBACK");
            return {
                error: "INVALID_TRANSITION",
                message: `A job that is "${booking.status}" cannot move to "${nextStatus}"`,
                current_status: booking.status
            };
        }

        const timestampColumn = DRIVER_STATUS_STEPS[nextStatus];

        await client.query(
            `UPDATE bookings
             SET status = $2,
                 ${timestampColumn} = NOW(),
                 updated_at = NOW()
             WHERE id = $1`,
            [bookingId, nextStatus]
        );

        await client.query("COMMIT");
        return { updated: true, status: nextStatus };

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        throw error;

    } finally {
        client.release();
    }
};

module.exports = {
    loadAssignableDriver,
    reasonDriverCannotTake,
    expireDueOffers,
    offerToDriver,
    withdrawOffer,
    publishToPool,
    unpublishFromPool,
    respondToOffer,
    claimOpenJob,
    updateJobStatus
};