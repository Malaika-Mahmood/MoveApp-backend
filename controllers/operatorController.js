const pool = require("../config/db");
const { toDocument } = require("./documentController");
const { toVehicleDocument } = require("./vehicleController");
const {
    REQUIRED_DRIVER_DOCUMENTS,
    ADDITIONAL_DRIVER_DOCUMENTS,
    MIN_ADDITIONAL_DOCUMENTS,
    REQUIRED_VEHICLE_DOCUMENTS,
    DRIVER_DOCUMENTS_WITH_EXPIRY,
    VEHICLE_DOCUMENTS_WITH_EXPIRY,
    documentNeedsExpiry,
    DOCUMENT_LABELS
} = require("../constants/documents");
const { maskDriverContact } = require("../utils/masking");
const {
    notifyDocumentsViewed,
    notifyExpiryLockCleared,
    notifyAccessRequest
} = require("../services/appNotifications");
const shareAccess = require("../services/shareAccess");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// UK National Insurance number, e.g. AB123456C
const NI_REGEX = /^(?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/i;

const parseExpiryDate = (value) => {
    if (!ISO_DATE.test(String(value))) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
};

// -----------------------------------------------------------------------------
// Status is DERIVED, never set by hand
// -----------------------------------------------------------------------------
// The old code flipped users.status to 'approved' as soon as every document
// that happened to exist was approved — so a driver with 2 of 10 documents
// became fully approved. These two functions recompute the truth from scratch
// after any change, which makes that class of bug impossible.

const recomputeVehicleStatus = async (client, vehicleId) => {
    const docs = await client.query(
        "SELECT document_type, status FROM vehicle_documents WHERE vehicle_id = $1 AND is_current",
        [vehicleId]
    );

    const byType = new Map(docs.rows.map((d) => [d.document_type, d.status]));
    const anyRejected = docs.rows.some((d) => d.status === "rejected");
    const allApproved = REQUIRED_VEHICLE_DOCUMENTS.every((t) => byType.get(t) === "approved");

    const status = anyRejected ? "rejected"
        : allApproved ? "approved"
            : "pending_verification";

    await client.query(
        "UPDATE vehicles SET verification_status = $1, updated_at = NOW() WHERE id = $2",
        [status, vehicleId]
    );

    return status;
};

const recomputeDriverStatus = async (client, driverId) => {
    const userResult = await client.query(
        "SELECT status, suspension_reason FROM users WHERE id = $1",
        [driverId]
    );
    const user = userResult.rows[0];
    if (!user) return null;

    // There are two kinds of suspension and they behave differently.
    //
    //   - An operator or admin suspension is somebody's decision. No amount of
    //     document approving undoes it; only that person can lift it.
    //
    //   - A document_expired suspension is a fact about a date. It IS undone by
    //     documents — but only once the replacement has actually been approved,
    //     never merely uploaded. That is why it is cleared here rather than at
    //     upload time.
    const lockedForExpiry =
        user.status === "suspended" && user.suspension_reason === "document_expired";

    if (user.status === "suspended" && !lockedForExpiry) return "suspended";

    const docs = await client.query(
        "SELECT document_type, status FROM driver_documents WHERE user_id = $1 AND is_current",
        [driverId]
    );
    const byType = new Map(docs.rows.map((d) => [d.document_type, d.status]));

    const allPresent = REQUIRED_DRIVER_DOCUMENTS.every((t) => byType.has(t));
    const allApproved = REQUIRED_DRIVER_DOCUMENTS.every((t) => byType.get(t) === "approved");
    const additionalUploaded = ADDITIONAL_DRIVER_DOCUMENTS
        .filter((t) => byType.has(t)).length;

    const additionalApproved = ADDITIONAL_DRIVER_DOCUMENTS
        .filter((t) => byType.get(t) === "approved").length;

    const enoughAdditionalPresent = additionalUploaded >= MIN_ADDITIONAL_DOCUMENTS;
    const enoughAdditionalApproved = additionalApproved >= MIN_ADDITIONAL_DOCUMENTS;
    const anyDocRejected = docs.rows.some((d) => d.status === "rejected");

    const vehicles = await client.query(
        "SELECT verification_status FROM vehicles WHERE driver_id = $1",
        [driverId]
    );
    const hasApprovedVehicle = vehicles.rows.some((v) => v.verification_status === "approved");
    const anyVehicleRejected = vehicles.rows.some((v) => v.verification_status === "rejected");

    let status;

    if (anyDocRejected || anyVehicleRejected) {
        // Something needs re-uploading — the driver must be told
        status = "rejected";
    } else if (allApproved && enoughAdditionalApproved && hasApprovedVehicle) {
        status = "approved";
    } else if (allPresent && enoughAdditionalPresent && vehicles.rows.length > 0) {
        status = "pending_verification";
    } else {
        status = "account_created";
    }

    // The lock only lifts on a clean bill of health: every required document
    // approved AND an approved vehicle. Anything short of that — one document
    // still waiting for review, a rejected file, no vehicle — and the driver
    // stays suspended, with the row left exactly as it is.
    if (lockedForExpiry && status !== "approved") {
        return "suspended";
    }

    if (lockedForExpiry) {
        await client.query(
            `UPDATE users
             SET status = $1,
                 suspension_reason = NULL,
                 suspended_at = NULL,
                 updated_at = NOW()
             WHERE id = $2`,
            [status, driverId]
        );

        await notifyExpiryLockCleared(driverId);
        return status;
    }

    await client.query(
        "UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2",
        [status, driverId]
    );

    return status;
};

// -----------------------------------------------------------------------------
// Queue
// -----------------------------------------------------------------------------

// GET /api/v1/operator/drivers/pending?page=1&limit=20&status=pending_verification
const getPendingDrivers = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const offset = (page - 1) * limit;

        const allowed = ["pending_verification", "account_created", "approved", "rejected", "suspended"];
        const status = allowed.includes(req.query.status) ? req.query.status : "pending_verification";

        // The default queue ("who is waiting for me?") has to include one case
        // that does not look like it belongs: a driver suspended for an expired
        // document who has since uploaded a replacement. Their status is
        // 'suspended', so a plain status filter would hide them — and nobody
        // would ever approve the new file, which leaves the driver locked out
        // for good through no fault of their own.
        //
        // The condition is narrow on purpose: only a document_expired lock, and
        // only when there is actually something new sitting in the queue.
        const includeAwaitingReview = status === "pending_verification";

        const filter = includeAwaitingReview
            ? `(
                 u.status = $1
                 OR (
                   u.status = 'suspended'
                   AND u.suspension_reason = 'document_expired'
                   AND EXISTS (
                     SELECT 1 FROM driver_documents d
                     WHERE d.user_id = u.id
                       AND d.is_current
                       AND d.status = 'pending_review'
                   )
                 )
               )`
            : "u.status = $1";

        const drivers = await pool.query(
            `SELECT u.id, u.title, u.first_name, u.middle_name, u.last_name,
                    u.email, u.phone, u.date_of_birth, u.ni_number, u.postcode,
                    u.address, u.status, u.suspension_reason, u.created_at
             FROM users u
             WHERE u.role = 'driver' AND ${filter}
             ORDER BY u.created_at ASC
             LIMIT $2 OFFSET $3`,
            [status, limit, offset]
        );

        const count = await pool.query(
            `SELECT COUNT(*)::int AS total
             FROM users u
             WHERE u.role = 'driver' AND ${filter}`,
            [status]
        );
        const total = count.rows[0].total;

        res.status(200).json({
            // The columns are still selected, because the same query serves an
            // admin one day; masking decides what LEAVES the server.
            drivers: drivers.rows.map((d) => maskDriverContact(d, req.user.role)),
            pagination: {
                page,
                limit,
                total,
                total_pages: Math.max(1, Math.ceil(total / limit))
            }
        });

    } catch (error) {
        console.error("Error in getPendingDrivers:", error);
        res.status(500).json({ message: "Something went wrong while fetching drivers" });
    }
};

