const pool = require("../config/db");
const { toDocument } = require("./documentController");
const { toVehicleDocument } = require("./vehicleController");
const {
    REQUIRED_DRIVER_DOCUMENTS,
    OPTIONAL_DRIVER_DOCUMENTS,
    REQUIRED_VEHICLE_DOCUMENTS,
    DRIVER_DOCUMENTS_WITH_EXPIRY,
    VEHICLE_DOCUMENTS_WITH_EXPIRY,
    documentNeedsExpiry,
    DOCUMENT_LABELS
} = require("../constants/documents");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
        "SELECT status, driver_type_confirmed FROM users WHERE id = $1",
        [driverId]
    );
    const user = userResult.rows[0];
    if (!user) return null;

    // A suspension is an operator decision, not something documents can undo
    if (user.status === "suspended") return "suspended";

    const docs = await client.query(
        "SELECT document_type, status FROM driver_documents WHERE user_id = $1 AND is_current",
        [driverId]
    );
    const byType = new Map(docs.rows.map((d) => [d.document_type, d.status]));

    const allPresent = REQUIRED_DRIVER_DOCUMENTS.every((t) => byType.has(t));
    const allApproved = REQUIRED_DRIVER_DOCUMENTS.every((t) => byType.get(t) === "approved");
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
    } else if (allApproved && hasApprovedVehicle && user.driver_type_confirmed) {
        // Everything required: all 10 documents, one fully approved vehicle,
        // and the operator has confirmed internal vs external
        status = "approved";
    } else if (allPresent && vehicles.rows.length > 0) {
        status = "pending_verification";
    } else {
        status = "account_created";
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

        const drivers = await pool.query(
            `SELECT id, title, first_name, middle_name, last_name, email, phone,
                    date_of_birth, ni_number, postcode, address,
                    driver_type, driver_type_confirmed, status, created_at
             FROM users
             WHERE role = 'driver' AND status = $1
             ORDER BY created_at ASC
             LIMIT $2 OFFSET $3`,
            [status, limit, offset]
        );

        const count = await pool.query(
            "SELECT COUNT(*)::int AS total FROM users WHERE role = 'driver' AND status = $1",
            [status]
        );
        const total = count.rows[0].total;

        res.status(200).json({
            drivers: drivers.rows,
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

        res.status(200).json({
            driver: {
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
                driver_type: driver.driver_type,
                driver_type_confirmed: driver.driver_type_confirmed,
                status: driver.status,
                created_at: driver.created_at
            },

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
// Licence numbers, date of birth, address — the operator has the documents in
// front of them, so they type these rather than the driver.
const updateDriverDetails = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid driver id" });
        }

        const { driving_licence_number, pco_licence_number, date_of_birth, address } = req.body;

        if (!driving_licence_number && !pco_licence_number && !date_of_birth && !address) {
            return res.status(400).json({
                message: "Provide at least one of: driving_licence_number, pco_licence_number, date_of_birth, address"
            });
        }

        if (date_of_birth && !parseExpiryDate(date_of_birth)) {
            return res.status(400).json({ message: "date_of_birth must be in YYYY-MM-DD format" });
        }

        // PCO/PHV licence numbers are numeric, typically 5-8 digits
        if (pco_licence_number && !/^\d{5,8}$/.test(String(pco_licence_number).trim())) {
            return res.status(400).json({ message: "pco_licence_number must be 5-8 digits" });
        }

        const updated = await pool.query(
            `UPDATE users
             SET driving_licence_number = COALESCE($1, driving_licence_number),
                 pco_licence_number     = COALESCE($2, pco_licence_number),
                 date_of_birth          = COALESCE($3, date_of_birth),
                 address                = COALESCE($4, address),
                 updated_at             = NOW()
             WHERE id = $5 AND role = 'driver'
             RETURNING id, first_name, last_name, date_of_birth, address, postcode,
                       driving_licence_number, pco_licence_number, status`,
            [
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

// PATCH /api/v1/operator/drivers/:id/type
// The driver claims internal or external; this is the operator confirming it.
// A driver cannot be approved until it has been confirmed.
const confirmDriverType = async (req, res) => {
    const client = await pool.connect();

    try {
        const { id } = req.params;
        const { driver_type } = req.body;

        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid driver id" });
        }

        if (!["internal", "external"].includes(driver_type)) {
            return res.status(400).json({ message: "driver_type must be 'internal' or 'external'" });
        }

        await client.query("BEGIN");

        const updated = await client.query(
            `UPDATE users
             SET driver_type = $1, driver_type_confirmed = TRUE, updated_at = NOW()
             WHERE id = $2 AND role = 'driver'
             RETURNING id, driver_type, driver_type_confirmed`,
            [driver_type, id]
        );

        if (updated.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "Driver not found" });
        }

        const driverStatus = await recomputeDriverStatus(client, id);

        await client.query("COMMIT");

        res.status(200).json({
            message: "Driver type confirmed",
            driver: updated.rows[0],
            driver_status: driverStatus
        });

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        console.error("Error in confirmDriverType:", error);
        res.status(500).json({ message: "Something went wrong while confirming the driver type" });
    } finally {
        client.release();
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

module.exports = {
    getPendingDrivers,
    getDriverDetail,
    verifyDriverDocument,
    verifyVehicleDocument,
    updateDriverDetails,
    confirmDriverType,
    updateVehicleDetails,
    setDriverSuspension,
    recomputeDriverStatus,
    recomputeVehicleStatus
};