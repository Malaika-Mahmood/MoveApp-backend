const pool = require("../config/db");
const storage = require("../services/storageService");
const { detectFileType } = require("../utils/fileType");
const {
    REQUIRED_VEHICLE_DOCUMENTS,
    DOCUMENT_SOURCES,
    DOCUMENT_LABELS
} = require("../constants/documents");

const toVehicleDocument = (d) => ({
    id: d.id,
    vehicle_id: d.vehicle_id,
    document_type: d.document_type,
    label: DOCUMENT_LABELS[d.document_type] || d.document_type,
    file_url: `/api/v1/documents/vehicle/${d.id}/file`,
    file_format: d.file_format,
    file_size: d.file_size,
    source: d.source,
    status: d.status,
    rejection_reason: d.rejection_reason,
    expires_at: d.expires_at,
    uploaded_at: d.uploaded_at
});

// POST /api/v1/vehicles
// The driver comes from the token, so nobody can add a vehicle to someone else.
const addVehicle = async (req, res) => {
    try {
        const driverId = req.user.id;
        const { vehicle_class, make, model, year, registration_number, colour, color, seats, luggage } = req.body;

        if (req.user.role !== "driver") {
            return res.status(403).json({
                message: "Only drivers can add vehicles",
                error_code: "FORBIDDEN"
            });
        }

        if (!vehicle_class || !make || !model || !registration_number) {
            return res.status(400).json({
                message: "vehicle_class, make, model and registration_number are required"
            });
        }

        // During registration a driver adds exactly one vehicle. More can be
        // added from Vehicle Information once the account is verified.
        if (req.user.status !== "approved") {
            const existing = await pool.query(
                "SELECT id FROM vehicles WHERE driver_id = $1",
                [driverId]
            );

            if (existing.rows.length > 0) {
                return res.status(400).json({
                    message: "You can add more vehicles once your account is verified",
                    error_code: "VEHICLE_LIMIT_UNVERIFIED"
                });
            }
        }

        // UK plates have no spaces in the database, so "LX21 XYZ" and "LX21XYZ"
        // cannot both be registered as different vehicles.
        const cleanReg = String(registration_number).replace(/\s/g, "").toUpperCase();

        const newVehicle = await pool.query(
            `INSERT INTO vehicles
                (registration_number, make, model, vehicle_class, year, color,
                 seats, luggage, driver_id, owner_type, availability_status, verification_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'driver', 'available', 'pending_verification')
             RETURNING *`,
            [
                cleanReg,
                String(make).trim(),
                String(model).trim(),
                String(vehicle_class).trim(),
                year || null,
                (colour || color) ? String(colour || color).trim() : null,
                seats || null,
                luggage || null,
                driverId
            ]
        );

        res.status(201).json({
            message: "Vehicle added successfully. Upload its documents to complete verification.",
            vehicle: newVehicle.rows[0]
        });

    } catch (error) {
        if (error.code === "23505") {
            return res.status(409).json({
                message: "A vehicle with this registration number already exists",
                error_code: "DUPLICATE_REGISTRATION"
            });
        }
        console.error("Error in addVehicle:", error);
        res.status(500).json({ message: "Something went wrong while adding the vehicle" });
    }
};

// GET /api/v1/vehicles/me
const getMyVehicles = async (req, res) => {
    try {
        const vehicles = await pool.query(
            "SELECT * FROM vehicles WHERE driver_id = $1 ORDER BY created_at DESC",
            [req.user.id]
        );

        res.status(200).json({
            vehicles: vehicles.rows,
            can_add_more: req.user.status === "approved" || vehicles.rows.length === 0
        });

    } catch (error) {
        console.error("Error in getMyVehicles:", error);
        res.status(500).json({ message: "Something went wrong while fetching vehicles" });
    }
};

// Confirms the vehicle exists and belongs to whoever is asking
const loadOwnedVehicle = async (vehicleId, user) => {
    if (!/^\d+$/.test(String(vehicleId))) return { error: "invalid" };

    const result = await pool.query("SELECT * FROM vehicles WHERE id = $1", [vehicleId]);
    const vehicle = result.rows[0];

    if (!vehicle) return { error: "not_found" };
    if (user.role !== "operator" && vehicle.driver_id !== user.id) return { error: "forbidden" };

    return { vehicle };
};

