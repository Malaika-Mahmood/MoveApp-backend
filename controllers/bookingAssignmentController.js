const pool = require("../config/db");
const offers = require("../services/bookingOffers");
const {
    toBooking,
    BOOKING_SELECT,
    BOOKING_JOINS,
    vehicleFits,
    capacityKnown
} = require("../services/bookingValidation");
const { maskDriverContact } = require("../utils/masking");
const {
    FARE_MODE,
    ALL_FARE_MODES,
    isValidAmount,
    toAmount
} = require("../constants/bookings");
const {
    notifyJobOffered,
    notifyOfferWithdrawn,
    notifyJobPublished,
    notifyBidAccepted,
    notifyBidRejected,
    notifyBidLost
} = require("../services/appNotifications");

// The operator's side of getting a booking to a driver: who is available,
// offer it, take it back, or throw it open.

const loadBooking = async (id) => {
    const result = await pool.query(
        `SELECT ${BOOKING_SELECT} ${BOOKING_JOINS} WHERE b.id = $1`,
        [id]
    );
    return result.rows[0] || null;
};

// -----------------------------------------------------------------------------
// GET /api/v1/operator/bookings/:id/available-drivers
// -----------------------------------------------------------------------------
// ?tab=all|favourites|fleet|external
// ?search=ahmed          a name, or part of a registration number
//
// The four tabs on the assignment screen. They are filters over one list, not
// four different lists — a driver can be on the fleet AND a favourite, and
// counting them twice would be wrong.
//
// Search narrows whichever tab is open rather than replacing it: an operator
// typing a name while Favourites is selected means "which of my favourites is
// this", not "search everybody".
const getAvailableDrivers = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid booking id" });
        }

        const booking = await loadBooking(Number(id));
        if (!booking) {
            return res.status(404).json({ message: "Booking not found", error_code: "NOT_FOUND" });
        }

        const tab = ["all", "favourites", "fleet", "external"].includes(req.query.tab)
            ? req.query.tab
            : "all";

        const where = [
            "u.role = 'driver'",
            "u.status = 'approved'",
            // A driver locked out by an expired document is not offerable. They
            // can still open the app, but only to fix the document.
            "u.suspension_reason IS DISTINCT FROM 'document_expired'"
        ];
        const params = [];

        if (tab === "fleet") {
            where.push("cf.driver_id IS NOT NULL");
        } else if (tab === "external") {
            where.push("cf.driver_id IS NULL");
        }

        params.push(req.user.id);
        const operatorParam = `$${params.length}`;

        if (tab === "favourites") {
            where.push("fav.driver_id IS NOT NULL");
        }

        // The search box above the list.
        //
        // Matched against first name, last name, the two joined, and the
        // registration number — because an operator looking for a particular
        // driver thinks in whichever of those they happen to remember, and
        // often it is the car.
        //
        // The "two joined" case is the one that is easy to leave out: without
        // it, typing "ali khan" matches nobody, since no single column holds
        // both halves.
        //
        // Contact details are deliberately not searchable. An operator can see
        // a driver's number once the job is theirs; letting the whole driver
        // list be probed by phone number is a different thing.
        //
        // Bound as a parameter, never interpolated. ILIKE with a user-supplied
        // string glued into SQL is exactly how an injection gets in.
        const search = String(req.query.search || "").trim();

        if (search.length > 0) {
            // % and _ are wildcards to ILIKE. A driver whose name really does
            // contain one is unlikely, but an operator pasting a stray % and
            // getting the entire list back is a confusing five minutes.
            const term = `%${search.replace(/[%_\\]/g, "\\$&")}%`;

            params.push(term);
            const searchParam = `$${params.length}`;

            where.push(`(
                u.first_name ILIKE ${searchParam} ESCAPE '\\'
                OR u.last_name ILIKE ${searchParam} ESCAPE '\\'
                OR (u.first_name || ' ' || u.last_name) ILIKE ${searchParam} ESCAPE '\\'
                OR v.registration_number ILIKE ${searchParam} ESCAPE '\\'
            )`);
        }

        const result = await pool.query(
            `SELECT u.id, u.first_name, u.last_name, u.email, u.phone,
                    u.is_online, u.last_online_at,
                    -- Read from the columns rather than counted here. With a
                    -- hundred drivers on this screen, one COUNT per driver per
                    -- request is the query that makes the assignment screen
                    -- unusable once the firm grows. See migration 016.
                    u.rating_average, u.rating_count, u.completed_trips,
                    v.id AS vehicle_id, v.registration_number, v.make, v.model,
                    v.vehicle_class, v.owner_type,
                    v.seats, v.luggage_large, v.luggage_small,
                    (cf.driver_id IS NOT NULL)  AS is_fleet,
                    (fav.driver_id IS NOT NULL) AS is_favourite,
                    (SELECT COUNT(*)::int FROM bookings jb
                      WHERE jb.driver_id = u.id
                        AND jb.status NOT IN ('completed','cancelled')) AS active_jobs,
                    (SELECT COUNT(*)::int FROM bookings jb
                      WHERE jb.driver_id = u.id
                        AND jb.completed_at::date = CURRENT_DATE) AS trips_today
             FROM users u
             JOIN vehicles v
               ON v.driver_id = u.id
              AND v.verification_status = 'approved'
              AND v.availability_status <> 'inactive'
              -- The car has to actually hold the people and the luggage. Not a
              -- class name — the real numbers, which mean the same thing to
              -- everybody. A car whose capacity nobody has recorded still
              -- appears, flagged; see the note in bookingValidation.js.
              AND ${vehicleFits("v", booking)}
             LEFT JOIN company_drivers cf
               ON cf.driver_id = u.id AND cf.removed_at IS NULL
             LEFT JOIN operator_favourite_drivers fav
               ON fav.driver_id = u.id AND fav.operator_id = ${operatorParam}
             WHERE ${where.join(" AND ")}
             -- Online first, then favourites, then the best rated. An operator
             -- scanning this list top to bottom should meet the driver they
             -- would have rung first anyway.
             --
             -- NULLS LAST matters: a driver with no ratings yet sorts below
             -- rated drivers rather than above them, which is what a bare
             -- DESC would do.
             ORDER BY u.is_online DESC,
                      (fav.driver_id IS NOT NULL) DESC,
                      u.rating_average DESC NULLS LAST,
                      u.first_name ASC
             LIMIT 100`,
            params
        );

        res.status(200).json({
            booking: {
                id: booking.id,
                reference: booking.reference,
                status: booking.status,

                // What the list was filtered on, repeated back so the screen
                // can say "showing cars for 6 passengers and 5 bags" instead of
                // leaving the operator to wonder why somebody is missing.
                passengers: booking.passengers,
                large_bags: booking.large_bags,
                small_bags: booking.small_bags,

                // What the client asked for, if they asked for anything. The
                // one thing on this screen the system cannot check — the
                // operator has to read it.
                requested_vehicle: booking.requested_vehicle || null
            },

            tab,

            // Echoed back so a screen showing three drivers can say "3 results
            // for 'ali'" rather than leaving the operator to wonder where
            // everybody went. Empty search comes back as null, not "".
            search: search.length > 0 ? search : null,

            drivers: result.rows.map((d) => ({
                // The operator sees the driver's name and everything about
                // their fitness for the job — but not their number. Talking to
                // them goes through the app.
                ...maskDriverContact({
                    id: d.id,
                    first_name: d.first_name,
                    last_name: d.last_name,
                    full_name: [d.first_name, d.last_name].filter(Boolean).join(" "),
                    email: d.email,
                    phone: d.phone
                }, req.user.role),

                is_online: d.is_online,
                last_online_at: d.last_online_at,
                is_fleet: d.is_fleet,
                is_favourite: d.is_favourite,
                active_jobs: d.active_jobs,
                trips_today: d.trips_today,

                // NULL, not 0, for a driver nobody has rated yet — so the app
                // can show "New" instead of what looks like a zero-star
                // driver. Converted from pg's NUMERIC string so the app is
                // not handed "4.20" to do arithmetic on.
                rating_average: d.rating_average === null ? null : Number(d.rating_average),
                rating_count: d.rating_count,
                completed_trips: d.completed_trips,

                vehicle: {
                    id: d.vehicle_id,
                    registration_number: d.registration_number,
                    make: d.make,
                    model: d.model,
                    // Free text the driver typed. Shown because an operator
                    // reads "V Class" and knows what it means, but never
                    // matched on — that was the September bug.
                    vehicle_class: d.vehicle_class,
                    owner_type: d.owner_type,

                    seats: d.seats,
                    luggage_large: d.luggage_large,
                    luggage_small: d.luggage_small,

                    // False when nobody has recorded what this car holds. The
                    // car is still on the list — hiding it is how drivers
                    // vanish without explanation — but the screen should mark
                    // it so the operator knows to check before sending it.
                    capacity_known: capacityKnown(d)
                }
            }))
        });

    } catch (error) {
        console.error("Error in getAvailableDrivers:", error);
        res.status(500).json({ message: "Something went wrong while fetching drivers" });
    }
};