// GET /api/v1/operator/drivers/:id
// Everything about one driver on a single screen: profile, documents, vehicles.
const getDriverDetail = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid driver id" });
        }

        const driverResult = await pool.query(
            "SELECT * FROM users WHERE id = $1 AND role = 'driver'",
            [id]
        );
        const driver = driverResult.rows[0];
        if (!driver) return res.status(404).json({ message: "Driver not found" });

        const docs = await pool.query(
            "SELECT * FROM driver_documents WHERE user_id = $1 AND is_current ORDER BY document_type",
            [id]
        );

        const vehicles = await pool.query(
            "SELECT * FROM vehicles WHERE driver_id = $1 ORDER BY created_at ASC",
            [id]
        );

        const vehicleDocs = await pool.query(
            `SELECT vd.* FROM vehicle_documents vd
             JOIN vehicles v ON v.id = vd.vehicle_id
             WHERE v.driver_id = $1 AND vd.is_current`,
            [id]
        );

        const have = docs.rows.map((d) => d.document_type);

        // Tell the driver their pack was opened. Only an operator triggers
        // this: an admin reviewing a record for compliance is not something the
        // driver is notified about, and notifyDocumentsViewed already ignores a
        // driver looking at their own.
        //
        // Not awaited, and it can never throw — a failed notification must not
        // stop the operator seeing the documents.
        if (req.user.role === "operator") {
            notifyDocumentsViewed(driver.id, req.user.id);
        }

        res.status(200).json({
            driver: maskDriverContact({
                id: driver.id,
                title: driver.title,
                first_name: driver.first_name,
                middle_name: driver.middle_name,
                last_name: driver.last_name,
                full_name: [driver.first_name, driver.middle_name, driver.last_name]
                    .filter(Boolean).join(" "),
                date_of_birth: driver.date_of_birth,
                email: driver.email,
                phone: driver.phone,
                ni_number: driver.ni_number,
                address: driver.address,
                postcode: driver.postcode,
                driving_licence_number: driver.driving_licence_number,
                pco_licence_number: driver.pco_licence_number,
                status: driver.status,
                created_at: driver.created_at
            }, req.user.role),

            documents: docs.rows.map(toDocument),
            missing_documents: REQUIRED_DRIVER_DOCUMENTS.filter((t) => !have.includes(t)),

            vehicles: vehicles.rows.map((v) => {
                const its = vehicleDocs.rows.filter((d) => d.vehicle_id === v.id);
                const itsTypes = its.map((d) => d.document_type);
                return {
                    ...v,
                    documents: its.map(toVehicleDocument),
                    missing_documents: REQUIRED_VEHICLE_DOCUMENTS.filter((t) => !itsTypes.includes(t))
                };
            }),

            // So the operator UI knows which rows need a date field
            expiry_required: {
                driver: DRIVER_DOCUMENTS_WITH_EXPIRY,
                vehicle: VEHICLE_DOCUMENTS_WITH_EXPIRY
            },
            labels: DOCUMENT_LABELS
        });

    } catch (error) {
        console.error("Error in getDriverDetail:", error);
        res.status(500).json({ message: "Something went wrong while fetching the driver" });
    }
};

