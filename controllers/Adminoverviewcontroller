const pool = require("../config/db");
const { toBooking, BOOKING_SELECT, BOOKING_JOINS } = require("../services/bookingValidation");
const { BOOKING_STATUS_LABELS } = require("../constants/bookings");
const ratings = require("../services/ratings");

// The admin's view of the whole operation.
//
// A separate file from adminController.js, which is already six hundred lines
// of operator verification. Adding bookings and dashboards to it would make a
// file nobody can read; this one describes a single subject — what an admin
// can see across the firm.
//
// ---------------------------------------------------------------------------
// The rule that makes these endpoints different from every other one
// ---------------------------------------------------------------------------
// Everywhere else in MoveApp, contact details are masked: an operator sees a
// driver's name and never their number. Here they are not. That is the CEO's
// decision and it is the right one — somebody has to be able to ring a driver
// when a client is standing on a pavement at midnight.
//
// The price of that is the log. Opening an individual's record writes a row in
// admin_views saying who looked and when. It is not a permission check and it
// does not slow anything down; it is the answer to "who pulled that number?",
// which otherwise is nobody knows.

// -----------------------------------------------------------------------------
// The log
// -----------------------------------------------------------------------------
// Never awaited and never allowed to throw. A failure to write the log must
// not stop an admin doing their job in the middle of an incident — the failure
// is logged to the console, which is where somebody will look.
const recordView = (adminId, subjectType, subjectId, sawContact = false) => {
    pool.query(
        `INSERT INTO admin_views (admin_id, subject_type, subject_id, saw_contact)
         VALUES ($1, $2, $3, $4)`,
        [adminId, subjectType, subjectId, sawContact]
    ).catch((error) => {
        console.error("admin_views insert failed:", error.message);
    });
};

const fullName = (first, middle, last) =>
    [first, middle, last].filter(Boolean).join(" ");

// Whole minutes, or null when either end is missing. Rounded rather than
// truncated: 89 seconds of waiting is closer to two minutes than to one.
const minutesBetween = (from, to) => {
    if (!from || !to) return null;
    return Math.round((new Date(to) - new Date(from)) / 60000);
};