// -----------------------------------------------------------------------------
// POST /api/v1/operator/bookings/:id/offer   { "driver_id": 7 }
// -----------------------------------------------------------------------------
const offerBooking = async (req, res) => {
    try {
        const { id } = req.params;
        const { driver_id } = req.body || {};

        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid booking id" });
        }

        if (!driver_id || !/^\d+$/.test(String(driver_id))) {
            return res.status(400).json({
                message: "driver_id is required",
                error_code: "MISSING_FIELDS"
            });
        }

        const result = await offers.offerToDriver(Number(id), Number(driver_id), req.user.id);

        if (result.error) {
            const status = result.error === "NOT_FOUND" ? 404
                : result.error === "DRIVER_UNAVAILABLE" ? 409
                    : 409;

            return res.status(status).json({
                message: result.message,
                error_code: result.error
            });
        }

        notifyJobOffered(Number(driver_id), Number(id), result.offer.id, result.expires_in_minutes);

        res.status(200).json({
            message: result.expires_in_minutes
                ? `Sent to the driver. They have ${result.expires_in_minutes} minutes to respond.`
                : "Sent to the driver.",
            offer: {
                id: result.offer.id,
                driver: {
                    id: result.driver.id,
                    full_name: [result.driver.first_name, result.driver.last_name]
                        .filter(Boolean).join(" ")
                },
                status: result.offer.status,
                offered_at: result.offer.offered_at,
                expires_at: result.offer.expires_at
            },

            // Worth saying out loud. An operator working down a list can
            // easily land on somebody who already said no.
            previously_declined: result.previously_declined
        });

    } catch (error) {
        console.error("Error in offerBooking:", error);
        res.status(500).json({ message: "Something went wrong while offering the booking" });
    }
};