// -----------------------------------------------------------------------------
// Verification
// -----------------------------------------------------------------------------

// Shared validation for both document types
const validateVerifyBody = (body, documentType) => {
    const { status, rejection_reason, expires_at } = body;

    if (!["approved", "rejected"].includes(status)) {
        return { error: "status must be 'approved' or 'rejected'" };
    }

    if (status === "rejected") {
        if (!rejection_reason || String(rejection_reason).trim().length < 3) {
            return { error: "rejection_reason is required when rejecting a document" };
        }
        return { status, rejectionReason: String(rejection_reason).trim(), expiryDate: null };
    }

    // Approving
    if (documentNeedsExpiry(documentType)) {
        if (!expires_at) {
            return { error: `expires_at is required when approving a ${documentType} (format YYYY-MM-DD)` };
        }

        const date = parseExpiryDate(expires_at);
        if (!date) {
            return { error: "expires_at must be a valid date in YYYY-MM-DD format" };
        }

        // Approving an already-expired document would leave a driver on the
        // road with invalid paperwork, which is the operator's legal problem.
        if (date.getTime() < Date.now()) {
            return { error: "expires_at is in the past — this document has already expired and cannot be approved" };
        }

        return { status, rejectionReason: null, expiryDate: expires_at };
    }

    return { status, rejectionReason: null, expiryDate: null };
};

