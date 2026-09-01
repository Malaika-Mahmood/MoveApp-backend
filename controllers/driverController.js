const pool = require("../config/db");

// UK National Insurance number, e.g. AB123456C
//
// Real rules, which are fussier than they look:
//   - first letter cannot be D, F, I, Q, U or V
//   - second letter cannot be D, F, I, O, Q, U or V
//   - the prefixes BG, GB, KN, NK, NT, TN and ZZ are never issued
//   - suffix is A, B, C or D
//
// Note QQ123456C is NOT valid — HMRC uses it in documentation precisely
// because it can never be a real number, so it must not be shown as an example.
const NI_REGEX = /^(?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/i;

// UK postcode, e.g. W1U 3BW / SW1A 1AA / M1 1AE
const POSTCODE_REGEX = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

const VALID_TITLES = ["Mr", "Mrs", "Ms"];
const VALID_DRIVER_TYPES = ["internal", "external"];

// Shape the frontend receives everywhere a driver profile is returned.
// Keeping it in one function means every endpoint sends the same fields.
const toProfile = (u) => ({
    id: u.id,
    title: u.title,
    first_name: u.first_name,
    middle_name: u.middle_name,
    last_name: u.last_name,
    full_name: [u.first_name, u.middle_name, u.last_name].filter(Boolean).join(" "),
    email: u.email,
    phone: u.phone,
    role: u.role,
    status: u.status,
    email_verified: u.email_verified,
    phone_verified: u.phone_verified,
    ni_number: u.ni_number,
    postcode: u.postcode,
    address: u.address,
    driver_type: u.driver_type,
    driver_type_confirmed: u.driver_type_confirmed,
    created_at: u.created_at,

    // Onboarding progress, so the app knows which screen to show next
    // without having to work it out from null checks.
    onboarding: {
        personal_info_complete: Boolean(u.title && u.ni_number && u.postcode),
        driver_type_selected: Boolean(u.driver_type)
    }
});

// GET /api/v1/drivers/me
// Powers the auto-filled fields on the Personal Information screen.
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
// Screen 2: title, NI number, postcode. Name, phone and email are shown
// read-only from getMe, so they are deliberately not accepted here.
const updatePersonalInfo = async (req, res) => {
    try {
        const { title, ni_number, postcode } = req.body;

        if (req.user.role !== "driver") {
            return res.status(403).json({
                message: "Only drivers have a personal information profile",
                error_code: "FORBIDDEN"
            });
        }

        // Once an operator has approved this driver, their verified details
        // must not change silently — an operator has to make the change.
        if (req.user.status === "approved") {
            return res.status(403).json({
                message: "Your details are verified and can no longer be edited. Please contact the operator.",
                error_code: "PROFILE_LOCKED"
            });
        }

        if (!title || !ni_number || !postcode) {
            return res.status(400).json({
                message: "title, ni_number and postcode are all required"
            });
        }

        const cleanTitle = String(title).trim();
        // Stored without spaces and upper-cased so two people cannot register
        // "qq 123456 c" and "QQ123456C" as different numbers.
        const cleanNi = String(ni_number).replace(/\s/g, "").toUpperCase();
        const cleanPostcode = String(postcode).trim().toUpperCase();

        if (!VALID_TITLES.includes(cleanTitle)) {
            return res.status(400).json({
                message: `title must be one of: ${VALID_TITLES.join(", ")}`
            });
        }

        if (!NI_REGEX.test(cleanNi)) {
            return res.status(400).json({
                message: "ni_number must be a valid UK National Insurance number (e.g. AB123456C)"
            });
        }

        if (!POSTCODE_REGEX.test(cleanPostcode)) {
            return res.status(400).json({
                message: "postcode must be a valid UK postcode (e.g. W1U 3BW)"
            });
        }

        const updated = await pool.query(
            `UPDATE users
             SET title = $1, ni_number = $2, postcode = $3, updated_at = NOW()
             WHERE id = $4
             RETURNING id, title, first_name, middle_name, last_name, email, phone,
                       role, status, email_verified, phone_verified,
                       ni_number, postcode, address, driver_type, driver_type_confirmed,
                       created_at`,
            [cleanTitle, cleanNi, cleanPostcode, req.user.id]
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
// Screen 3: internal (company) or external.
//
// This is the driver's own claim. It does not change which documents are
// required — every driver uploads their own — and the operator confirms or
// corrects it during verification.
const updateDriverType = async (req, res) => {
    try {
        const { driver_type } = req.body;

        if (req.user.role !== "driver") {
            return res.status(403).json({
                message: "Only drivers have a driver type",
                error_code: "FORBIDDEN"
            });
        }

        if (req.user.status === "approved") {
            return res.status(403).json({
                message: "Your details are verified and can no longer be edited. Please contact the operator.",
                error_code: "PROFILE_LOCKED"
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

        // Changing the claim clears any previous operator confirmation,
        // so a confirmed "external" cannot quietly become "internal".
        const updated = await pool.query(
            `UPDATE users
             SET driver_type = $1, driver_type_confirmed = FALSE, updated_at = NOW()
             WHERE id = $2
             RETURNING id, title, first_name, middle_name, last_name, email, phone,
                       role, status, email_verified, phone_verified,
                       ni_number, postcode, address, driver_type, driver_type_confirmed,
                       created_at`,
            [cleanType, req.user.id]
        );

        res.status(200).json({
            message: "Driver type saved",
            user: toProfile(updated.rows[0])
        });

    } catch (error) {
        console.error("Error in updateDriverType:", error);
        res.status(500).json({ message: "Something went wrong while saving your driver type" });
    }
};

module.exports = { getMe, updatePersonalInfo, updateDriverType, toProfile };