// -----------------------------------------------------------------------------
// DELETE /api/v1/operator/bookings/:id/offer
// -----------------------------------------------------------------------------
// The driver is not answering, or the client asked for somebody else.
//
// This is what stands in for a timeout on a scheduled job: there is no clock,
// the operator decides when they have waited long enough. The app shows them
// how long it has been.
const withdrawBookingOffer = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid booking id" });
        }

        const result = await offers.withdrawOffer(Number(id));

        if (result.error) {
            return res.status(409).json({ message: result.message, error_code: result.error });
        }

        for (const row of result.withdrawn) {
            notifyOfferWithdrawn(row.driver_id, Number(id));
        }

        res.status(200).json({
            message: "Offer withdrawn. The booking is unassigned again.",
            withdrawn_from: result.withdrawn.map((r) => r.driver_id)
        });

    } catch (error) {
        console.error("Error in withdrawBookingOffer:", error);
        res.status(500).json({ message: "Something went wrong while withdrawing the offer" });
    }
};

// -----------------------------------------------------------------------------
// POST /api/v1/operator/bookings/:id/publish
// DELETE /api/v1/operator/bookings/:id/publish
// -----------------------------------------------------------------------------
// "Skip — Save as Unassigned" on the designer's screen. The job goes into the
// open pool, where any driver whose car actually holds the passengers and the
// luggage can bid for it.
//
// The body carries what the operator typed on the Fare Details screen, and is
// optional — a job republished after being pulled back keeps the pricing it
// already had:
//
//   { "fare_mode": "fixed",   "amount": 100 }
//   { "fare_mode": "bidding", "bid_low": 85, "bid_high": 110 }
const publishBooking = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid booking id" });
        }

        const body = req.body || {};
        let pricing = null;

        if (body.fare_mode !== undefined) {
            if (!ALL_FARE_MODES.includes(body.fare_mode)) {
                return res.status(400).json({
                    message: `fare_mode must be one of: ${ALL_FARE_MODES.join(", ")}`,
                    error_code: "INVALID_FARE_MODE"
                });
            }

            if (body.fare_mode === FARE_MODE.BIDDING) {
                const low = toAmount(body.bid_low);
                const high = toAmount(body.bid_high);

                if (low === null || high === null) {
                    return res.status(400).json({
                        message: "A bidding job needs both bid_low and bid_high",
                        error_code: "RANGE_REQUIRED"
                    });
                }

                if (!isValidAmount(low) || !isValidAmount(high)) {
                    return res.status(400).json({
                        message: "Those are not valid amounts",
                        error_code: "INVALID_AMOUNT"
                    });
                }

                if (low > high) {
                    return res.status(400).json({
                        message: "The lowest bid cannot be above the highest",
                        error_code: "RANGE_BACKWARDS"
                    });
                }

                pricing = { mode: FARE_MODE.BIDDING, low, high };

            } else {
                const amount = toAmount(body.amount);

                // A fixed-fare job with no amount is allowed. The operator
                // interview was explicit: jobs are sometimes handed out with
                // no number attached and sorted out afterwards.
                if (amount !== null && !isValidAmount(amount)) {
                    return res.status(400).json({
                        message: "That is not a valid amount",
                        error_code: "INVALID_AMOUNT"
                    });
                }

                pricing = { mode: FARE_MODE.FIXED, amount };
            }
        }

        const published = await offers.publishToPool(Number(id), pricing);

        if (!published) {
            return res.status(409).json({
                message: "Only an unassigned booking can be published",
                error_code: "CANNOT_PUBLISH"
            });
        }

        const booking = await loadBooking(Number(id));

        // Told to every driver who could actually take it — online or not.
        //
        // This used to be online drivers only. The CEO's decision on 16
        // September was that a driver sitting at home must still see what work
        // is coming in, and a driver who is not told cannot see it. The
        // notification simply waits in their inbox until they next open the
        // app, which is exactly what somebody browsing from home wants.
        //
        // Still filtered by whether the car fits. Buzzing a driver about jobs
        // they cannot take is how drivers learn to ignore notifications.
        const eligible = await pool.query(
            `SELECT DISTINCT u.id
             FROM users u
             JOIN vehicles v ON v.driver_id = u.id
                            AND v.verification_status = 'approved'
                            AND v.availability_status <> 'inactive'
                            AND ${vehicleFits("v", booking)}
             WHERE u.role = 'driver'
               AND u.status = 'approved'
               AND u.suspension_reason IS DISTINCT FROM 'document_expired'
               AND u.id <> $1`,
            [req.user.id]
        );

        for (const row of eligible.rows) {
            notifyJobPublished(row.id, Number(id));
        }

        res.status(200).json({
            message: booking.fare_mode === FARE_MODE.BIDDING
                ? "Booking opened for bids"
                : "Booking published to available drivers",
            booking: toBooking(booking),
            notified_drivers: eligible.rows.length
        });

    } catch (error) {
        console.error("Error in publishBooking:", error);
        res.status(500).json({ message: "Something went wrong while publishing the booking" });
    }
};