// PATCH /api/v1/operator/documents/:documentId/verify
const verifyDriverDocument = async (req, res) => {
    const client = await pool.connect();

    try {
        const { documentId } = req.params;
        if (!/^\d+$/.test(documentId)) {
            return res.status(400).json({ message: "Invalid document id" });
        }

        const existing = await pool.query(
            "SELECT * FROM driver_documents WHERE id = $1",
            [documentId]
        );
        const doc = existing.rows[0];

        if (!doc) return res.status(404).json({ message: "Document not found" });

        if (!doc.is_current) {
            return res.status(400).json({
                message: "This document has been replaced by a newer upload",
                error_code: "DOCUMENT_SUPERSEDED"
            });
        }

        const parsed = validateVerifyBody(req.body, doc.document_type);
        if (parsed.error) return res.status(400).json({ message: parsed.error });

        await client.query("BEGIN");

        const updated = await client.query(
            `UPDATE driver_documents
             SET status = $1, rejection_reason = $2, expires_at = $3,
                 verified_by = $4, verified_at = NOW()
             WHERE id = $5
             RETURNING *`,
            [parsed.status, parsed.rejectionReason, parsed.expiryDate, req.user.id, documentId]
        );

        const driverStatus = await recomputeDriverStatus(client, doc.user_id);

        await client.query("COMMIT");

        res.status(200).json({
            message: parsed.status === "approved" ? "Document approved" : "Document rejected",
            document: toDocument(updated.rows[0]),
            driver_status: driverStatus
        });

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        console.error("Error in verifyDriverDocument:", error);
        res.status(500).json({ message: "Something went wrong while verifying the document" });
    } finally {
        client.release();
    }
};

// PATCH /api/v1/operator/vehicle-documents/:documentId/verify
// This did not exist before — vehicle documents could be uploaded but never
// reviewed, so their status sat on 'pending_review' forever.
const verifyVehicleDocument = async (req, res) => {
    const client = await pool.connect();

    try {
        const { documentId } = req.params;
        if (!/^\d+$/.test(documentId)) {
            return res.status(400).json({ message: "Invalid document id" });
        }

        const existing = await pool.query(
            `SELECT vd.*, v.driver_id FROM vehicle_documents vd
             JOIN vehicles v ON v.id = vd.vehicle_id
             WHERE vd.id = $1`,
            [documentId]
        );
        const doc = existing.rows[0];

        if (!doc) return res.status(404).json({ message: "Document not found" });

        if (!doc.is_current) {
            return res.status(400).json({
                message: "This document has been replaced by a newer upload",
                error_code: "DOCUMENT_SUPERSEDED"
            });
        }

        const parsed = validateVerifyBody(req.body, doc.document_type);
        if (parsed.error) return res.status(400).json({ message: parsed.error });

        await client.query("BEGIN");

        const updated = await client.query(
            `UPDATE vehicle_documents
             SET status = $1, rejection_reason = $2, expires_at = $3,
                 verified_by = $4, verified_at = NOW()
             WHERE id = $5
             RETURNING *`,
            [parsed.status, parsed.rejectionReason, parsed.expiryDate, req.user.id, documentId]
        );

        const vehicleStatus = await recomputeVehicleStatus(client, doc.vehicle_id);
        const driverStatus = doc.driver_id
            ? await recomputeDriverStatus(client, doc.driver_id)
            : null;

        await client.query("COMMIT");

        res.status(200).json({
            message: parsed.status === "approved" ? "Document approved" : "Document rejected",
            document: toVehicleDocument(updated.rows[0]),
            vehicle_status: vehicleStatus,
            driver_status: driverStatus
        });

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        console.error("Error in verifyVehicleDocument:", error);
        res.status(500).json({ message: "Something went wrong while verifying the document" });
    } finally {
        client.release();
    }
};