// POST /api/v1/vehicles/:id/documents
const uploadVehicleDocument = async (req, res) => {
    const client = await pool.connect();
    let savedKey = null;

    try {
        const { id } = req.params;
        const { document_type, source } = req.body;

        const { vehicle, error } = await loadOwnedVehicle(id, req.user);
        if (error === "invalid") return res.status(400).json({ message: "Invalid vehicle id" });
        if (error === "not_found") return res.status(404).json({ message: "Vehicle not found" });
        if (error === "forbidden") {
            return res.status(403).json({
                message: "This vehicle does not belong to you",
                error_code: "FORBIDDEN"
            });
        }

        if (!document_type) {
            return res.status(400).json({ message: "document_type is required" });
        }

        if (!REQUIRED_VEHICLE_DOCUMENTS.includes(document_type)) {
            return res.status(400).json({
                message: `document_type must be one of: ${REQUIRED_VEHICLE_DOCUMENTS.join(", ")}`
            });
        }

        if (source && !DOCUMENT_SOURCES.includes(source)) {
            return res.status(400).json({
                message: `source must be one of: ${DOCUMENT_SOURCES.join(", ")}`
            });
        }

        if (!req.file) {
            return res.status(400).json({
                message: "No file uploaded. Send it as form-data under the key 'file'.",
                error_code: "FILE_MISSING"
            });
        }

        const detected = detectFileType(req.file.buffer);
        if (!detected) {
            return res.status(400).json({
                message: "File must be a JPG, PNG or PDF",
                error_code: "INVALID_FILE_TYPE"
            });
        }

        const saved = await storage.save(req.file.buffer, detected.ext);
        savedKey = saved.key;

        await client.query("BEGIN");

        await client.query(
            `UPDATE vehicle_documents SET is_current = FALSE
             WHERE vehicle_id = $1 AND document_type = $2 AND is_current`,
            [vehicle.id, document_type]
        );

        const inserted = await client.query(
            `INSERT INTO vehicle_documents
                (vehicle_id, document_type, file_url, storage_key, file_format,
                 file_size, source, status, is_current)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_review', TRUE)
             RETURNING *`,
            [vehicle.id, document_type, "", saved.key, detected.mime, saved.size, source || null]
        );

        const doc = inserted.rows[0];

        await client.query(
            "UPDATE vehicle_documents SET file_url = $1 WHERE id = $2",
            [`/api/v1/documents/vehicle/${doc.id}/file`, doc.id]
        );

        const current = await client.query(
            "SELECT document_type FROM vehicle_documents WHERE vehicle_id = $1 AND is_current",
            [vehicle.id]
        );
        const have = current.rows.map((r) => r.document_type);
        const missing = REQUIRED_VEHICLE_DOCUMENTS.filter((t) => !have.includes(t));

        await client.query("COMMIT");
        savedKey = null;

        res.status(201).json({
            message: "Vehicle document uploaded successfully",
            document: toVehicleDocument(doc),
            missing_documents: missing,
            all_documents_complete: missing.length === 0
        });

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        if (savedKey) await storage.remove(savedKey).catch(() => { });

        console.error("Error in uploadVehicleDocument:", error);
        res.status(500).json({ message: "Something went wrong while uploading the vehicle document" });

    } finally {
        client.release();
    }
};

// GET /api/v1/vehicles/:id/documents
const getVehicleDocuments = async (req, res) => {
    try {
        const { id } = req.params;

        const { vehicle, error } = await loadOwnedVehicle(id, req.user);
        if (error === "invalid") return res.status(400).json({ message: "Invalid vehicle id" });
        if (error === "not_found") return res.status(404).json({ message: "Vehicle not found" });
        if (error === "forbidden") {
            return res.status(403).json({
                message: "This vehicle does not belong to you",
                error_code: "FORBIDDEN"
            });
        }

        const docs = await pool.query(
            `SELECT * FROM vehicle_documents
             WHERE vehicle_id = $1 AND is_current
             ORDER BY uploaded_at DESC`,
            [vehicle.id]
        );

        const have = docs.rows.map((d) => d.document_type);
        const missing = REQUIRED_VEHICLE_DOCUMENTS.filter((t) => !have.includes(t));

        res.status(200).json({
            vehicle_id: vehicle.id,
            documents: docs.rows.map(toVehicleDocument),
            required_documents: REQUIRED_VEHICLE_DOCUMENTS,
            labels: DOCUMENT_LABELS,
            missing_documents: missing,
            rejected_documents: docs.rows.filter((d) => d.status === "rejected").map(toVehicleDocument),
            is_complete: missing.length === 0,
            verification_status: vehicle.verification_status
        });

    } catch (error) {
        console.error("Error in getVehicleDocuments:", error);
        res.status(500).json({ message: "Something went wrong while fetching vehicle documents" });
    }
};

// GET /api/v1/documents/vehicle/:id/file
const getVehicleDocumentFile = async (req, res) => {
    try {
        const { id } = req.params;

        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid document id" });
        }

        const result = await pool.query(
            `SELECT vd.id, vd.storage_key, vd.file_format, v.driver_id
             FROM vehicle_documents vd
             JOIN vehicles v ON v.id = vd.vehicle_id
             WHERE vd.id = $1`,
            [id]
        );

        const doc = result.rows[0];
        if (!doc) return res.status(404).json({ message: "Document not found" });

        const isOwner = doc.driver_id === req.user.id;
        const isOperator = req.user.role === "operator";

        if (!isOwner && !isOperator) {
            return res.status(403).json({
                message: "You do not have permission to view this document",
                error_code: "FORBIDDEN"
            });
        }

        if (!doc.storage_key || !(await storage.exists(doc.storage_key))) {
            return res.status(404).json({ message: "File is no longer available" });
        }

        res.setHeader("Content-Type", doc.file_format || "application/octet-stream");
        res.setHeader("Cache-Control", "private, no-store");

        const stream = storage.createReadStream(doc.storage_key);
        stream.on("error", (err) => {
            console.error("Error streaming vehicle document", id, err);
            if (!res.headersSent) res.status(500).json({ message: "Could not read the file" });
        });
        stream.pipe(res);

    } catch (error) {
        console.error("Error in getVehicleDocumentFile:", error);
        res.status(500).json({ message: "Something went wrong while fetching the file" });
    }
};

module.exports = {
    addVehicle,
    getMyVehicles,
    uploadVehicleDocument,
    getVehicleDocuments,
    getVehicleDocumentFile,
    toVehicleDocument
};