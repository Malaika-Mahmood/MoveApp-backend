const pool = require("../config/db");
const storage = require("../services/storageService");
const { detectFileType } = require("../utils/fileType");
const { buildDriverDocumentPdf } = require("../services/pdfService");
const {
    REQUIRED_DRIVER_DOCUMENTS,
    OPTIONAL_DRIVER_DOCUMENTS,
    ALL_DRIVER_DOCUMENTS,
    DOCUMENT_SOURCES,
    DOCUMENT_LABELS
} = require("../constants/documents");

// One shape for a document everywhere it is returned
const toDocument = (d) => ({
    id: d.id,
    document_type: d.document_type,
    label: DOCUMENT_LABELS[d.document_type] || d.document_type,
    file_url: storage.buildFileUrl(d.id),
    file_format: d.file_format,
    file_size: d.file_size,
    source: d.source,
    status: d.status,
    rejection_reason: d.rejection_reason,
    expires_at: d.expires_at,
    uploaded_at: d.uploaded_at
});

// POST /api/v1/drivers/me/documents
// multipart/form-data: file, document_type, source
const uploadDocument = async (req, res) => {
    const client = await pool.connect();
    let savedKey = null;

    try {
        const driverId = req.user.id;   // from the token, never from the body
        const { document_type, source } = req.body;

        if (req.user.role !== "driver") {
            return res.status(403).json({
                message: "Only drivers upload driver documents",
                error_code: "FORBIDDEN"
            });
        }

        if (req.user.status === "approved") {
            return res.status(403).json({
                message: "Your documents are verified and can no longer be changed. Please contact the operator.",
                error_code: "PROFILE_LOCKED"
            });
        }

        if (!document_type) {
            return res.status(400).json({ message: "document_type is required" });
        }

        if (!ALL_DRIVER_DOCUMENTS.includes(document_type)) {
            return res.status(400).json({
                message: `document_type must be one of: ${ALL_DRIVER_DOCUMENTS.join(", ")}`
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

        // The client's Content-Type is a claim; the bytes are the evidence.
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

        // Re-uploading supersedes the previous version instead of adding a
        // second row. The old row stays for history but stops counting.
        await client.query(
            `UPDATE driver_documents
             SET is_current = FALSE
             WHERE user_id = $1 AND document_type = $2 AND is_current`,
            [driverId, document_type]
        );

        const inserted = await client.query(
            `INSERT INTO driver_documents
                (user_id, document_type, file_url, storage_key, file_format,
                 file_size, source, status, is_current)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_review', TRUE)
             RETURNING *`,
            [
                driverId,
                document_type,
                "",                       // filled in below, once the id exists
                saved.key,
                detected.mime,
                saved.size,
                source || null
            ]
        );

        const doc = inserted.rows[0];

        // file_url points at the protected endpoint, which needs the row id
        await client.query(
            "UPDATE driver_documents SET file_url = $1 WHERE id = $2",
            [storage.buildFileUrl(doc.id), doc.id]
        );

        // Are all the REQUIRED documents now present? Optional ones never count.
        const current = await client.query(
            `SELECT document_type FROM driver_documents
             WHERE user_id = $1 AND is_current`,
            [driverId]
        );
        const have = current.rows.map((r) => r.document_type);
        const missing = REQUIRED_DRIVER_DOCUMENTS.filter((t) => !have.includes(t));
        const allUploaded = missing.length === 0;

        // Move the driver into the queue once everything required is in.
        // 'rejected' is included so a driver who re-uploads after a rejection
        // goes back into the queue instead of being stuck.
        if (allUploaded) {
            await client.query(
                `UPDATE users SET status = 'pending_verification', updated_at = NOW()
                 WHERE id = $1 AND status IN ('account_created', 'rejected')`,
                [driverId]
            );
        }

        await client.query("COMMIT");
        savedKey = null;   // committed, so the file must be kept

        res.status(201).json({
            message: "Document uploaded successfully",
            document: toDocument({ ...doc, file_url: storage.buildFileUrl(doc.id) }),
            missing_documents: missing,
            all_documents_complete: allUploaded
        });

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });

        // The transaction rolled back, so a file written before the failure
        // would be an orphan nothing points to. Remove it.
        if (savedKey) await storage.remove(savedKey).catch(() => { });

        console.error("Error in uploadDocument:", error);
        res.status(500).json({ message: "Something went wrong while uploading the document" });

    } finally {
        client.release();
    }
};

// GET /api/v1/drivers/me/documents
const getMyDocuments = async (req, res) => {
    try {
        const driverId = req.user.id;

        const docs = await pool.query(
            `SELECT * FROM driver_documents
             WHERE user_id = $1 AND is_current
             ORDER BY uploaded_at DESC`,
            [driverId]
        );

        const have = docs.rows.map((d) => d.document_type);
        const missingRequired = REQUIRED_DRIVER_DOCUMENTS.filter((t) => !have.includes(t));
        const missingOptional = OPTIONAL_DRIVER_DOCUMENTS.filter((t) => !have.includes(t));
        const rejected = docs.rows.filter((d) => d.status === "rejected");

        res.status(200).json({
            documents: docs.rows.map(toDocument),

            required_documents: REQUIRED_DRIVER_DOCUMENTS,
            optional_documents: OPTIONAL_DRIVER_DOCUMENTS,
            labels: DOCUMENT_LABELS,

            missing_documents: missingRequired,
            missing_optional_documents: missingOptional,

            // Documents the driver must replace, with the operator's reason
            rejected_documents: rejected.map(toDocument),

            is_complete: missingRequired.length === 0,
            driver_status: req.user.status
        });

    } catch (error) {
        console.error("Error in getMyDocuments:", error);
        res.status(500).json({ message: "Something went wrong while fetching documents" });
    }
};

// GET /api/v1/documents/:id/file
//
// Replaces the old public /uploads folder. These are passports, licences and
// National Insurance documents — anyone who guessed a filename could previously
// download them.
const getDocumentFile = async (req, res) => {
    try {
        const { id } = req.params;

        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid document id" });
        }

        const result = await pool.query(
            "SELECT id, user_id, storage_key, file_format FROM driver_documents WHERE id = $1",
            [id]
        );

        const doc = result.rows[0];

        if (!doc) {
            return res.status(404).json({ message: "Document not found" });
        }

        // The owning driver, or any operator
        const isOwner = doc.user_id === req.user.id;
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
            console.error("Error streaming document", id, err);
            if (!res.headersSent) res.status(500).json({ message: "Could not read the file" });
        });
        stream.pipe(res);

    } catch (error) {
        console.error("Error in getDocumentFile:", error);
        res.status(500).json({ message: "Something went wrong while fetching the file" });
    }
};

