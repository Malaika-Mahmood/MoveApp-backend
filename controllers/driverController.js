const pool = require("../config/db");
const {
    notifyContactRequest,
    notifyAccessDecision
} = require("../services/appNotifications");
const shareAccess = require("../services/shareAccess");
const { expiredDocumentsFor } = require("../services/documentExpiry");

// UK postcode, e.g. W1U 3BW / SW1A 1AA / M1 1AE
const POSTCODE_REGEX = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const VALID_TITLES = ["Mr", "Mrs", "Ms"];

const MIN_DRIVER_AGE = 21;   // typical UK private hire minimum

// The driver now types their own National Insurance number on the Personal
// Information screen. The operator can still correct it during verification
// (PATCH /operator/drivers/:id/details) by reading it off the uploaded
// document — a driver mistyping their own NI number is common, and the
// document is the authority.
//
// This regex is the same one the operator endpoint uses. The prefixes below
// are never issued by HMRC, and QQ123456C in particular is HMRC's own
// placeholder — it can never be a real number, so it must be rejected.
const NI_REGEX = /^(?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/i;

// "AB 12 34 56 C" and "ab123456c" are the same number written differently.
const normaliseNi = (value) => String(value).replace(/\s+/g, "").toUpperCase();

// NOTE: internal / external driver type has been removed — every driver is
// treated the same under the universal app model.

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

    // Typed by the driver, correctable by the operator
    ni_number: u.ni_number,

    // Filled in by the operator from the documents — read-only to the driver
    driving_licence_number: u.driving_licence_number,
    pco_licence_number: u.pco_licence_number,

    created_at: u.created_at,

    // The app locks itself on this. A locked driver can still open the document
    // screens — that is the whole point, they have to be able to fix it — but
    // everything else is covered over.
    account_locked: Boolean(u.account_locked),
    suspension_reason: u.suspension_reason || null,
    suspended_at: u.suspended_at || null,

    // Onboarding progress, so the app knows which screen to show next
    // without having to work it out from null checks.
    onboarding: {
        personal_info_complete: Boolean(
            u.title && u.date_of_birth && u.postcode && u.address
        ),
        ni_number_complete: Boolean(u.ni_number)
    }
});

// GET /api/v1/drivers/me
const getMe = async (req, res) => {
    try {
        // authenticate already loaded the row, so no second query is needed
        const user = toProfile(req.user);

        // The lock screen. Only looked up when the driver is actually locked —
        // no point running this query on every profile load for the 99% who are
        // not. It names the documents so the app can say "your MOT expired on
        // 14.09.2026" instead of "a document expired", which is the difference
        // between a driver who knows what to do and one who phones the office.
        if (req.user.account_locked) {
            user.expired_documents = await expiredDocumentsFor(req.user.id);

            // Once the driver uploads a replacement, the expired file stops
            // being the current one, so expired_documents empties out — but the
            // lock stays on until an operator approves the new file. Without
            // these two fields the app would show a lock screen with nothing on
            // it and no explanation of what the driver is waiting for.
            const awaiting = await pool.query(
                `SELECT id, document_type, uploaded_at
                 FROM driver_documents
                 WHERE user_id = $1 AND is_current AND status = 'pending_review'
                 ORDER BY uploaded_at DESC`,
                [req.user.id]
            );

            user.pending_review_documents = awaiting.rows.map((d) => ({
                document_id: d.id,
                document_type: d.document_type,
                uploaded_at: d.uploaded_at
            }));

            // true  → "Your new document is with an operator. We will let you know."
            // false → "These documents have expired. Upload a new one."
            user.replacement_pending =
                user.expired_documents.length === 0 && awaiting.rows.length > 0;
        }

        res.status(200).json({ user });
    } catch (error) {
        console.error("Error in getMe:", error);
        res.status(500).json({ message: "Something went wrong while fetching your profile" });
    }
};

