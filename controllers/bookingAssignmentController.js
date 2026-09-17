const pool = require("../config/db");
const offers = require("../services/bookingOffers");
const { toBooking, BOOKING_SELECT, BOOKING_JOINS } = require("../services/bookingValidation");
const { maskDriverContact } = require("../utils/masking");
const {
    notifyJobOffered,
    notifyOfferWithdrawn,
    notifyJobPublished
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
//
// The four tabs on the assignment screen. They are filters over one list, not
// four different lists — a driver can be on the fleet AND a favourite, and
// counting them twice would be wrong.
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

        // The car has to be the right class — by id, not by the old free-text
        // column, which nobody ever typed the same way twice. Deliberately
        // blind to who owns the car.
        params.push(booking.vehicle_class_id || null);
        const classParam = `$${params.length}`;

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
              AND (${classParam}::int IS NULL OR v.vehicle_class_id = ${classParam}::int)
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
                vehicle_class: booking.vehicle_class_name,
                status: booking.status
            },

            tab,

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
                    vehicle_class: d.vehicle_class,
                    owner_type: d.owner_type
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
// open pool and any online driver with the right class of car can take it.
const publishBooking = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid booking id" });
        }

        const published = await offers.publishToPool(Number(id));

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
                            AND ($2::int IS NULL OR v.vehicle_class_id = $2)
             WHERE u.role = 'driver'
               AND u.status = 'approved'
               AND u.suspension_reason IS DISTINCT FROM 'document_expired'
               AND u.id <> $1`,
            [req.user.id, booking.vehicle_class_id || null]
        );

        for (const row of eligible.rows) {
            notifyJobPublished(row.id, Number(id));
        }

        res.status(200).json({
            message: "Booking published to available drivers",
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

module.exports = {
    getAvailableDrivers,
    offerBooking,
    withdrawBookingOffer,
    publishBooking,
    unpublishBooking
};