// Old endpoints, replaced by the token-based ones above
// GET /api/v1/drivers/me/documents/pdf
// All of this driver's current documents in one PDF, cover page first.
const getMyDocumentsPdf = async (req, res) => {
    try {
        const docs = await pool.query(
            `SELECT * FROM driver_documents
             WHERE user_id = $1 AND is_current
             ORDER BY document_type`,
            [req.user.id]
        );

        if (docs.rows.length === 0) {
            return res.status(404).json({
                message: "You have not uploaded any documents yet",
                error_code: "NO_DOCUMENTS"
            });
        }

        const pdfBuffer = await buildDriverDocumentPdf(req.user, docs.rows);

        const filename = `moveapp-documents-${req.user.last_name}-${req.user.id}.pdf`
            .toLowerCase().replace(/[^a-z0-9.-]/g, "-");

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Cache-Control", "private, no-store");
        res.send(pdfBuffer);

    } catch (error) {
        console.error("Error in getMyDocumentsPdf:", error);
        res.status(500).json({ message: "Something went wrong while building the PDF" });
    }
};
// GET /api/v1/operator/drivers/:id/documents/pdf
// The operator's copy — same pack, but with review status shown.
const getDriverDocumentsPdfForOperator = async (req, res) => {
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

        if (!driver) {
            return res.status(404).json({ message: "Driver not found" });
        }

        const docs = await pool.query(
            "SELECT * FROM driver_documents WHERE user_id = $1 AND is_current",
            [id]
        );

        if (docs.rows.length === 0) {
            return res.status(404).json({
                message: "This driver has not uploaded any documents yet",
                error_code: "NO_DOCUMENTS"
            });
        }

        const pdfBuffer = await buildDriverDocumentPdf(driver, docs.rows, { showStatus: true });

        const filename = `moveapp-documents-${driver.last_name}-${driver.id}.pdf`
            .toLowerCase().replace(/[^a-z0-9.-]/g, "-");

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Cache-Control", "private, no-store");
        res.send(pdfBuffer);

    } catch (error) {
        console.error("Error in getDriverDocumentsPdfForOperator:", error);
        res.status(500).json({ message: "Something went wrong while building the PDF" });
    }
};
const deprecated = (req, res) => {
    res.status(410).json({
        message: "This endpoint has been replaced. Use /api/v1/drivers/me/documents with a Bearer token."
    });
};

module.exports = { uploadDocument, getMyDocuments, getMyDocumentsPdf, getDriverDocumentsPdfForOperator, getDocumentFile, deprecated, toDocument };