const unpublishBooking = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid booking id" });
        }

        const done = await offers.unpublishFromPool(Number(id));

        if (!done) {
            return res.status(409).json({
                message: "Only an unassigned booking can be taken out of the pool",
                error_code: "CANNOT_UNPUBLISH"
            });
        }

        res.status(200).json({ message: "Booking removed from the open pool" });

    } catch (error) {
        console.error("Error in unpublishBooking:", error);
        res.status(500).json({ message: "Something went wrong" });
    }
};


// -----------------------------------------------------------------------------
// GET /api/v1/operator/bookings/:id/bids
// -----------------------------------------------------------------------------
// The screen headed "LOWEST BID (4)". Cheapest first, live bids above settled
// ones, with everything the operator weighs against the number: rating, trips,
// the car, whether they are one of ours, whether they are online.
//
// The cheapest bid is not automatically the right one, which is exactly why
// this screen exists instead of the system deciding.
const getBids = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid booking id" });
        }

        const booking = await loadBooking(Number(id));

        if (!booking) {
            return res.status(404).json({ message: "Booking not found", error_code: "NOT_FOUND" });
        }

        const rows = await offers.listBids(Number(id));

        res.status(200).json({
            booking: {
                id: booking.id,
                reference: booking.reference,
                status: booking.status,
                fare_mode: booking.fare_mode,
                fixed_amount: booking.fixed_amount === null ? null : Number(booking.fixed_amount),
                bid_low: booking.bid_low === null ? null : Number(booking.bid_low),
                bid_high: booking.bid_high === null ? null : Number(booking.bid_high),
                is_open_to_all: booking.is_open_to_all,
                passengers: booking.passengers,
                large_bags: booking.large_bags,
                small_bags: booking.small_bags,
                requested_vehicle: booking.requested_vehicle || null
            },

            bids: rows.map((b) => ({
                id: b.id,
                status: b.status,

                // Null on a fixed-fare job: the driver accepted the operator's
                // own number, so there is nothing of theirs to show.
                amount: b.amount === null ? null : Number(b.amount),

                offered_at: b.offered_at,
                responded_at: b.responded_at,

                driver: {
                    ...maskDriverContact({
                        id: b.driver_id,
                        first_name: b.first_name,
                        last_name: b.last_name,
                        full_name: [b.first_name, b.last_name].filter(Boolean).join(" "),
                        email: null,
                        phone: null
                    }, req.user.role),

                    is_online: b.is_online,
                    is_fleet: b.is_fleet,
                    rating_average: b.rating_average === null ? null : Number(b.rating_average),
                    rating_count: b.rating_count,
                    completed_trips: b.completed_trips
                },

                vehicle: b.vehicle_id
                    ? {
                        id: b.vehicle_id,
                        registration_number: b.registration_number,
                        make: b.make,
                        model: b.model,
                        seats: b.seats,
                        luggage_large: b.luggage_large,
                        luggage_small: b.luggage_small,
                        capacity_known: capacityKnown(b)
                    }
                    : null
            })),

            // Counted here so the screen's heading does not have to filter the
            // list itself and get a different answer.
            live_count: rows.filter((b) => b.status === "pending").length,
            total: rows.length
        });

    } catch (error) {
        console.error("Error in getBids:", error);
        res.status(500).json({ message: "Something went wrong while fetching bids" });
    }
};

