const pool = require("../config/db");
const storage = require("../services/storageService");
const { detectFileType } = require("../utils/fileType");
const { buildDriverDocumentPdf } = require("../services/pdfService");
const {
    REQUIRED_DRIVER_DOCUMENTS,
    OPTIONAL_DRIVER_DOCUMENTS,
    ALL_DRIVER_DOCUMENTS,
    DOCUMENT_SOURCES,
    DOCUMENT_LABELS,
    ADDITIONAL_DRIVER_DOCUMENTS,
    ADDITIONAL_DOCUMENT_GROUPS,
    MIN_ADDITIONAL_DOCUMENTS,
    DOCUMENT_RECENCY_HINTS,
} = require("../constants/documents");
const { canSeeDriverContact } = require("../utils/masking");

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

// How far through step 2 the driver is.
//
// There are three kinds of document now, not two. "Required" means every one
// of them; "optional" means none of them are needed; this third kind is a
// COUNT — any two of nine. Neither of the other lists can express that, which
// is why it gets its own reckoning rather than being folded into them.
//
// Uploaded and approved are counted separately on purpose. Uploading is enough
// to move a driver into the review queue; only approval lets them work.
const additionalProgress = (haveTypes) => {
    const chosen = ADDITIONAL_DRIVER_DOCUMENTS.filter((t) => haveTypes.includes(t));

    return {
        chosen,
        count: chosen.length,
        remaining: Math.max(0, MIN_ADDITIONAL_DOCUMENTS - chosen.length),
        enough: chosen.length >= MIN_ADDITIONAL_DOCUMENTS
    };
};