// -----------------------------------------------------------------------------
// Details the operator reads off the documents
// -----------------------------------------------------------------------------

// PATCH /api/v1/operator/drivers/:id/details
// NI number, licence numbers, date of birth, address — the operator has the
// documents in front of them, so they type these rather than the driver.
const updateDriverDetails = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid driver id" });
        }

        const { ni_number, driving_licence_number, pco_licence_number, date_of_birth, address } = req.body;

        if (!ni_number && !driving_licence_number && !pco_licence_number && !date_of_birth && !address) {
            return res.status(400).json({
                message: "Provide at least one of: ni_number, driving_licence_number, pco_licence_number, date_of_birth, address"
            });
        }

        if (date_of_birth && !parseExpiryDate(date_of_birth)) {
            return res.status(400).json({ message: "date_of_birth must be in YYYY-MM-DD format" });
        }

        // Stored without spaces and upper-cased so the same number cannot be
        // entered two different ways
        const cleanNi = ni_number ? String(ni_number).replace(/\s/g, "").toUpperCase() : null;

        if (cleanNi && !NI_REGEX.test(cleanNi)) {
            return res.status(400).json({
                message: "ni_number must be a valid UK National Insurance number (e.g. AB123456C)"
            });
        }

        // PCO/PHV licence numbers are numeric, typically 5-8 digits
        if (pco_licence_number && !/^\d{5,8}$/.test(String(pco_licence_number).trim())) {
            return res.status(400).json({ message: "pco_licence_number must be 5-8 digits" });
        }

        const updated = await pool.query(
            `UPDATE users
             SET ni_number              = COALESCE($1, ni_number),
                 driving_licence_number = COALESCE($2, driving_licence_number),
                 pco_licence_number     = COALESCE($3, pco_licence_number),
                 date_of_birth          = COALESCE($4, date_of_birth),
                 address                = COALESCE($5, address),
                 updated_at             = NOW()
             WHERE id = $6 AND role = 'driver'
             RETURNING id, first_name, last_name, date_of_birth, ni_number, address, postcode,
                       driving_licence_number, pco_licence_number, status`,
            [
                cleanNi,
                driving_licence_number ? String(driving_licence_number).trim().toUpperCase() : null,
                pco_licence_number ? String(pco_licence_number).trim() : null,
                date_of_birth || null,
                address ? String(address).trim() : null,
                id
            ]
        );

        if (updated.rows.length === 0) {
            return res.status(404).json({ message: "Driver not found" });
        }

        res.status(200).json({
            message: "Driver details updated",
            driver: updated.rows[0]
        });

    } catch (error) {
        console.error("Error in updateDriverDetails:", error);
        res.status(500).json({ message: "Something went wrong while updating driver details" });
    }
};

// PATCH /api/v1/operator/vehicles/:id/details
// The vehicle's own PCO licence number, read off its paperwork.
const updateVehicleDetails = async (req, res) => {
    try {
        const { id } = req.params;
        const { pco_licence_number } = req.body;

        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid vehicle id" });
        }

        if (!pco_licence_number) {
            return res.status(400).json({ message: "pco_licence_number is required" });
        }

        if (!/^\d{5,8}$/.test(String(pco_licence_number).trim())) {
            return res.status(400).json({ message: "pco_licence_number must be 5-8 digits" });
        }

        const updated = await pool.query(
            `UPDATE vehicles SET pco_licence_number = $1, updated_at = NOW()
             WHERE id = $2 RETURNING *`,
            [String(pco_licence_number).trim(), id]
        );

        if (updated.rows.length === 0) {
            return res.status(404).json({ message: "Vehicle not found" });
        }

        res.status(200).json({
            message: "Vehicle details updated",
            vehicle: updated.rows[0]
        });

    } catch (error) {
        console.error("Error in updateVehicleDetails:", error);
        res.status(500).json({ message: "Something went wrong while updating the vehicle" });
    }
};