// PATCH /api/v1/drivers/me/personal
// Title, middle name, date of birth, NI number, address, postcode.
//
// Editable at any time, including after approval — people move house, and
// making them phone the operator for that would be silly.
//
// middle_name is here because Create Account does not force one, and a driver
// who skipped it there had no way to add it afterwards — while their passport
// and licence both carry it, which is exactly what the operator is matching
// against. First and last name are deliberately NOT editable: those are the
// identity the whole account was opened under.
// PATCH /api/v1/drivers/me/personal
// Title, middle name, date of birth, address, postcode.
// NI number is NOT collected here — use PATCH /api/v1/drivers/me/ni-number
const updatePersonalInfo = async (req, res) => {
    try {
        const { title, middle_name, date_of_birth, address, postcode } = req.body;

        if (req.user.role !== "driver") {
            return res.status(403).json({
                message: "Only drivers have a personal information profile",
                error_code: "FORBIDDEN"
            });
        }

        if (!title || !date_of_birth || !postcode || !address) {
            return res.status(400).json({
                message: "title, date_of_birth, postcode and address are required"
            });
        }

        const cleanTitle = String(title).trim();

        const middleNameProvided = Object.prototype.hasOwnProperty.call(req.body, "middle_name");
        let cleanMiddleName;

        if (middleNameProvided) {
            const trimmed = middle_name === null ? "" : String(middle_name).trim();

            if (trimmed === "") {
                cleanMiddleName = null;
            } else {
                if (trimmed.length < 2 || trimmed.length > 50) {
                    return res.status(400).json({
                        message: "middle_name must be between 2 and 50 characters"
                    });
                }

                if (!/^[\p{L}][\p{L}\s'-]*$/u.test(trimmed)) {
                    return res.status(400).json({
                        message: "middle_name may only contain letters, spaces, hyphens and apostrophes"
                    });
                }

                cleanMiddleName = trimmed;
            }
        }

        const cleanPostcode = String(postcode).trim().toUpperCase();
        const cleanAddress = String(address).trim();

        if (!cleanAddress) {
            return res.status(400).json({
                message: "address is required"
            });
        }

        if (cleanAddress.length > 300) {
            return res.status(400).json({
                message: "address must be at most 300 characters"
            });
        }

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
             SET title = $1,
                 date_of_birth = $2,
                 address = $3,
                 postcode = $4,
                 middle_name = CASE WHEN $5 THEN $6 ELSE middle_name END,
                 updated_at = NOW()
             WHERE id = $7
             RETURNING *`,
            [
                cleanTitle,
                date_of_birth,
                cleanAddress,
                cleanPostcode,
                middleNameProvided,
                cleanMiddleName ?? null,
                req.user.id
            ]
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
// PATCH /api/v1/drivers/me/ni-number
// Body: { "ni_number": "AB123456C" }
// Collected on the Documents step (not Personal Information).
const updateNiNumber = async (req, res) => {
    try {
        if (req.user.role !== "driver") {
            return res.status(403).json({
                message: "Only drivers can set a National Insurance number",
                error_code: "FORBIDDEN"
            });
        }

        const { ni_number } = req.body || {};

        if (!ni_number) {
            return res.status(400).json({
                message: "ni_number is required",
                error_code: "MISSING_NI_NUMBER"
            });
        }

        const cleanNi = normaliseNi(ni_number);

        if (!NI_REGEX.test(cleanNi)) {
            return res.status(400).json({
                message: "ni_number must be a valid UK National Insurance number (e.g. AB123456C)",
                error_code: "INVALID_NI_NUMBER"
            });
        }

        const clash = await pool.query(
            "SELECT id FROM users WHERE UPPER(ni_number) = $1 AND id <> $2",
            [cleanNi, req.user.id]
        );

        if (clash.rows.length > 0) {
            return res.status(409).json({
                message: "This National Insurance number is already registered to another account",
                error_code: "NI_NUMBER_IN_USE"
            });
        }

        const updated = await pool.query(
            `UPDATE users
             SET ni_number = $1, updated_at = NOW()
             WHERE id = $2
             RETURNING *`,
            [cleanNi, req.user.id]
        );

        res.status(200).json({
            message: "National Insurance number saved",
            user: toProfile(updated.rows[0])
        });

    } catch (error) {
        if (error.code === "23505") {
            return res.status(409).json({
                message: "This National Insurance number is already registered to another account",
                error_code: "NI_NUMBER_IN_USE"
            });
        }

        console.error("Error in updateNiNumber:", error);
        res.status(500).json({ message: "Something went wrong while saving your NI number" });
    }
};

// GET /api/v1/drivers/me/address-lookup?postcode=SW1A1AA
const lookupAddressByPostcode = async (req, res) => {
    try {
        if (req.user.role !== "driver" && req.user.role !== "operator") {
            return res.status(403).json({
                message: "Not allowed",
                error_code: "FORBIDDEN"
            });
        }

        const raw = req.query.postcode;
        if (!raw) {
            return res.status(400).json({
                message: "postcode query parameter is required"
            });
        }

        const cleanPostcode = String(raw).trim().toUpperCase().replace(/\s+/g, "");

        const spaced = cleanPostcode.length > 3
            ? `${cleanPostcode.slice(0, -3)} ${cleanPostcode.slice(-3)}`
            : cleanPostcode;

        if (!POSTCODE_REGEX.test(String(raw).trim().toUpperCase()) && !POSTCODE_REGEX.test(spaced)) {
            return res.status(400).json({
                message: "postcode must be a valid UK postcode (e.g. W1U 3BW)"
            });
        }

        const apiKey = process.env.IDEAL_POSTCODES_API_KEY;
        if (!apiKey) {
            return res.status(503).json({
                message: "Address lookup is not configured",
                error_code: "ADDRESS_LOOKUP_UNAVAILABLE"
            });
        }

        const url =
            `https://api.ideal-postcodes.co.uk/v1/postcodes/${encodeURIComponent(cleanPostcode)}` +
            `?api_key=${encodeURIComponent(apiKey)}`;

        const response = await fetch(url);
        const data = await response.json().catch(() => ({}));

        if (response.status === 404 || (data.code && Number(data.code) === 4040)) {
            return res.status(404).json({
                message: "No addresses found for this postcode",
                error_code: "POSTCODE_NOT_FOUND",
                addresses: []
            });
        }

        if (!response.ok) {
            console.error("Ideal Postcodes error:", response.status, data);
            return res.status(502).json({
                message: "Address lookup failed. Please try again or enter the address manually.",
                error_code: "ADDRESS_LOOKUP_FAILED"
            });
        }

        const results = Array.isArray(data.result) ? data.result : [];

        const addresses = results.map((a) => {
            const line1 = a.line_1 || a.line1 || "";
            const line2 = a.line_2 || a.line2 || "";
            const line3 = a.line_3 || a.line3 || "";
            const postTown = a.post_town || a.postTown || "";
            const postcode = a.postcode || spaced;

            const parts = [line1, line2, line3, postTown].filter(Boolean);

            return {
                line_1: line1,
                line_2: line2 || null,
                line_3: line3 || null,
                post_town: postTown || null,
                postcode,
                formatted_address: parts.join(", ")
            };
        });

        res.status(200).json({
            postcode: cleanPostcode,
            count: addresses.length,
            addresses
        });

    } catch (error) {
        console.error("Error in lookupAddressByPostcode:", error);
        res.status(500).json({
            message: "Something went wrong while looking up the address"
        });
    }
};

// POST /api/v1/drivers/me/contact-request
// Body: { message } — optional, up to 300 characters
//
// The driver cannot see the operator's phone number or email, so this is how
// they ask to be contacted: the operator gets a notification and reaches out.
//
// WHICH operator is told: the one who last verified any of this driver's
// documents. That is a stand-in. There is no column yet saying which operator a
// driver belongs to — the CEO has not decided how that link is formed — and
// "whoever reviewed you" is the closest true answer today's data can give. When
// the link exists, only the query below changes.
//
// If nobody has reviewed them yet, every admin is told instead, so a request is
// never simply lost.
const CONTACT_REQUEST_COOLDOWN_MINUTES = 60;

const requestContact = async (req, res) => {
    try {
        if (req.user.role !== "driver") {
            return res.status(403).json({
                message: "Only drivers can send a contact request",
                error_code: "FORBIDDEN"
            });
        }

        const { message } = req.body || {};
        let cleanMessage = null;

        if (message !== undefined && message !== null && String(message).trim() !== "") {
            cleanMessage = String(message).trim();

            if (cleanMessage.length > 300) {
                return res.status(400).json({
                    message: "message must be 300 characters or fewer"
                });
            }
        }

        // One request an hour. Without it a driver waiting for an answer taps
        // the button again and again, the operator's bell fills with the same
        // request, and they stop reading it.
        const recent = await pool.query(
            `SELECT created_at FROM notifications
             WHERE actor_id = $1
               AND type = 'contact_request'
               AND created_at > NOW() - make_interval(mins => $2)
             ORDER BY created_at DESC
             LIMIT 1`,
            [req.user.id, CONTACT_REQUEST_COOLDOWN_MINUTES]
        );

        if (recent.rows.length > 0) {
            const waited = Math.floor(
                (Date.now() - new Date(recent.rows[0].created_at).getTime()) / 1000
            );

            return res.status(429).json({
                message: "You have already asked to be contacted. Please wait for a reply.",
                error_code: "CONTACT_REQUEST_TOO_SOON",
                retry_after_seconds: Math.max(0, CONTACT_REQUEST_COOLDOWN_MINUTES * 60 - waited)
            });
        }

        const reviewers = await pool.query(
            `SELECT verified_by, MAX(verified_at) AS last_seen
             FROM driver_documents
             WHERE user_id = $1 AND verified_by IS NOT NULL
             GROUP BY verified_by
             ORDER BY last_seen DESC
             LIMIT 1`,
            [req.user.id]
        );

        let recipients = reviewers.rows.map((r) => r.verified_by);

        if (recipients.length === 0) {
            const admins = await pool.query(
                "SELECT id FROM users WHERE role = 'admin' AND status <> 'suspended'"
            );
            recipients = admins.rows.map((r) => r.id);
        }

        if (recipients.length === 0) {
            return res.status(503).json({
                message: "There is nobody available to contact right now. Please try again later.",
                error_code: "NO_RECIPIENT"
            });
        }

        for (const recipientId of recipients) {
            await notifyContactRequest(recipientId, req.user, cleanMessage);
        }

        res.status(201).json({
            message: "Your request has been sent. Someone will contact you shortly.",
            sent_to: recipients.length
        });

    } catch (error) {
        console.error("Error in requestContact:", error);
        res.status(500).json({ message: "Something went wrong while sending your request" });
    }
};

// -----------------------------------------------------------------------------
// Share code
// -----------------------------------------------------------------------------
// The driver's own ID and PIN, and the requests that arrive because of them.
//
// The ID never changes — it is how the driver is known. The PIN is theirs to
// change whenever they like, which is the only remedy for having given it to
// somebody they later think better of.

// GET /api/v1/drivers/me/share-code
const getShareCode = async (req, res) => {
    try {
        if (req.user.role !== "driver") {
            return res.status(403).json({
                message: "Only drivers have a share code",
                error_code: "FORBIDDEN"
            });
        }

        const code = await shareAccess.getOrCreateShareCode(req.user.id);

        res.status(200).json({
            share_id: code.share_id,
            pin: code.share_pin,
            pin_updated_at: code.share_pin_updated_at,
            grant_minutes: shareAccess.GRANT_MINUTES
        });

    } catch (error) {
        console.error("Error in getShareCode:", error);
        res.status(500).json({ message: "Something went wrong while fetching your share code" });
    }
};

// POST /api/v1/drivers/me/share-code/pin
//
// Body is optional. `{ "pin": "451203" }` sets a chosen one; an empty body
// gets a random one, which is what a "Generate new PIN" button sends.
const changeSharePin = async (req, res) => {
    try {
        if (req.user.role !== "driver") {
            return res.status(403).json({
                message: "Only drivers have a share code",
                error_code: "FORBIDDEN"
            });
        }

        const { pin } = req.body || {};

        if (pin !== undefined && pin !== null && !shareAccess.normalisePin(pin)) {
            return res.status(400).json({
                message: "pin must be exactly 6 digits",
                error_code: "INVALID_PIN"
            });
        }

        // Make sure a code exists at all before changing half of it.
        await shareAccess.getOrCreateShareCode(req.user.id);

        const updated = await shareAccess.changePin(req.user.id, pin ?? null);

        res.status(200).json({
            message: "PIN updated",
            share_id: updated.share_id,
            pin: updated.share_pin,
            pin_updated_at: updated.share_pin_updated_at
        });

    } catch (error) {
        console.error("Error in changeSharePin:", error);
        res.status(500).json({ message: "Something went wrong while changing your PIN" });
    }
};

// GET /api/v1/drivers/me/access-requests
const listAccessRequests = async (req, res) => {
    try {
        if (req.user.role !== "driver") {
            return res.status(403).json({
                message: "Only drivers have access requests",
                error_code: "FORBIDDEN"
            });
        }

        const requests = await shareAccess.requestsForDriver(req.user.id);

        res.status(200).json({
            requests,
            pending_count: requests.filter((r) => r.status === "pending").length
        });

    } catch (error) {
        console.error("Error in listAccessRequests:", error);
        res.status(500).json({ message: "Something went wrong while fetching your access requests" });
    }
};

// PATCH /api/v1/drivers/me/access-requests/:id
// { "decision": "approved" }  or  { "decision": "denied" }
const decideAccessRequest = async (req, res) => {
    try {
        if (req.user.role !== "driver") {
            return res.status(403).json({
                message: "Only drivers can answer access requests",
                error_code: "FORBIDDEN"
            });
        }

        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid request id" });
        }

        const { decision } = req.body || {};
        if (decision !== "approved" && decision !== "denied") {
            return res.status(400).json({
                message: "decision must be 'approved' or 'denied'",
                error_code: "INVALID_DECISION"
            });
        }

        const updated = await shareAccess.decideRequest(req.user.id, Number(id), decision);

        // 404, not 403 or 409. The request is either not theirs, does not
        // exist, or has already been answered — and saying which of those it is
        // would leak other people's requests.
        if (!updated) {
            return res.status(404).json({
                message: "No pending request with that id",
                error_code: "NOT_FOUND"
            });
        }

        await notifyAccessDecision(
            updated.operator_id,
            [req.user.first_name, req.user.last_name].filter(Boolean).join(" "),
            decision === "approved",
            updated.id
        );

        res.status(200).json({
            message: decision === "approved"
                ? `Access allowed for ${shareAccess.GRANT_MINUTES} minutes`
                : "Access denied",
            request: {
                id: updated.id,
                status: updated.status,
                decided_at: updated.decided_at,
                expires_at: updated.expires_at
            }
        });

    } catch (error) {
        console.error("Error in decideAccessRequest:", error);
        res.status(500).json({ message: "Something went wrong while answering the request" });
    }
};

module.exports = {
    getMe,
    updatePersonalInfo,
    updateNiNumber,
    lookupAddressByPostcode,
    requestContact,
    getShareCode,
    changeSharePin,
    listAccessRequests,
    decideAccessRequest,
    toProfile
};