// -----------------------------------------------------------------------------
// GET /api/v1/admin/dashboard
// -----------------------------------------------------------------------------
// The numbers an admin wants before they have decided what they are looking
// for. One query per figure would be six round trips; this is one.
//
// "Today" is the server's date. Once the firm runs past midnight regularly
// that will need to become a proper London-time day boundary — noted rather
// than guessed at now.
const getDashboard = async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT
                (SELECT COUNT(*)::int FROM bookings
                  WHERE created_at::date = CURRENT_DATE)            AS bookings_today,

                (SELECT COUNT(*)::int FROM bookings
                  WHERE status = 'pending')                          AS unassigned,

                (SELECT COUNT(*)::int FROM bookings
                  WHERE status = 'offered')                          AS awaiting_driver,

                (SELECT COUNT(*)::int FROM bookings
                  WHERE status IN ('accepted','en_route','arrived','in_progress'))
                                                                     AS in_progress,

                (SELECT COUNT(*)::int FROM bookings
                  WHERE completed_at::date = CURRENT_DATE)           AS completed_today,

                (SELECT COUNT(*)::int FROM bookings
                  WHERE cancelled_at::date = CURRENT_DATE)           AS cancelled_today,

                (SELECT COUNT(*)::int FROM users
                  WHERE role = 'driver' AND is_online)               AS drivers_online,

                (SELECT COUNT(*)::int FROM users
                  WHERE role = 'driver' AND status = 'approved')     AS drivers_approved,

                (SELECT COUNT(*)::int FROM users
                  WHERE role = 'driver' AND status = 'pending_verification')
                                                                     AS drivers_awaiting_review,

                -- Drivers locked out by an expired document. This is the
                -- number that quietly shrinks the fleet, and nobody notices
                -- until a busy Friday.
                (SELECT COUNT(*)::int FROM users
                  WHERE role = 'driver'
                    AND status = 'suspended'
                    AND suspension_reason = 'document_expired')      AS drivers_expiry_locked,

                (SELECT COUNT(*)::int FROM users
                  WHERE role = 'operator' AND status = 'approved')   AS operators_approved,

                (SELECT COUNT(*)::int FROM users
                  WHERE role = 'operator' AND status = 'pending_verification')
                                                                     AS operators_awaiting_review,

                -- Documents that expire in the next 30 days, across every
                -- driver. The daily job warns the drivers themselves; this is
                -- so the office can see it coming.
                (SELECT COUNT(*)::int FROM driver_documents
                  WHERE is_current
                    AND expiry_date IS NOT NULL
                    AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30)
                                                                     AS documents_expiring_30d`
        );

        const counts = result.rows[0];

        res.status(200).json({
            date: new Date().toISOString().slice(0, 10),

            work: {
                bookings_today: counts.bookings_today,
                unassigned: counts.unassigned,
                awaiting_driver: counts.awaiting_driver,
                in_progress: counts.in_progress,
                completed_today: counts.completed_today,
                cancelled_today: counts.cancelled_today
            },

            drivers: {
                online: counts.drivers_online,
                approved: counts.drivers_approved,
                awaiting_review: counts.drivers_awaiting_review,
                expiry_locked: counts.drivers_expiry_locked
            },

            operators: {
                approved: counts.operators_approved,
                awaiting_review: counts.operators_awaiting_review
            },

            attention: {
                documents_expiring_30d: counts.documents_expiring_30d,
                // Repeated here on purpose. These are the two numbers that
                // mean somebody has to do something today, and an admin
                // should not have to assemble that list themselves.
                drivers_awaiting_review: counts.drivers_awaiting_review,
                operators_awaiting_review: counts.operators_awaiting_review,
                drivers_expiry_locked: counts.drivers_expiry_locked,
                unassigned_bookings: counts.unassigned
            }
        });

    } catch (error) {
        console.error("Error in getDashboard:", error);
        res.status(500).json({ message: "Something went wrong while building the dashboard" });
    }
};

// -----------------------------------------------------------------------------
// GET /api/v1/admin/bookings
// -----------------------------------------------------------------------------
// ?status= &operator_id= &driver_id= &from= &to= &q= &page= &limit=
//
// Every booking in the firm. Bookings were operator-only until now — an
// operator sees the ones they created, and there was no way to see the lot.
//
// q searches the reference and the client's name. An admin chasing a complaint
// has a booking reference or a name, never an id.
const getBookings = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const offset = (page - 1) * limit;

        const where = [];
        const params = [];

        if (req.query.status && BOOKING_STATUS_LABELS[req.query.status]) {
            params.push(req.query.status);
            where.push(`b.status = $${params.length}`);
        }

        if (/^\d+$/.test(req.query.operator_id || "")) {
            params.push(Number(req.query.operator_id));
            where.push(`b.created_by_operator_id = $${params.length}`);
        }

        if (/^\d+$/.test(req.query.driver_id || "")) {
            params.push(Number(req.query.driver_id));
            where.push(`b.driver_id = $${params.length}`);
        }

        // Dates are matched against the booking's own time — scheduled_at
        // where there is one, otherwise created_at. An ASAP job has no
        // appointed time, and filtering it out of "today" would be wrong.
        if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "")) {
            params.push(req.query.from);
            where.push(`COALESCE(b.scheduled_at, b.created_at) >= $${params.length}::date`);
        }

        if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "")) {
            params.push(req.query.to);
            // + 1 day so "to=2026-09-17" includes everything on the 17th
            // rather than stopping at midnight that morning.
            where.push(`COALESCE(b.scheduled_at, b.created_at) < ($${params.length}::date + 1)`);
        }

        if (req.query.q && String(req.query.q).trim()) {
            params.push(`%${String(req.query.q).trim()}%`);
            const p = params.length;
            where.push(`(b.reference ILIKE $${p} OR b.client_name ILIKE $${p})`);
        }

        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

        const result = await pool.query(
            `SELECT ${BOOKING_SELECT},
                    op.first_name AS operator_first_name,
                    op.last_name  AS operator_last_name,
                    op.id         AS operator_id
             ${BOOKING_JOINS}
             LEFT JOIN users op ON op.id = b.created_by_operator_id
             ${whereSql}
             ORDER BY COALESCE(b.scheduled_at, b.created_at) DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, offset]
        );

        const count = await pool.query(
            `SELECT COUNT(*)::int AS total FROM bookings b ${whereSql}`,
            params
        );

        const total = count.rows[0].total;

        res.status(200).json({
            bookings: result.rows.map((b) => ({
                // The client's phone and email are included: the admin is the
                // one who rings a client back when something has gone wrong.
                ...toBooking(b, { includeClientContact: true }),

                // "Who made this booking" — the CEO asked for this by name.
                created_by: {
                    id: b.operator_id,
                    full_name: fullName(b.operator_first_name, null, b.operator_last_name)
                }
            })),

            pagination: {
                page,
                limit,
                total,
                total_pages: Math.ceil(total / limit) || 1
            },

            filters: {
                status: req.query.status || "all",
                operator_id: req.query.operator_id || null,
                driver_id: req.query.driver_id || null,
                from: req.query.from || null,
                to: req.query.to || null,
                q: req.query.q || null
            }
        });

    } catch (error) {
        console.error("Error in getBookings:", error);
        res.status(500).json({ message: "Something went wrong while fetching bookings" });
    }
};