// Vehicles with their current documents, in the shape the PDF builder wants
const loadVehiclesWithDocuments = async (driverId) => {
    const vehicles = await pool.query(
        "SELECT * FROM vehicles WHERE driver_id = $1 ORDER BY created_at ASC",
        [driverId]
    );

    if (vehicles.rows.length === 0) return [];

    const docs = await pool.query(
        `SELECT vd.* FROM vehicle_documents vd
         JOIN vehicles v ON v.id = vd.vehicle_id
         WHERE v.driver_id = $1 AND vd.is_current`,
        [driverId]
    );

    return vehicles.rows.map((v) => ({
        ...v,
        documents: docs.rows.filter((d) => d.vehicle_id === v.id)
    }));
};

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

        // Is everything now present? Two separate tests: every REQUIRED
        // document, and any two of the ADDITIONAL ones. Optional documents
        // never count towards either.
        const current = await client.query(
            `SELECT document_type FROM driver_documents
             WHERE user_id = $1 AND is_current`,
            [driverId]
        );
        const have = current.rows.map((r) => r.document_type);
        const missing = REQUIRED_DRIVER_DOCUMENTS.filter((t) => !have.includes(t));
        const additional = additionalProgress(have);

        // Both halves of step 1 and step 2 have to be in before the driver is
        // worth an operator's time. A queue entry that turns out to be missing
        // an address proof is a review the operator has to abandon halfway.
        const allUploaded = missing.length === 0 && additional.enough;

        // Move the driver into the queue once everything is in and they have a
        // vehicle. 'rejected' is included so a driver who re-uploads after a
        // rejection goes back into the queue.
        if (allUploaded) {
            const vehicles = await client.query(
                "SELECT id FROM vehicles WHERE driver_id = $1",
                [driverId]
            );

            if (vehicles.rows.length > 0) {
                await client.query(
                    `UPDATE users SET status = 'pending_verification', updated_at = NOW()
                     WHERE id = $1 AND status IN ('account_created', 'rejected')`,
                    [driverId]
                );
            }
        }

        // An approved driver who replaces a document goes back into the queue —
        // the new file has not been looked at by anyone yet.
        if (req.user.status === "approved") {
            await client.query(
                "UPDATE users SET status = 'pending_verification', updated_at = NOW() WHERE id = $1",
                [driverId]
            );
        }

        // A driver locked out by an expired document has just replaced it — and
        // the lock deliberately STAYS ON until an operator has seen the new file
        // and set its expiry date.
        //
        // This is the safe reading of the rule. These are PCO licences and
        // insurance certificates; until somebody has confirmed the new file is
        // genuine and in date, the driver should not be back on the road. If the
        // upload cleared the lock by itself, re-uploading the same expired
        // photograph would be enough to unlock the account.
        //
        // The upload still succeeds (201) while suspended — that much is
        // essential, because the driver is the only person who can fix this, so
        // they have to be able to. See middleware/authenticate.js.
        //
        // The lock is cleared in operatorController.recomputeDriverStatus, once
        // every required document and the vehicle are approved.

        await client.query("COMMIT");
        savedKey = null;   // committed, so the file must be kept

        res.status(201).json({
            message: "Document uploaded successfully",
            document: toDocument({ ...doc, file_url: storage.buildFileUrl(doc.id) }),
            missing_documents: missing,

            // So the upload screen can update its "1 of 2 selected" counter
            // from the response it already has, without a second request.
            additional_documents: {
                needed: MIN_ADDITIONAL_DOCUMENTS,
                chosen: additional.chosen,
                remaining: additional.remaining
            },

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
        const additional = additionalProgress(have);
        const rejected = docs.rows.filter((d) => d.status === "rejected");

        res.status(200).json({
            documents: docs.rows.map(toDocument),

            required_documents: REQUIRED_DRIVER_DOCUMENTS,
            optional_documents: OPTIONAL_DRIVER_DOCUMENTS,
            labels: DOCUMENT_LABELS,

            missing_documents: missingRequired,
            missing_optional_documents: missingOptional,

            // Step 2 of the document screens.
            //
            // `groups` is what the app draws — two headings, with the types
            // under each. It is sent from here rather than hard-coded in the
            // app so the two cannot drift apart, which is the whole reason
            // labels live on this side too.
            //
            // The rule the backend actually enforces is `needed`, and it does
            // not care which group they came from: any two.
            //
            // `recency_hints` is the "issued within the last 3 months" line
            // under each one. The server does not check it — the operator
            // reads the date while approving — but both sides should at least
            // tell the driver the same thing.
            additional_documents: {
                groups: ADDITIONAL_DOCUMENT_GROUPS,
                needed: MIN_ADDITIONAL_DOCUMENTS,
                chosen: additional.chosen,
                remaining: additional.remaining,
                recency_hints: DOCUMENT_RECENCY_HINTS
            },

            // Documents the driver must replace, with the operator's reason
            rejected_documents: rejected.map(toDocument),

            // Uploaded, not approved. The app uses this to decide whether the
            // driver may leave the document screens, not whether they can work.
            is_complete: missingRequired.length === 0 && additional.enough,

            driver_status: req.user.status
        });

    } catch (error) {
        console.error("Error in getMyDocuments:", error);
        res.status(500).json({ message: "Something went wrong while fetching documents" });
    }
};

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

        const vehicles = await loadVehiclesWithDocuments(req.user.id);
        const pdfBuffer = await buildDriverDocumentPdf(req.user, docs.rows, vehicles);

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
// GET /api/v1/admin/drivers/:id/documents/pdf
//
// One handler, two routes. Both copies show each document's review status; the
// difference is the contact details, and that is decided from the token rather
// than the route — a route can be moved or reused, a role cannot be faked.
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

        const vehicles = await loadVehiclesWithDocuments(id);

        const pdfBuffer = await buildDriverDocumentPdf(driver, docs.rows, vehicles, {
            showStatus: true,
            showContact: canSeeDriverContact(req.user.role)
        });

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

        // The owning driver, any operator, or an admin. Admins need this for
        // compliance requests — DVSA, an insurer or the police asking for one
        // specific document rather than the whole pack.
        const isOwner = doc.user_id === req.user.id;
        const isOperator = req.user.role === "operator";
        const isAdmin = req.user.role === "admin";

        if (!isOwner && !isOperator && !isAdmin) {
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
const deprecated = (req, res) => {
    res.status(410).json({
        message: "This endpoint has been replaced. Use /api/v1/drivers/me/documents with a Bearer token."
    });
};

// GET /api/v1/admin/drivers/:id/documents/pdf
//
// The admin's copy of a driver pack is the same document as the operator's —
// full pack, review status shown. Rather than copying forty lines to change
// nothing, the same handler serves both. The routes differ in who may reach
// them: authorize("operator") + requireApprovedOperator on one,
// authorize("admin") on the other.
const getDriverDocumentsPdfForAdmin = getDriverDocumentsPdfForOperator;

module.exports = {
    uploadDocument,
    getMyDocuments,
    getMyDocumentsPdf,
    getDriverDocumentsPdfForOperator,
    getDriverDocumentsPdfForAdmin,
    getDocumentFile,
    deprecated,
    toDocument
};