// PATCH /api/v1/operator/drivers/:id/suspend
const setDriverSuspension = async (req, res) => {
    const client = await pool.connect();

    try {
        const { id } = req.params;
        const { suspended } = req.body;

        if (typeof suspended !== "boolean") {
            return res.status(400).json({ message: "suspended must be true or false" });
        }

        await client.query("BEGIN");

        if (suspended) {
            const updated = await client.query(
                `UPDATE users SET status = 'suspended', updated_at = NOW()
                 WHERE id = $1 AND role = 'driver' RETURNING id, status`,
                [id]
            );

            if (updated.rows.length === 0) {
                await client.query("ROLLBACK");
                return res.status(404).json({ message: "Driver not found" });
            }

            await client.query("COMMIT");
            return res.status(200).json({ message: "Driver suspended", driver: updated.rows[0] });
        }

        // Lifting a suspension puts the driver back wherever their paperwork
        // actually places them, rather than guessing
        await client.query(
            "UPDATE users SET status = 'account_created' WHERE id = $1 AND role = 'driver'",
            [id]
        );
        const status = await recomputeDriverStatus(client, id);

        await client.query("COMMIT");

        res.status(200).json({
            message: "Suspension lifted",
            driver: { id: Number(id), status }
        });

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        console.error("Error in setDriverSuspension:", error);
        res.status(500).json({ message: "Something went wrong" });
    } finally {
        client.release();
    }
};

// REMOVED: confirmDriverType — internal vs external no longer exists.

// -----------------------------------------------------------------------------
// Share code lookup
// -----------------------------------------------------------------------------
// A driver has handed over their ID and PIN. Two different questions follow,
// and they are deliberately answered in two different places:
//
//   "Is this person verified?"   answered immediately, no permission needed. It
//                                is the whole reason the driver gave out the
//                                code in the first place.
//
//   "Show me the documents."     a request the driver has to allow, and then
//                                only for thirty minutes.
//
// A driver proving they are licensed should not have to hand over their
// passport to do it.

// POST /api/v1/operator/driver-lookup
// { "share_id": "MV-1A2B-3C4", "pin": "451203" }
const lookupDriverByShareCode = async (req, res) => {
    try {
        const { share_id, pin } = req.body || {};

        if (!share_id || !pin) {
            return res.status(400).json({
                message: "share_id and pin are required",
                error_code: "MISSING_FIELDS"
            });
        }

        // Still locked out from earlier wrong guesses?
        const lockedFor = await shareAccess.failureLockoutSeconds(req.user.id);
        if (lockedFor > 0) {
            return res.status(429).json({
                message: "Too many incorrect codes. Please try again later.",
                error_code: "LOOKUP_LOCKED",
                retry_after_seconds: lockedFor
            });
        }

        const driver = await shareAccess.findByShareCode(share_id, pin);

        if (!driver) {
            await shareAccess.recordAttempt(
                req.user.id, shareAccess.normaliseShareId(share_id), false
            );

            // One message for a wrong ID and a wrong PIN alike. Two different
            // messages would let somebody sweep the ID space to find out which
            // codes are real.
            return res.status(404).json({
                message: "No driver found with that ID and PIN",
                error_code: "SHARE_CODE_NOT_FOUND"
            });
        }

        await shareAccess.recordAttempt(req.user.id, driver.share_id, true);

        const outcome = await shareAccess.createRequest(req.user.id, driver);

        if (outcome.isNew) {
            notifyAccessRequest(driver.id, outcome.request.id);
        }

        // What comes back with no permission at all: a name, and whether this
        // driver is verified. Nothing else — no date of birth, no National
        // Insurance number, no contact details, no documents.
        res.status(200).json({
            driver: {
                id: driver.id,
                full_name: [driver.first_name, driver.middle_name, driver.last_name]
                    .filter(Boolean).join(" "),
                share_id: driver.share_id,
                is_verified: driver.status === "approved",
                status: driver.status
            },

            access: {
                request_id: outcome.request.id,
                status: outcome.status,
                expires_at: outcome.request.expires_at || null,
                message: outcome.status === "approved"
                    ? "You already have permission to view this driver's documents."
                    : "The driver has been asked. You will be notified when they answer."
            }
        });

    } catch (error) {
        console.error("Error in lookupDriverByShareCode:", error);
        res.status(500).json({ message: "Something went wrong while looking up the driver" });
    }
};