// -----------------------------------------------------------------------------
// GET /api/v1/admin/bookings/:id
// -----------------------------------------------------------------------------
// One booking, and everything that happened to it.
//
// This is the endpoint a complaint is answered from. "You said the driver was
// late" is settled by the timestamps; "nobody offered me that job" is settled
// by the offer list. Both questions get asked, and neither can be answered
// from the booking row alone.
const getBookingDetail = async (req, res) => {
    try {
        const { id } = req.params;

        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid booking id" });
        }

        const result = await pool.query(
            `SELECT ${BOOKING_SELECT},
                    op.id         AS operator_id,
                    op.first_name AS operator_first_name,
                    op.last_name  AS operator_last_name,
                    op.email      AS operator_email,
                    op.phone      AS operator_phone,
                    d.email       AS driver_email,
                    d.phone       AS driver_phone,
                    canceller.first_name AS cancelled_by_first_name,
                    canceller.last_name  AS cancelled_by_last_name,
                    canceller.role       AS cancelled_by_role
             ${BOOKING_JOINS}
             LEFT JOIN users op        ON op.id = b.created_by_operator_id
             LEFT JOIN users canceller ON canceller.id = b.cancelled_by
             WHERE b.id = $1`,
            [id]
        );

        const b = result.rows[0];

        if (!b) {
            return res.status(404).json({ message: "No booking with that id", error_code: "NOT_FOUND" });
        }

        // Every offer, in the order they were made. An expired offer and a
        // declined one look the same to an operator watching a screen; here
        // they are told apart, with the reason if the driver gave one.
        const offers = await pool.query(
            `SELECT o.id, o.status, o.offered_at, o.responded_at, o.expires_at,
                    o.decline_reason,
                    dr.id AS driver_id, dr.first_name, dr.last_name,
                    ob.first_name AS offered_by_first_name,
                    ob.last_name  AS offered_by_last_name
               FROM booking_offers o
               JOIN users dr      ON dr.id = o.driver_id
               LEFT JOIN users ob ON ob.id = o.offered_by_operator_id
              WHERE o.booking_id = $1
              ORDER BY o.offered_at ASC`,
            [id]
        );

        const byRole = await ratings.forBooking(Number(id));

        recordView(req.user.id, "booking", Number(id), true);

        res.status(200).json({
            booking: toBooking(b, { includeClientContact: true }),

            created_by: {
                id: b.operator_id,
                full_name: fullName(b.operator_first_name, null, b.operator_last_name),
                email: b.operator_email,
                phone: b.operator_phone
            },

            driver: b.driver_id
                ? {
                    id: b.driver_id,
                    full_name: fullName(b.driver_first_name, null, b.driver_last_name),
                    email: b.driver_email,
                    phone: b.driver_phone
                }
                : null,

            // The story of the job, in one place, each step with the moment it
            // happened. Nulls are kept rather than dropped — a missing
            // arrived_at is information, not an empty field to hide.
            timeline: {
                created_at: b.created_at,
                published_at: b.published_at,
                accepted_at: b.accepted_at,
                en_route_at: b.en_route_at,
                arrived_at: b.arrived_at,
                pob_at: b.pob_at,
                completed_at: b.completed_at,
                cancelled_at: b.cancelled_at
            },

            // The two gaps worth naming. Arrived to POB is waiting time, which
            // becomes money the moment fares are built; POB to completed is
            // the journey. Worked out here so nobody has to subtract
            // timestamps in the app and get it slightly wrong.
            durations_minutes: {
                waiting: minutesBetween(b.arrived_at, b.pob_at),
                journey: minutesBetween(b.pob_at, b.completed_at)
            },

            cancellation: b.cancelled_at
                ? {
                    at: b.cancelled_at,
                    reason: b.cancellation_reason,
                    by: b.cancelled_by_first_name
                        ? {
                            full_name: fullName(b.cancelled_by_first_name, null, b.cancelled_by_last_name),
                            role: b.cancelled_by_role
                        }
                        : null
                }
                : null,

            offers: offers.rows.map((o) => ({
                id: o.id,
                driver: {
                    id: o.driver_id,
                    full_name: fullName(o.first_name, null, o.last_name)
                },
                status: o.status,
                offered_at: o.offered_at,
                responded_at: o.responded_at,
                expires_at: o.expires_at,
                decline_reason: o.decline_reason,
                offered_by: o.offered_by_first_name
                    ? fullName(o.offered_by_first_name, null, o.offered_by_last_name)
                    : null
            })),

            ratings: {
                operator_rated_driver: byRole.operator,
                driver_rated_operator: byRole.driver
            }
        });

    } catch (error) {
        console.error("Error in getBookingDetail:", error);
        res.status(500).json({ message: "Something went wrong while fetching the booking" });
    }
};

