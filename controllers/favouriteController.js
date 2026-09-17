const pool = require("../config/db");
const { maskDriverContact } = require("../utils/masking");

// The star beside a driver's name, and the Favourites tab on the assignment
// screen.
//
// The table has existed since migration 014; this is the door to it.
//
// Per operator, not per company. The operator who works the airport runs knows
// a different set of drivers from the one doing corporate accounts, and one of
// them starring somebody must not fill the other one's list.
//
// The driver is never told. A favourite is the operator's private note about
// who to call; telling a driver they are somebody's favourite turns it into a
// status, and telling them they were un-starred turns it into a punishment.
// Neither is what it is for.

// -----------------------------------------------------------------------------
// GET /api/v1/operator/favourite-drivers
// -----------------------------------------------------------------------------
const listFavourites = async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT u.id, u.first_name, u.last_name, u.email, u.phone,
                    u.is_online, u.last_online_at,
                    u.rating_average, u.rating_count, u.completed_trips,
                    f.starred_at, f.note,
                    v.id AS vehicle_id, v.registration_number, v.make, v.model,
                    v.vehicle_class, v.vehicle_class_id,
                    (cf.driver_id IS NOT NULL) AS is_fleet
               FROM operator_favourite_drivers f
               JOIN users u ON u.id = f.driver_id
               LEFT JOIN vehicles v
                      ON v.driver_id = u.id
                     AND v.verification_status = 'approved'
                     AND v.availability_status <> 'inactive'
               LEFT JOIN company_drivers cf
                      ON cf.driver_id = u.id AND cf.removed_at IS NULL
              WHERE f.operator_id = $1
              ORDER BY u.is_online DESC, f.starred_at DESC`,
            [req.user.id]
        );

        res.status(200).json({
            drivers: result.rows.map((d) => ({
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
                is_favourite: true,

                rating_average: d.rating_average === null ? null : Number(d.rating_average),
                rating_count: d.rating_count,
                completed_trips: d.completed_trips,

                starred_at: d.starred_at,
                note: d.note,

                // Null where the driver currently has no approved car. Shown
                // rather than hidden — a favourite whose car has lapsed is
                // exactly what an operator needs to notice.
                vehicle: d.vehicle_id
                    ? {
                        id: d.vehicle_id,
                        registration_number: d.registration_number,
                        make: d.make,
                        model: d.model,
                        vehicle_class: d.vehicle_class,
                        vehicle_class_id: d.vehicle_class_id
                    }
                    : null
            })),

            total: result.rows.length
        });

    } catch (error) {
        console.error("Error in listFavourites:", error);
        res.status(500).json({ message: "Something went wrong while fetching favourites" });
    }
};

// -----------------------------------------------------------------------------
// POST /api/v1/operator/favourite-drivers   { "driver_id": 7, "note": "..." }
// -----------------------------------------------------------------------------
// Starring somebody who is already starred updates the note rather than
// failing. Tapping a star twice is not an error worth a red message — and this
// is also how the note gets edited, without a second endpoint for it.
const addFavourite = async (req, res) => {
    try {
        const { driver_id, note } = req.body || {};

        if (!driver_id || !/^\d+$/.test(String(driver_id))) {
            return res.status(400).json({
                message: "driver_id is required",
                error_code: "MISSING_FIELDS"
            });
        }

        if (note !== undefined && note !== null && String(note).length > 255) {
            return res.status(400).json({
                message: "Keep the note under 255 characters",
                error_code: "VALIDATION_ERROR"
            });
        }

        const driver = await pool.query(
            `SELECT id, first_name, last_name, role, status FROM users WHERE id = $1`,
            [driver_id]
        );

        if (driver.rows.length === 0 || driver.rows[0].role !== "driver") {
            return res.status(404).json({
                message: "No driver with that id",
                error_code: "NOT_FOUND"
            });
        }

        // A driver who is not approved yet CAN be starred. An operator who has
        // worked with somebody before wants them on the list from the day they
        // sign up; whether they can actually be given a job is a separate
        // question, answered at assignment time.

        const result = await pool.query(
            `INSERT INTO operator_favourite_drivers (operator_id, driver_id, note)
             VALUES ($1, $2, $3)
             ON CONFLICT (operator_id, driver_id)
             DO UPDATE SET note = EXCLUDED.note
             RETURNING starred_at, note`,
            [req.user.id, driver_id, note ? String(note).trim() : null]
        );

        res.status(200).json({
            message: `${driver.rows[0].first_name} added to your favourites`,
            favourite: {
                driver_id: Number(driver_id),
                full_name: [driver.rows[0].first_name, driver.rows[0].last_name]
                    .filter(Boolean).join(" "),
                starred_at: result.rows[0].starred_at,
                note: result.rows[0].note
            }
        });

    } catch (error) {
        console.error("Error in addFavourite:", error);
        res.status(500).json({ message: "Something went wrong while saving the favourite" });
    }
};

// -----------------------------------------------------------------------------
// DELETE /api/v1/operator/favourite-drivers/:driverId
// -----------------------------------------------------------------------------
const removeFavourite = async (req, res) => {
    try {
        const { driverId } = req.params;

        if (!/^\d+$/.test(driverId)) {
            return res.status(400).json({ message: "Invalid driver id" });
        }

        const result = await pool.query(
            `DELETE FROM operator_favourite_drivers
              WHERE operator_id = $1 AND driver_id = $2
              RETURNING driver_id`,
            [req.user.id, driverId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "That driver is not in your favourites",
                error_code: "NOT_FOUND"
            });
        }

        res.status(200).json({ message: "Removed from your favourites" });

    } catch (error) {
        console.error("Error in removeFavourite:", error);
        res.status(500).json({ message: "Something went wrong" });
    }
};

module.exports = {
    listFavourites,
    addFavourite,
    removeFavourite
};
