const pool = require("../config/db");

// UK postcode, e.g. W1U 3BW / SW1A 1AA / M1 1AE
const POSTCODE_REGEX = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const VALID_TITLES = ["Mr", "Mrs", "Ms"];
const VALID_DRIVER_TYPES = ["internal", "external"];

const MIN_DRIVER_AGE = 21;   // typical UK private hire minimum

// NOTE: the National Insurance number is deliberately NOT collected here.
// It is printed on the document the driver uploads, so the operator reads it
// off that during verification (PATCH /operator/drivers/:id/details) rather
// than making the driver type it twice.

// Shape the frontend receives everywhere a driver profile is returned.
// Keeping it in one function means every endpoint sends the same fields.
const toProfile = (u) => ({
    id: u.id,
    title: u.title,
    first_name: u.first_name,
    middle_name: u.middle_name,
    last_name: u.last_name,
    full_name: [u.first_name, u.middle_name, u.last_name].filter(Boolean).join(" "),
    date_of_birth: u.date_of_birth,
    email: u.email,
    phone: u.phone,
    role: u.role,
    status: u.status,
    email_verified: u.email_verified,
    phone_verified: u.phone_verified,
    address: u.address,
    postcode: u.postcode,

    // Filled in by the operator from the documents — read-only to the driver
    ni_number: u.ni_number,
    driving_licence_number: u.driving_licence_number,
    pco_licence_number: u.pco_licence_number,

    driver_type: u.driver_type,
    driver_type_confirmed: u.driver_type_confirmed,
    created_at: u.created_at,

    // Onboarding progress, so the app knows which screen to show next
    // without having to work it out from null checks.
    onboarding: {
        personal_info_complete: Boolean(u.title && u.date_of_birth && u.postcode),
        driver_type_selected: Boolean(u.driver_type)
    }
});

// GET /api/v1/drivers/me
const getMe = async (req, res) => {
    try {
        // authenticate already loaded the row, so no second query is needed
        res.status(200).json({ user: toProfile(req.user) });
    } catch (error) {
        console.error("Error in getMe:", error);
        res.status(500).json({ message: "Something went wrong while fetching your profile" });
    }
};

// PATCH /api/v1/drivers/me/personal
// Title, date of birth, address, postcode.
//
// Editable at any time, including after approval — people move house, and
// making them phone the operator for that would be silly.
const updatePersonalInfo = async (req, res) => {
    try {
        const { title, date_of_birth, address, postcode } = req.body;

        if (req.user.role !== "driver") {
            return res.status(403).json({
                message: "Only drivers have a personal information profile",
                error_code: "FORBIDDEN"
            });
        }

        if (!title || !date_of_birth || !postcode) {
            return res.status(400).json({
                message: "title, date_of_birth and postcode are required"
            });
        }

        const cleanTitle = String(title).trim();
        const cleanPostcode = String(postcode).trim().toUpperCase();
        const cleanAddress = address ? String(address).trim() : null;

        if (!VALID_TITLES.includes(cleanTitle)) {
            return res.status(400).json({
                message: `title must be one of: ${VALID_TITLES.join(", ")}`
            });
        }

        if (!ISO_DATE.test(String(date_of_birth))) {
            return res.status(400).json({
                message: "date_of_birth must be in YYYY-MM-DD format"
            });
        }

        const dob = new Date(`${date_of_birth}T00:00:00Z`);
        if (Number.isNaN(dob.getTime())) {
            return res.status(400).json({ message: "date_of_birth is not a valid date" });
        }

        const age = (Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000);

        if (age < MIN_DRIVER_AGE) {
            return res.status(400).json({
                message: `Drivers must be at least ${MIN_DRIVER_AGE} years old`,
                error_code: "DRIVER_TOO_YOUNG"
            });
        }

        if (age > 100) {
            return res.status(400).json({ message: "date_of_birth does not look correct" });
        }

        if (!POSTCODE_REGEX.test(cleanPostcode)) {
            return res.status(400).json({
                message: "postcode must be a valid UK postcode (e.g. W1U 3BW)"
            });
        }

        const updated = await pool.query(
            `UPDATE users
             SET title = $1, date_of_birth = $2,
                 address = COALESCE($3, address), postcode = $4, updated_at = NOW()
             WHERE id = $5
             RETURNING *`,
            [cleanTitle, date_of_birth, cleanAddress, cleanPostcode, req.user.id]
        );

        res.status(200).json({
            message: "Personal information saved",
            user: toProfile(updated.rows[0])
        });

    } catch (error) {
        console.error("Error in updatePersonalInfo:", error);
        res.status(500).json({ message: "Something went wrong while saving your information" });
    }
};

// PATCH /api/v1/drivers/me/type
// internal (company) or external.
//
// This is the driver's own claim. It does not change which documents are
// required — every driver uploads their own — and the operator confirms it.
const updateDriverType = async (req, res) => {
    try {
        const { driver_type } = req.body;

        if (req.user.role !== "driver") {
            return res.status(403).json({
                message: "Only drivers have a driver type",
                error_code: "FORBIDDEN"
            });
        }

        if (!driver_type) {
            return res.status(400).json({ message: "driver_type is required" });
        }

        const cleanType = String(driver_type).trim().toLowerCase();

        if (!VALID_DRIVER_TYPES.includes(cleanType)) {
            return res.status(400).json({
                message: `driver_type must be one of: ${VALID_DRIVER_TYPES.join(", ")}`
            });
        }

        // Changing the claim clears the operator's confirmation, so a confirmed
        // "external" cannot quietly become "internal". An already-approved
        // driver goes back into the queue, because approval depended on the
        // operator having confirmed the old value.
        const updated = await pool.query(
            `UPDATE users
             SET driver_type = $1,
                 driver_type_confirmed = FALSE,
                 status = CASE WHEN status = 'approved' THEN 'pending_verification' ELSE status END,
                 updated_at = NOW()
             WHERE id = $2
             RETURNING *`,
            [cleanType, req.user.id]
        );

        const user = updated.rows[0];

        res.status(200).json({
            message: req.user.status === "approved" && user.status === "pending_verification"
                ? "Driver type saved. An operator needs to confirm the change before you are approved again."
                : "Driver type saved",
            user: toProfile(user)
        });

    } catch (error) {
        console.error("Error in updateDriverType:", error);
        res.status(500).json({ message: "Something went wrong while saving your driver type" });
    }
};

module.exports = { getMe, updatePersonalInfo, updateDriverType, toProfile };