// -----------------------------------------------------------------------------
// POST /api/v1/operator/bookings/:id/bids/:bidId/accept
// -----------------------------------------------------------------------------
// The decision. The booking becomes that driver's, every other live bid is
// closed, and the job leaves the pool — all in one transaction, because half
// of that landing would leave two drivers each believing the job is theirs.
const acceptBid = async (req, res) => {
    try {
        const { id, bidId } = req.params;

        if (!/^\d+$/.test(id) || !/^\d+$/.test(bidId)) {
            return res.status(400).json({ message: "Invalid id" });
        }

        const result = await offers.acceptBid(Number(id), Number(bidId));

        if (result.error) {
            const status =
                result.error === "NOT_FOUND" ? 404
                    : 409;

            return res.status(status).json({
                message: result.message,
                error_code: result.error,
                ...(result.current_status ? { current_status: result.current_status } : {}),
                ...(result.bid_status ? { bid_status: result.bid_status } : {})
            });
        }

        notifyBidAccepted(result.driver_id, result.booking_id, result.reference, result.amount);

        // Everybody who did not get it is told in the same breath, so nobody
        // is left watching a bid that will never be answered.
        for (const driverId of result.lost_driver_ids) {
            notifyBidLost(driverId, result.booking_id, result.reference);
        }

        const booking = await loadBooking(Number(id));

        res.status(200).json({
            message: "Job assigned",
            booking: toBooking(booking),
            agreed_amount: result.amount === null ? null : Number(result.amount),
            other_bids_closed: result.lost_driver_ids.length
        });

    } catch (error) {
        console.error("Error in acceptBid:", error);
        res.status(500).json({ message: "Something went wrong while assigning the job" });
    }
};

// -----------------------------------------------------------------------------
// POST /api/v1/operator/bookings/:id/bids/:bidId/reject
// -----------------------------------------------------------------------------
// No to this bid, not to this driver. The job stays open and they may come
// back with a different number — which is usually the point, since the
// commonest reason to reject is that the price is too high.
const rejectBid = async (req, res) => {
    try {
        const { id, bidId } = req.params;

        if (!/^\d+$/.test(id) || !/^\d+$/.test(bidId)) {
            return res.status(400).json({ message: "Invalid id" });
        }

        const booking = await loadBooking(Number(id));

        if (!booking) {
            return res.status(404).json({ message: "Booking not found", error_code: "NOT_FOUND" });
        }

        const rejected = await offers.rejectBid(Number(id), Number(bidId));

        if (!rejected) {
            return res.status(409).json({
                message: "That bid is no longer live",
                error_code: "BID_NOT_LIVE"
            });
        }

        notifyBidRejected(rejected.driver_id, Number(id), booking.reference);

        res.status(200).json({
            message: "Bid rejected. The job is still open.",
            bid_id: Number(bidId)
        });

    } catch (error) {
        console.error("Error in rejectBid:", error);
        res.status(500).json({ message: "Something went wrong" });
    }
};

module.exports = {
    getAvailableDrivers,
    offerBooking,
    withdrawBookingOffer,
    publishBooking,
    unpublishBooking,

    getBids,
    acceptBid,
    rejectBid
};