// -----------------------------------------------------------------------------
// GET /api/v1/admin/drivers/:id
// -----------------------------------------------------------------------------
// One driver, whole.
//
// adminController.js already lists drivers; this is the record behind a name
// on that list — profile, car, documents, rating, and what they have been
// doing. Contact details included, and the look is logged.
const getDriverDetail = async (req, res) => {
    try {
        const { id } = req.params;

        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid driver id" });
        }

        const userResult = await pool.query(
            `SELECT u.*,
                    (cf.driver_id IS NOT NULL) AS is_fleet,
                    cf.added_at AS fleet_added_at
               FROM users u
               LEFT JOIN company_drivers cf
                      ON cf.driver_id = u.id AND cf.removed_at IS NULL
              WHERE u.id = $1`,
            [id]
        );

        const u = userResult.rows[0];

        if (!u || u.role !== "driver") {
            return res.status(404).json({ message: "No driver with that id", error_code: "NOT_FOUND" });
        }

        const vehicles = await pool.query(
            `SELECT v.id, v.registration_number, v.make, v.model, v.year, v.color,
                    v.vehicle_class, v.vehicle_class_id, v.owner_type,
                    v.verification_status, v.availability_status,
                    vc.name AS vehicle_class_name
               FROM vehicles v
               LEFT JOIN vehicle_classes vc ON vc.id = v.vehicle_class_id
              WHERE v.driver_id = $1
              ORDER BY v.id`,
            [id]
        );

        const documents = await pool.query(
            `SELECT id, document_type, status, expiry_date, uploaded_at
               FROM driver_documents
              WHERE user_id = $1 AND is_current
              ORDER BY document_type`,
            [id]
        );

        const work = await pool.query(
            `SELECT
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
                COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled'))::int AS active
               FROM bookings WHERE driver_id = $1`,
            [id]
        );

        // How often this driver turns work down. Not a judgement — a driver
        // who declines everything on a Tuesday may simply not work Tuesdays —
        // but it is the number somebody asks for, and it should come from the
        // record rather than from an operator's impression.
        const offerStats = await pool.query(
            `SELECT status, COUNT(*)::int AS total
               FROM booking_offers
              WHERE driver_id = $1
              GROUP BY status`,
            [id]
        );

        const recent = await pool.query(
            `SELECT id, reference, status, client_name,
                    pickup_address, dropoff_address,
                    COALESCE(scheduled_at, created_at) AS when_at
               FROM bookings
              WHERE driver_id = $1
              ORDER BY COALESCE(scheduled_at, created_at) DESC
              LIMIT 10`,
            [id]
        );

        const ratingSummary = await ratings.summaryFor(Number(id));

        recordView(req.user.id, "driver", Number(id), true);

        res.status(200).json({
            driver: {
                id: u.id,
                title: u.title,
                full_name: fullName(u.first_name, u.middle_name, u.last_name),
                first_name: u.first_name,
                middle_name: u.middle_name,
                last_name: u.last_name,

                // Not masked. This is the admin screen, and that is the point
                // of it.
                email: u.email,
                phone: u.phone,

                date_of_birth: u.date_of_birth,
                address: u.address,
                postcode: u.postcode,
                ni_number: u.ni_number,

                status: u.status,
                suspension_reason: u.suspension_reason,
                suspended_at: u.suspended_at,

                is_online: u.is_online,
                last_online_at: u.last_online_at,

                is_fleet: u.is_fleet,
                fleet_added_at: u.fleet_added_at,

                created_at: u.created_at
            },

            rating: ratingSummary,

            vehicles: vehicles.rows,

            documents: documents.rows.map((d) => ({
                ...d,
                // Said plainly rather than left for the app to compute from a
                // date and get wrong at the boundary.
                expired: Boolean(d.expiry_date) && d.expiry_date < new Date().toISOString().slice(0, 10)
            })),

            work: {
                ...work.rows[0],
                offers: offerStats.rows.reduce((all, row) => {
                    all[row.status] = row.total;
                    return all;
                }, {})
            },

            recent_bookings: recent.rows
        });

    } catch (error) {
        console.error("Error in getDriverDetail:", error);
        res.status(500).json({ message: "Something went wrong while fetching the driver" });
    }
};

