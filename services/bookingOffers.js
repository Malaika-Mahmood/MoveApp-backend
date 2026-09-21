const pool = require("../config/db");
const {
    BOOKING_STATUS,
    OFFER_STATUS,
    OFFER_KIND,
    FARE_MODE,
    isValidAmount,
    toAmount,
    offerTimeoutFor,
    canTransition,
    DRIVER_STATUS_STEPS
} = require("../constants/bookings");
const { reasonVehicleCannotFit } = require("./bookingValidation");

// Getting a job from an operator to a driver, and through to the end of the
// journey.
//
// Two routes in, and they are genuinely different:
//
//   An OFFER goes to one named driver. This is how a chauffeur firm works — a
//   regular client gets the driver they know, and the operator picks them.
//
//   A PUBLISHED job sits in the open pool and any driver whose car fits may
//   BID on it. A bid is not a claim — it says "I will take this, at this
//   price". The operator reads the bids and chooses. This is what fills the
//   gaps at 2am, and it is what changed on 21 September: until then the first
//   driver to tap won the job and the operator was not asked.
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
// The vehicle matters as much as the driver: the car has to have passed
// verification and it has to hold the people and the luggage. This is also the
// only place the fleet question is settled — a company car and an outside
// driver's car are judged by exactly the same rule.
//
// The join deliberately does NOT filter on capacity. It loads the driver's
// approved, available car and lets reasonDriverCannotTake say what is wrong
// with it.
//
// Filtering here instead would return vehicle_id null, and the operator would
// be told "that driver has no approved vehicle" — which is untrue, and sends
// them hunting for a document problem that does not exist. "That car seats 4,
// and this job is for 7" is the sentence they can act on.
const loadAssignableDriver = async (client, driverId) => {
    const result = await client.query(
        `SELECT u.id, u.first_name, u.last_name, u.status,
                u.suspension_reason, u.is_online,
                v.id AS vehicle_id, v.registration_number, v.vehicle_class,
                v.seats, v.luggage_large, v.luggage_small
         FROM users u
         LEFT JOIN vehicles v
                ON v.driver_id = u.id
               AND v.verification_status = 'approved'
               AND v.availability_status <> 'inactive'
         WHERE u.id = $1 AND u.role = 'driver'
         ORDER BY v.id ASC
         LIMIT 1`,
        [driverId]
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
        return "That driver has no approved vehicle";
    }

    // Capacity last, because it is the only refusal the operator can do
    // something about — a bigger car, or a word with the client about the
    // luggage. The sentence names both numbers so they do not have to go and
    // look either of them up.
    //
    // A car with no recorded capacity passes. The operator can see it is
    // unrecorded on the assignment screen and decide for themselves; refusing
    // here would block a job over a blank field.
    return reasonVehicleCannotFit(
        {
            seats: driver.seats,
            luggage_large: driver.luggage_large,
            luggage_small: driver.luggage_small
        },
        booking
    );
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
            `SELECT b.*
             FROM bookings b
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

        const driver = await loadAssignableDriver(client, driverId);
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
//
// `pricing` is optional and carries what the operator typed on the Fare
// Details screen:
//
//   { mode: 'fixed',   amount: 100 }        one price, take it or leave it
//   { mode: 'bidding', low: 85, high: 110 } a window for drivers to bid in
//
// Omitted entirely, the booking keeps whatever pricing it already had — an
// operator republishing a job they pulled back should not have to retype the
// amount.
const publishToPool = async (bookingId, pricing = null) => {
    const sets = [
        "is_open_to_all = TRUE",
        "published_at = NOW()",
        "updated_at = NOW()"
    ];
    const params = [bookingId];

    if (pricing) {
        if (pricing.mode === FARE_MODE.BIDDING) {
            params.push(toAmount(pricing.low), toAmount(pricing.high));
            sets.push(`fare_mode = '${FARE_MODE.BIDDING}'`);
            sets.push(`bid_low = $${params.length - 1}`);
            sets.push(`bid_high = $${params.length}`);
            // A job cannot be both. Clearing the other side means nothing can
            // read a stale fixed price off a bidding job later.
            sets.push("fixed_amount = NULL");

        } else {
            params.push(toAmount(pricing.amount));
            sets.push(`fare_mode = '${FARE_MODE.FIXED}'`);
            sets.push(`fixed_amount = $${params.length}`);
            sets.push("bid_low = NULL", "bid_high = NULL");
        }
    }

    const result = await pool.query(
        `UPDATE bookings
         SET ${sets.join(", ")}
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        params
    );

    return result.rows[0] || null;
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
            `SELECT b.*
             FROM bookings b
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

        const driver = await loadAssignableDriver(client, driverId);
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
// -----------------------------------------------------------------------------
// Bidding
// -----------------------------------------------------------------------------
// This replaces claimOpenJob, and the difference is the whole point.
//
// Before: the first driver to tap Claim got the booking, and the operator
// found out afterwards. The operator told us on 21 September that this is not
// how the office works — they look at who has put their hand up and they
// decide, because the fastest tap is not always the right driver for that
// client.
//
// So a driver's "I'll take it" is now a BID. It records that they are willing,
// at a price where there is one. It does not move the booking. Only
// acceptBid does that, and only an operator can call it.

// Why a driver cannot bid on this job. Null means they can.
const reasonCannotBid = (booking, driver, amount) => {
    if (!booking) return { error: "NOT_FOUND", message: "Job not found" };

    if (!booking.is_open_to_all || booking.status !== BOOKING_STATUS.PENDING) {
        return { error: "JOB_TAKEN", message: "This job is no longer open" };
    }

    const refusal = reasonDriverCannotTake(driver, booking);
    if (refusal) return { error: "DRIVER_UNAVAILABLE", message: refusal };

    // Fixed fare: there is nothing to name. The driver is saying yes to the
    // operator's number, and sending an amount would suggest otherwise.
    if (booking.fare_mode !== FARE_MODE.BIDDING) {
        return amount === null || amount === undefined
            ? null
            : {
                error: "NOT_A_BIDDING_JOB",
                message: "This job has a fixed price — accept it or leave it"
            };
    }

    if (amount === null || amount === undefined) {
        return { error: "AMOUNT_REQUIRED", message: "Enter what you will do this job for" };
    }

    if (!isValidAmount(amount)) {
        return { error: "INVALID_AMOUNT", message: "That is not a valid amount" };
    }

    // Inside the window. The driver's screen has plus and minus buttons that
    // stop at both ends, so a value outside it means something went wrong —
    // but the server says so anyway, because the screen is not the guard.
    const low = booking.bid_low === null ? null : Number(booking.bid_low);
    const high = booking.bid_high === null ? null : Number(booking.bid_high);

    if (low !== null && amount < low) {
        return {
            error: "BID_TOO_LOW",
            message: `Bids on this job start at ${low}`
        };
    }

    if (high !== null && amount > high) {
        return {
            error: "BID_TOO_HIGH",
            message: `Bids on this job go up to ${high}`
        };
    }

    return null;
};

// A driver putting their hand up.
//
// One live bid per driver per booking. Bidding again replaces the amount
// rather than adding a second row — which is also how the driver changes their
// mind, without a separate endpoint for it.
const placeBid = async (driverId, bookingId, amount = null) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const bookingResult = await client.query(
            `SELECT b.* FROM bookings b WHERE b.id = $1 FOR SHARE`,
            [bookingId]
        );
        const booking = bookingResult.rows[0];

        const driver = await loadAssignableDriver(client, driverId);
        const clean = amount === null || amount === undefined ? null : toAmount(amount);

        const refusal = reasonCannotBid(booking, driver, clean);

        if (refusal) {
            await client.query("ROLLBACK");
            return refusal;
        }

        // ON CONFLICT rather than checking first. Two taps a millisecond apart
        // would both pass a check-then-insert; the unique index from migration
        // 019 cannot be fooled that way.
        const bid = await client.query(
            `INSERT INTO booking_offers
                 (booking_id, driver_id, offer_kind, amount, status, offered_at)
             VALUES ($1, $2, $3, $4, 'pending', NOW())
             ON CONFLICT (booking_id, driver_id)
             WHERE offer_kind = 'bid' AND status = 'pending'
             DO UPDATE SET amount = EXCLUDED.amount, offered_at = NOW()
             RETURNING *`,
            [bookingId, driverId, OFFER_KIND.BID, clean]
        );

        await client.query("COMMIT");

        return {
            bid: bid.rows[0],
            booking_id: bookingId,
            operator_id: booking.created_by_operator_id,
            reference: booking.reference
        };

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        throw error;

    } finally {
        client.release();
    }
};

// A driver taking their bid back.
const withdrawBid = async (driverId, bidId) => {
    const result = await pool.query(
        `UPDATE booking_offers
         SET status = $3, responded_at = NOW()
         WHERE id = $1 AND driver_id = $2
           AND offer_kind = $4 AND status = 'pending'
         RETURNING booking_id`,
        [bidId, driverId, OFFER_STATUS.WITHDRAWN, OFFER_KIND.BID]
    );

    return result.rows[0] || null;
};

// Every bid on a booking, cheapest first — the order the operator's screen is
// headed with.
//
// A bid with no amount (a fixed-fare job) sorts first: the driver has agreed
// to the operator's number, which is as good as it gets.
const listBids = async (bookingId) => {
    const result = await pool.query(
        `SELECT o.id, o.amount, o.status, o.offered_at, o.responded_at,
                u.id AS driver_id, u.first_name, u.last_name,
                u.is_online, u.rating_average, u.rating_count, u.completed_trips,
                v.id AS vehicle_id, v.registration_number, v.make, v.model,
                v.seats, v.luggage_large, v.luggage_small,
                (cf.driver_id IS NOT NULL) AS is_fleet
           FROM booking_offers o
           JOIN users u ON u.id = o.driver_id
           LEFT JOIN vehicles v
                  ON v.driver_id = u.id
                 AND v.verification_status = 'approved'
                 AND v.availability_status <> 'inactive'
           LEFT JOIN company_drivers cf
                  ON cf.driver_id = u.id AND cf.removed_at IS NULL
          WHERE o.booking_id = $1 AND o.offer_kind = $2
          ORDER BY (o.status = 'pending') DESC,
                   o.amount ASC NULLS FIRST,
                   o.offered_at ASC`,
        [bookingId, OFFER_KIND.BID]
    );

    return result.rows;
};

// The operator choosing.
//
// Everything that matters happens here, in one transaction: the booking is
// locked, the winner is written, every other live bid is closed, and the
// booking leaves the pool. Half of that landing without the other half would
// mean two drivers each believing the job is theirs.
const acceptBid = async (bookingId, bidId) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const bookingResult = await client.query(
            "SELECT * FROM bookings WHERE id = $1 FOR UPDATE",
            [bookingId]
        );
        const booking = bookingResult.rows[0];

        if (!booking) {
            await client.query("ROLLBACK");
            return { error: "NOT_FOUND", message: "Booking not found" };
        }

        if (booking.status !== BOOKING_STATUS.PENDING) {
            await client.query("ROLLBACK");
            return {
                error: "CANNOT_ASSIGN",
                message: `A ${booking.status} booking cannot be assigned`,
                current_status: booking.status
            };
        }

        const bidResult = await client.query(
            `SELECT * FROM booking_offers
              WHERE id = $1 AND booking_id = $2 AND offer_kind = $3
              FOR UPDATE`,
            [bidId, bookingId, OFFER_KIND.BID]
        );
        const bid = bidResult.rows[0];

        if (!bid) {
            await client.query("ROLLBACK");
            return { error: "NOT_FOUND", message: "No such bid on this booking" };
        }

        if (bid.status !== OFFER_STATUS.PENDING) {
            await client.query("ROLLBACK");
            return {
                error: "BID_NOT_LIVE",
                message: bid.status === OFFER_STATUS.WITHDRAWN
                    ? "That driver has taken their bid back"
                    : `That bid is ${bid.status}`,
                bid_status: bid.status
            };
        }

        // Checked again, now, rather than trusting the list the operator was
        // looking at. Minutes may have passed; the driver could have been
        // suspended, or had a document expire, since the screen was drawn.
        const driver = await loadAssignableDriver(client, bid.driver_id);
        const refusal = reasonDriverCannotTake(driver, booking);

        if (refusal) {
            await client.query("ROLLBACK");
            return { error: "DRIVER_UNAVAILABLE", message: refusal };
        }

        // What the job was agreed at. On a fixed-fare job the bid carries no
        // amount, so it is the operator's own number.
        const agreed = bid.amount !== null && bid.amount !== undefined
            ? bid.amount
            : booking.fixed_amount;

        await client.query(
            `UPDATE bookings
             SET status = 'accepted',
                 driver_id = $2,
                 vehicle_id = $3,
                 agreed_amount = $4,
                 accepted_at = NOW(),
                 is_open_to_all = FALSE,
                 updated_at = NOW()
             WHERE id = $1`,
            [bookingId, bid.driver_id, driver.vehicle_id, agreed]
        );

        await client.query(
            `UPDATE booking_offers
             SET status = $2, responded_at = NOW()
             WHERE id = $1`,
            [bidId, OFFER_STATUS.ACCEPTED]
        );

        // Everybody else is told, in the same breath. 'lost' rather than
        // 'rejected': they were not turned down, somebody else was chosen.
        const others = await client.query(
            `UPDATE booking_offers
             SET status = $3, responded_at = NOW()
             WHERE booking_id = $1 AND id <> $2
               AND offer_kind = $4 AND status = 'pending'
             RETURNING driver_id`,
            [bookingId, bidId, OFFER_STATUS.LOST, OFFER_KIND.BID]
        );

        await client.query("COMMIT");

        return {
            assigned: true,
            booking_id: bookingId,
            driver_id: bid.driver_id,
            amount: agreed,
            reference: booking.reference,
            lost_driver_ids: others.rows.map((r) => r.driver_id)
        };

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        throw error;

    } finally {
        client.release();
    }
};

// The operator saying no to one bid without closing the job.
//
// The driver is free to come back with a different number — which is usually
// the point, since "too expensive" is the commonest reason to reject.
const rejectBid = async (bookingId, bidId) => {
    const result = await pool.query(
        `UPDATE booking_offers
         SET status = $3, responded_at = NOW()
         WHERE id = $1 AND booking_id = $2
           AND offer_kind = $4 AND status = 'pending'
         RETURNING driver_id, amount`,
        [bidId, bookingId, OFFER_STATUS.REJECTED, OFFER_KIND.BID]
    );

    return result.rows[0] || null;
};

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

        // "847 trips" on the driver's profile.
        //
        // Counted here, inside the same transaction as the status change, so
        // the number can never disagree with the bookings it is counting. A
        // separate UPDATE afterwards could fail on its own and leave a driver
        // permanently one trip short, which is the kind of thing a driver
        // notices and nobody can explain.
        //
        // Only on completion. Accepting a job is not doing one, and a job
        // cancelled halfway must not count — the transition rules above make
        // completed a one-way door, so this cannot run twice for the same job.
        if (nextStatus === BOOKING_STATUS.COMPLETED) {
            await client.query(
                `UPDATE users
                    SET completed_trips = completed_trips + 1,
                        updated_at = NOW()
                  WHERE id = $1`,
                [driverId]
            );
        }

        await client.query("COMMIT");

        return {
            updated: true,
            status: nextStatus,

            // Told to the caller so it can send both sides their "how did it
            // go?" notification. Raised in the controller rather than here:
            // this file's job is the database, notifications are a side
            // effect and belong outside the transaction.
            completed: nextStatus === BOOKING_STATUS.COMPLETED,
            booking: {
                id: booking.id,
                reference: booking.reference,
                operator_id: booking.created_by_operator_id
            }
        };

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

    reasonCannotBid,
    placeBid,
    withdrawBid,
    listBids,
    acceptBid,
    rejectBid,
    updateJobStatus
};