// GET /api/v1/operator/shared-drivers/:id/documents
//
// The same documents an operator sees for their own drivers, reached through a
// grant instead of through the verification queue.
const getSharedDriverDocuments = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid driver id" });
        }

        const grant = await shareAccess.activeGrant(req.user.id, Number(id));

        if (!grant) {
            // Covers all three of: never asked, denied, and expired. The
            // operator does not need those told apart, and what the driver
            // decided is not their business beyond yes or no.
            return res.status(403).json({
                message: "You do not have permission to view this driver's documents",
                error_code: "ACCESS_NOT_GRANTED"
            });
        }

        const driverResult = await pool.query(
            "SELECT * FROM users WHERE id = $1 AND role = 'driver'",
            [id]
        );
        const driver = driverResult.rows[0];
        if (!driver) return res.status(404).json({ message: "Driver not found" });

        const docs = await pool.query(
            `SELECT * FROM driver_documents
             WHERE user_id = $1 AND is_current
             ORDER BY document_type`,
            [id]
        );

        const vehicles = await pool.query(
            "SELECT * FROM vehicles WHERE driver_id = $1 ORDER BY created_at ASC",
            [id]
        );

        const vehicleDocs = await pool.query(
            `SELECT vd.* FROM vehicle_documents vd
             JOIN vehicles v ON v.id = vd.vehicle_id
             WHERE v.driver_id = $1 AND vd.is_current`,
            [id]
        );

        // No notifyDocumentsViewed here. The driver was asked a moment ago and
        // tapped Allow; telling them again that their documents were opened
        // would be noise, not news.

        res.status(200).json({
            driver: maskDriverContact({
                id: driver.id,
                title: driver.title,
                first_name: driver.first_name,
                middle_name: driver.middle_name,
                last_name: driver.last_name,
                full_name: [driver.first_name, driver.middle_name, driver.last_name]
                    .filter(Boolean).join(" "),
                date_of_birth: driver.date_of_birth,
                email: driver.email,
                phone: driver.phone,
                ni_number: driver.ni_number,
                address: driver.address,
                postcode: driver.postcode,
                driving_licence_number: driver.driving_licence_number,
                pco_licence_number: driver.pco_licence_number,
                status: driver.status,
                created_at: driver.created_at
            }, req.user.role),

            documents: docs.rows.map(toDocument),

            vehicles: vehicles.rows.map((v) => {
                const its = vehicleDocs.rows.filter((d) => d.vehicle_id === v.id);
                return { ...v, documents: its.map(toVehicleDocument) };
            }),

            access: {
                request_id: grant.id,
                expires_at: grant.expires_at
            }
        });

    } catch (error) {
        console.error("Error in getSharedDriverDocuments:", error);
        res.status(500).json({ message: "Something went wrong while fetching the documents" });
    }
};

module.exports = {
    getPendingDrivers,
    getDriverDetail,
    lookupDriverByShareCode,
    getSharedDriverDocuments,
    verifyDriverDocument,
    verifyVehicleDocument,
    updateDriverDetails,
    updateVehicleDetails,
    setDriverSuspension,
    recomputeDriverStatus,
    recomputeVehicleStatus
};