// -----------------------------------------------------------------------------
// GET /api/v1/admin/operators/overview
// -----------------------------------------------------------------------------
// Every operator with what they have actually done.
//
// adminController.js already lists operators for the verification queue —
// who is waiting to be approved. This answers a different question: of the
// operators already working, who is doing what.
//
// Declared BEFORE /operators/:id in the routes file. "overview" is not a
// number, so it would fall into the :id route and fail there.
const getOperatorsOverview = async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT u.id, u.first_name, u.last_name, u.email, u.phone,
                    u.status, u.created_at,
                    u.rating_average, u.rating_count,
                    COUNT(b.id)::int                                        AS bookings_total,
                    COUNT(b.id) FILTER (WHERE b.created_at::date = CURRENT_DATE)::int
                                                                            AS bookings_today,
                    COUNT(b.id) FILTER (WHERE b.status = 'completed')::int  AS completed,
                    COUNT(b.id) FILTER (WHERE b.status = 'cancelled')::int  AS cancelled,
                    COUNT(b.id) FILTER (WHERE b.status = 'pending')::int    AS unassigned,
                    MAX(b.created_at)                                       AS last_booking_at
               FROM users u
               LEFT JOIN bookings b ON b.created_by_operator_id = u.id
              WHERE u.role = 'operator'
              GROUP BY u.id
              ORDER BY bookings_today DESC, bookings_total DESC, u.first_name ASC`
        );

        res.status(200).json({
            operators: result.rows.map((o) => ({
                id: o.id,
                full_name: fullName(o.first_name, null, o.last_name),
                email: o.email,
                phone: o.phone,
                status: o.status,
                created_at: o.created_at,

                rating_average: o.rating_average === null ? null : Number(o.rating_average),
                rating_count: o.rating_count,

                bookings: {
                    total: o.bookings_total,
                    today: o.bookings_today,
                    completed: o.completed,
                    cancelled: o.cancelled,
                    unassigned: o.unassigned
                },

                last_booking_at: o.last_booking_at
            })),

            total: result.rows.length
        });

    } catch (error) {
        console.error("Error in getOperatorsOverview:", error);
        res.status(500).json({ message: "Something went wrong while fetching operators" });
    }
};

// -----------------------------------------------------------------------------
// GET /api/v1/admin/access-log
// -----------------------------------------------------------------------------
// ?subject_type= &subject_id= &admin_id=
//
// Who looked at whom. The other half of "an admin sees everything".
//
// An admin can read this, including their own entries — there is no hiding
// from it, which is the point. Reading the log does not itself write to the
// log; a record of people reading the record is where this stops being
// useful.
const getAccessLog = async (req, res) => {
    try {
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

        const where = [];
        const params = [];

        if (["driver", "operator", "booking"].includes(req.query.subject_type)) {
            params.push(req.query.subject_type);
            where.push(`v.subject_type = $${params.length}`);
        }

        if (/^\d+$/.test(req.query.subject_id || "")) {
            params.push(Number(req.query.subject_id));
            where.push(`v.subject_id = $${params.length}`);
        }

        if (/^\d+$/.test(req.query.admin_id || "")) {
            params.push(Number(req.query.admin_id));
            where.push(`v.admin_id = $${params.length}`);
        }

        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

        const result = await pool.query(
            `SELECT v.id, v.subject_type, v.subject_id, v.saw_contact, v.viewed_at,
                    a.id AS admin_id, a.first_name, a.last_name
               FROM admin_views v
               JOIN users a ON a.id = v.admin_id
               ${whereSql}
              ORDER BY v.viewed_at DESC
              LIMIT $${params.length + 1}`,
            [...params, limit]
        );

        res.status(200).json({
            views: result.rows.map((v) => ({
                id: v.id,
                admin: {
                    id: v.admin_id,
                    full_name: fullName(v.first_name, null, v.last_name)
                },
                subject_type: v.subject_type,
                subject_id: v.subject_id,
                saw_contact: v.saw_contact,
                viewed_at: v.viewed_at
            })),

            total: result.rows.length,
            filters: {
                subject_type: req.query.subject_type || "all",
                subject_id: req.query.subject_id || null,
                admin_id: req.query.admin_id || null
            }
        });

    } catch (error) {
        console.error("Error in getAccessLog:", error);
        res.status(500).json({ message: "Something went wrong while fetching the access log" });
    }
};

module.exports = {
    getDashboard,
    getBookings,
    getBookingDetail,
    getDriverDetail,
    getOperatorsOverview,
    getAccessLog
};