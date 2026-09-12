const pool = require("../config/db");
const storage = require("../services/storageService");
const { detectFileType } = require("../utils/fileType");
const { recomputeOperatorStatus } = require("../services/operatorStatus");
const { buildOperatorDocumentPdf } = require("../services/pdfService");
const { DOCUMENT_SOURCES } = require("../constants/documents");
const {
    REQUIRED_OPERATOR_DOCUMENTS,
    OPTIONAL_OPERATOR_DOCUMENTS,
    ALL_OPERATOR_DOCUMENTS,
    OPERATOR_DOCUMENTS_WITH_EXPIRY,
    OPERATOR_DOCUMENT_LABELS,
    OPERATOR_DOCUMENT_GROUPS
} = require("../constants/operatorDocuments");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// UK postcode, e.g. W1U 3BW / SW1A 1AA / M1 1AE
const POSTCODE_REGEX = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

const VALID_TITLES = ["Mr", "Mrs", "Ms"];

// An operator runs a licensed private hire business rather than driving, so
// the driver's minimum of 21 does not apply — 18 is the age at which someone
// can hold a company directorship in the UK.
const MIN_OPERATOR_AGE = 18;

const toOperatorDocument = (d) => ({
    id: d.id,
    document_type: d.document_type,
    label: OPERATOR_DOCUMENT_LABELS[d.document_type] || d.document_type,
    file_url: `/api/v1/documents/operator/${d.id}/file`,
    file_format: d.file_format,
    file_size: d.file_size,
    source: d.source,
    status: d.status,
    rejection_reason: d.rejection_reason,
    expires_at: d.expires_at,
    uploaded_at: d.uploaded_at
});

const toCouncil = (c) => ({
    id: c.id,
    council_name: c.council_name,
    licence_number: c.licence_number,
    expires_at: c.expires_at,
    file_url: c.storage_key ? `/api/v1/documents/council/${c.id}/file` : null,
    file_format: c.file_format,
    status: c.status,
    rejection_reason: c.rejection_reason,
    created_at: c.created_at
});

const toOperatorProfile = (u) => ({
    id: u.id,
    title: u.title,
    first_name: u.first_name,
    middle_name: u.middle_name,
    last_name: u.last_name,
    full_name: [u.first_name, u.middle_name, u.last_name].filter(Boolean).join(" "),
    date_of_birth: u.date_of_birth,
    email: u.email,
    phone: u.phone,
    address: u.address,
    postcode: u.postcode,
    role: u.role,
    status: u.status,
    created_at: u.created_at,

    // The same idea as the driver's onboarding flag, so the app knows whether
    // to send the operator to the profile screen before the documents screen.
    // The company name is gone from the whole product. MoveApp IS Eurocars
    // London, so printing the company on every operator said nothing — every
    // operator belongs to the same one, and a driver from outside has no
    // company at all. The database column is left in place, unused, so that no
    // existing row has to be touched.
    onboarding: {
        profile_complete: Boolean(
            u.address && u.postcode && u.title && u.date_of_birth
        )
    }
});

// GET /api/v1/operators/me
const getMe = async (req, res) => {
    try {
        if (req.user.role !== "operator") {
            return res.status(403).json({ message: "Operators only", error_code: "FORBIDDEN" });
        }

        const docs = await pool.query(
            "SELECT * FROM operator_documents WHERE user_id = $1 AND is_current",
            [req.user.id]
        );
        const councils = await pool.query(
            "SELECT * FROM operator_councils WHERE user_id = $1 ORDER BY created_at ASC",
            [req.user.id]
        );

        const have = docs.rows.map((d) => d.document_type);
        const missing = REQUIRED_OPERATOR_DOCUMENTS.filter((t) => !have.includes(t));

        res.status(200).json({
            operator: toOperatorProfile(req.user),
            documents: docs.rows.map(toOperatorDocument),
            councils: councils.rows.map(toCouncil),

            required_documents: REQUIRED_OPERATOR_DOCUMENTS,

            // Shown with a "Skip now" button, the same as the driver's optional
            // documents. Never blocks verification.
            optional_documents: OPTIONAL_OPERATOR_DOCUMENTS,

            document_groups: OPERATOR_DOCUMENT_GROUPS,
            expiry_required: OPERATOR_DOCUMENTS_WITH_EXPIRY,
            labels: OPERATOR_DOCUMENT_LABELS,

            missing_documents: missing,
            rejected_documents: docs.rows.filter((d) => d.status === "rejected").map(toOperatorDocument),
            rejected_councils: councils.rows.filter((c) => c.status === "rejected").map(toCouncil),

            // What the "Ready to Submit" screen needs
            can_submit: missing.length === 0 && councils.rows.length > 0,
            is_complete: missing.length === 0 && councils.rows.length > 0
        });

    } catch (error) {
        console.error("Error in operator getMe:", error);
        res.status(500).json({ message: "Something went wrong while fetching your profile" });
    }
};

// Everything the operator pack needs, in one place.
//
// Exported because the admin's copy of the same PDF needs exactly this data —
// having one loader means the two packs can never drift apart.
const loadOperatorPack = async (operatorId) => {
    const operator = await pool.query(
        "SELECT * FROM users WHERE id = $1 AND role = 'operator'",
        [operatorId]
    );

    if (operator.rows.length === 0) return null;

    const documents = await pool.query(
        "SELECT * FROM operator_documents WHERE user_id = $1 AND is_current",
        [operatorId]
    );

    const councils = await pool.query(
        "SELECT * FROM operator_councils WHERE user_id = $1 ORDER BY created_at ASC",
        [operatorId]
    );

    return {
        operator: operator.rows[0],
        documents: documents.rows,
        councils: councils.rows
    };
};

// Turns "Eurocars London Ltd." into "Eurocars-London-Ltd" so the browser is
// never handed a filename with a slash or a quote in it.
const safeFileName = (value) =>
    String(value || "operator").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "operator";

// GET /api/v1/operators/me/documents/pdf
// The operator's own pack. No review status on it — this is the copy they
// send to a council or an insurer, not an internal review sheet.
const getMyDocumentsPdf = async (req, res) => {
    try {
        if (req.user.role !== "operator") {
            return res.status(403).json({ message: "Operators only", error_code: "FORBIDDEN" });
        }

        const pack = await loadOperatorPack(req.user.id);

        if (!pack) {
            return res.status(404).json({ message: "Operator not found" });
        }

        if (pack.documents.length === 0) {
            return res.status(400).json({
                message: "You have not uploaded any documents yet",
                error_code: "NO_DOCUMENTS"
            });
        }

        const buffer = await buildOperatorDocumentPdf(
            pack.operator,
            pack.documents,
            pack.councils,
            { showStatus: false }
        );

        const name = safeFileName(
            `${pack.operator.first_name}-${pack.operator.last_name}`
        );

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="MoveApp-${name}.pdf"`);
        res.setHeader("Content-Length", buffer.length);
        res.send(buffer);

    } catch (error) {
        console.error("Error in operator getMyDocumentsPdf:", error);
        res.status(500).json({ message: "Something went wrong while building the PDF" });
    }
};

// PATCH /api/v1/operators/me
// The operator's own details: title, date of birth, address and postcode.
const updateProfile = async (req, res) => {
    try {
        if (req.user.role !== "operator") {
            return res.status(403).json({ message: "Operators only", error_code: "FORBIDDEN" });
        }

        const { title, date_of_birth, address, postcode } = req.body;

        if (!address && !postcode && !title && !date_of_birth) {
            return res.status(400).json({
                message: "Provide at least one of: title, date_of_birth, address, postcode"
            });
        }

        // Every field is optional on its own — the app may save the company
        // details and the personal ones on two different screens. Whatever is
        // sent is validated; whatever is not sent is left alone.

        let cleanTitle = null;

        if (title !== undefined && title !== null) {
            cleanTitle = String(title).trim();

            if (!VALID_TITLES.includes(cleanTitle)) {
                return res.status(400).json({
                    message: `title must be one of: ${VALID_TITLES.join(", ")}`
                });
            }
        }

        // The operator uploads a passport and a driving licence, and the admin
        // verifies them. Without a date of birth there is nothing on file for
        // the admin to check those documents against.
        let cleanDob = null;

        if (date_of_birth !== undefined && date_of_birth !== null) {
            if (!ISO_DATE.test(String(date_of_birth))) {
                return res.status(400).json({
                    message: "date_of_birth must be in YYYY-MM-DD format"
                });
            }

            const dob = new Date(`${date_of_birth}T00:00:00Z`);

            // new Date("2003-02-30") rolls over to 2 March instead of failing,
            // so compare the parsed date back to what was typed.
            if (Number.isNaN(dob.getTime())
                || dob.toISOString().slice(0, 10) !== String(date_of_birth)) {
                return res.status(400).json({ message: "date_of_birth is not a valid date" });
            }

            const age = (Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000);

            if (age < MIN_OPERATOR_AGE) {
                return res.status(400).json({
                    message: `An operator must be at least ${MIN_OPERATOR_AGE} years old`,
                    error_code: "OPERATOR_TOO_YOUNG"
                });
            }

            if (age > 100) {
                return res.status(400).json({ message: "date_of_birth does not look correct" });
            }

            cleanDob = date_of_birth;
        }

        let cleanPostcode = null;

        if (postcode !== undefined && postcode !== null) {
            cleanPostcode = String(postcode).trim().toUpperCase();

            // This was accepting anything at all, while the driver's postcode
            // was checked. The admin reads the operator's proof of address
            // against it, so a typo here costs somebody a rejection.
            if (!POSTCODE_REGEX.test(cleanPostcode)) {
                return res.status(400).json({
                    message: "postcode must be a valid UK postcode (e.g. W1U 3BW)"
                });
            }
        }

        const updated = await pool.query(
            `UPDATE users
             SET title         = COALESCE($1, title),
                 date_of_birth = COALESCE($2, date_of_birth),
                 address       = COALESCE($3, address),
                 postcode      = COALESCE($4, postcode),
                 updated_at    = NOW()
             WHERE id = $5
             RETURNING *`,
            [
                cleanTitle,
                cleanDob,
                address ? String(address).trim() : null,
                cleanPostcode,
                req.user.id
            ]
        );

        res.status(200).json({
            message: "Profile updated",
            operator: toOperatorProfile(updated.rows[0])
        });

    } catch (error) {
        console.error("Error in operator updateProfile:", error);
        res.status(500).json({ message: "Something went wrong while saving your profile" });
    }
};

// POST /api/v1/operators/me/documents
// multipart/form-data: file, document_type, source
const uploadDocument = async (req, res) => {
    const client = await pool.connect();
    let savedKey = null;

    try {
        if (req.user.role !== "operator") {
            return res.status(403).json({ message: "Operators only", error_code: "FORBIDDEN" });
        }

        const operatorId = req.user.id;
        const { document_type, source, expires_at } = req.body;

        if (!document_type) {
            return res.status(400).json({ message: "document_type is required" });
        }

        if (!ALL_OPERATOR_DOCUMENTS.includes(document_type)) {
            return res.status(400).json({
                message: `document_type must be one of: ${ALL_OPERATOR_DOCUMENTS.join(", ")}`
            });
        }

        // The operator types the expiry date off their own document as they
        // upload it. The admin still confirms or corrects it when verifying —
        // this is a convenience, not a source of truth.
        const needsExpiry = OPERATOR_DOCUMENTS_WITH_EXPIRY.includes(document_type);
        let cleanExpiry = null;

        if (needsExpiry) {
            if (!expires_at) {
                return res.status(400).json({
                    message: `expires_at is required for ${OPERATOR_DOCUMENT_LABELS[document_type] || document_type}`,
                    error_code: "EXPIRY_REQUIRED"
                });
            }

            if (!ISO_DATE.test(String(expires_at))) {
                return res.status(400).json({
                    message: "expires_at must be in YYYY-MM-DD format"
                });
            }

            const expiry = new Date(`${expires_at}T00:00:00Z`);

            // new Date("2027-02-30") does not fail — it rolls over to 2 March.
            // Comparing the date back to what was typed catches that.
            if (Number.isNaN(expiry.getTime())
                || expiry.toISOString().slice(0, 10) !== String(expires_at)) {
                return res.status(400).json({ message: "expires_at is not a valid date" });
            }

            if (expiry.getTime() < Date.now()) {
                return res.status(400).json({
                    message: "This document has already expired. Please upload a current one.",
                    error_code: "DOCUMENT_EXPIRED"
                });
            }

            cleanExpiry = expires_at;

        } else if (expires_at) {
            // Silently ignoring it would leave the operator believing a date
            // was stored on a document that has none.
            return res.status(400).json({
                message: `${OPERATOR_DOCUMENT_LABELS[document_type] || document_type} does not have an expiry date`,
                error_code: "EXPIRY_NOT_APPLICABLE"
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

        // Re-uploading supersedes the previous version
        await client.query(
            `UPDATE operator_documents SET is_current = FALSE
             WHERE user_id = $1 AND document_type = $2 AND is_current`,
            [operatorId, document_type]
        );

        const inserted = await client.query(
            `INSERT INTO operator_documents
                (user_id, document_type, file_url, storage_key, file_format,
                 file_size, source, expires_at, status, is_current)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending_review', TRUE)
             RETURNING *`,
            [operatorId, document_type, "", saved.key, detected.mime, saved.size,
                source || null, cleanExpiry]
        );

        const doc = inserted.rows[0];

        await client.query(
            "UPDATE operator_documents SET file_url = $1 WHERE id = $2",
            [`/api/v1/documents/operator/${doc.id}/file`, doc.id]
        );

        const status = await recomputeOperatorStatus(client, operatorId);

        await client.query("COMMIT");
        savedKey = null;

        const current = await pool.query(
            "SELECT document_type FROM operator_documents WHERE user_id = $1 AND is_current",
            [operatorId]
        );
        const have = current.rows.map((r) => r.document_type);
        const missing = REQUIRED_OPERATOR_DOCUMENTS.filter((t) => !have.includes(t));

        res.status(201).json({
            message: "Document uploaded successfully",
            document: toOperatorDocument(doc),
            missing_documents: missing,
            all_documents_complete: missing.length === 0,
            operator_status: status
        });

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        if (savedKey) await storage.remove(savedKey).catch(() => { });

        console.error("Error in operator uploadDocument:", error);
        res.status(500).json({ message: "Something went wrong while uploading the document" });

    } finally {
        client.release();
    }
};

// POST /api/v1/operators/me/councils
// multipart/form-data: file, council_name, licence_number, expires_at, source
//
// One row per council. An operator licensed by several councils adds one of
// these for each — that is what the "Add more Council" button does.
const addCouncil = async (req, res) => {
    const client = await pool.connect();
    let savedKey = null;

    try {
        if (req.user.role !== "operator") {
            return res.status(403).json({ message: "Operators only", error_code: "FORBIDDEN" });
        }

        const operatorId = req.user.id;
        const { council_name, licence_number, expires_at, source } = req.body;

        if (!council_name || !licence_number || !expires_at) {
            return res.status(400).json({
                message: "council_name, licence_number and expires_at are required"
            });
        }

        if (!ISO_DATE.test(String(expires_at))) {
            return res.status(400).json({
                message: "expires_at must be in YYYY-MM-DD format"
            });
        }

        const expiry = new Date(`${expires_at}T00:00:00Z`);
        if (Number.isNaN(expiry.getTime())) {
            return res.status(400).json({ message: "expires_at is not a valid date" });
        }

        if (expiry.getTime() < Date.now()) {
            return res.status(400).json({
                message: "This licence has already expired",
                error_code: "LICENCE_EXPIRED"
            });
        }

        if (source && !DOCUMENT_SOURCES.includes(source)) {
            return res.status(400).json({
                message: `source must be one of: ${DOCUMENT_SOURCES.join(", ")}`
            });
        }

        if (!req.file) {
            return res.status(400).json({
                message: "The council licence document is required. Send it as form-data under the key 'file'.",
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

        const inserted = await client.query(
            `INSERT INTO operator_councils
                (user_id, council_name, licence_number, expires_at,
                 file_url, storage_key, file_format, file_size, source)
             VALUES ($1, $2, $3, $4, '', $5, $6, $7, $8)
             RETURNING *`,
            [
                operatorId,
                String(council_name).trim(),
                String(licence_number).trim().toUpperCase(),
                expires_at,
                saved.key,
                detected.mime,
                saved.size,
                source || null
            ]
        );

        const council = inserted.rows[0];

        await client.query(
            "UPDATE operator_councils SET file_url = $1 WHERE id = $2",
            [`/api/v1/documents/council/${council.id}/file`, council.id]
        );

        const status = await recomputeOperatorStatus(client, operatorId);

        await client.query("COMMIT");
        savedKey = null;

        res.status(201).json({
            message: "Council licence added",
            council: toCouncil(council),
            operator_status: status
        });

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        if (savedKey) await storage.remove(savedKey).catch(() => { });

        if (error.code === "23505") {
            return res.status(409).json({
                message: "You have already added a licence for this council",
                error_code: "DUPLICATE_COUNCIL"
            });
        }

        console.error("Error in addCouncil:", error);
        res.status(500).json({ message: "Something went wrong while adding the council" });

    } finally {
        client.release();
    }
};

// DELETE /api/v1/operators/me/councils/:id
const removeCouncil = async (req, res) => {
    const client = await pool.connect();

    try {
        const { id } = req.params;

        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid council id" });
        }

        const existing = await pool.query(
            "SELECT * FROM operator_councils WHERE id = $1 AND user_id = $2",
            [id, req.user.id]
        );
        const council = existing.rows[0];

        if (!council) {
            return res.status(404).json({ message: "Council not found" });
        }

        // A council an admin has already approved is part of the verified
        // record; removing it would quietly change what was approved.
        if (council.status === "approved") {
            return res.status(403).json({
                message: "An approved council licence cannot be removed. Please contact the administrator.",
                error_code: "COUNCIL_APPROVED"
            });
        }

        await client.query("BEGIN");
        await client.query("DELETE FROM operator_councils WHERE id = $1", [id]);
        const status = await recomputeOperatorStatus(client, req.user.id);
        await client.query("COMMIT");

        if (council.storage_key) await storage.remove(council.storage_key).catch(() => { });

        res.status(200).json({ message: "Council removed", operator_status: status });

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        console.error("Error in removeCouncil:", error);
        res.status(500).json({ message: "Something went wrong while removing the council" });
    } finally {
        client.release();
    }
};

// -----------------------------------------------------------------------------
// File access — the same rule as driver documents
// -----------------------------------------------------------------------------

const streamFile = async (res, storageKey, fileFormat, label) => {
    if (!storageKey || !(await storage.exists(storageKey))) {
        return res.status(404).json({ message: "File is no longer available" });
    }

    res.setHeader("Content-Type", fileFormat || "application/octet-stream");
    res.setHeader("Cache-Control", "private, no-store");

    const stream = storage.createReadStream(storageKey);
    stream.on("error", (err) => {
        console.error(`Error streaming ${label}`, err);
        if (!res.headersSent) res.status(500).json({ message: "Could not read the file" });
    });
    stream.pipe(res);
};

// GET /api/v1/documents/operator/:id/file
const getOperatorDocumentFile = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid document id" });
        }

        const result = await pool.query(
            "SELECT id, user_id, storage_key, file_format FROM operator_documents WHERE id = $1",
            [id]
        );
        const doc = result.rows[0];

        if (!doc) return res.status(404).json({ message: "Document not found" });

        // The owning operator, or any admin
        const isOwner = doc.user_id === req.user.id;
        const isAdmin = req.user.role === "admin";

        if (!isOwner && !isAdmin) {
            return res.status(403).json({
                message: "You do not have permission to view this document",
                error_code: "FORBIDDEN"
            });
        }

        await streamFile(res, doc.storage_key, doc.file_format, `operator document ${id}`);

    } catch (error) {
        console.error("Error in getOperatorDocumentFile:", error);
        res.status(500).json({ message: "Something went wrong while fetching the file" });
    }
};

// GET /api/v1/documents/council/:id/file
const getCouncilFile = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid council id" });
        }

        const result = await pool.query(
            "SELECT id, user_id, storage_key, file_format FROM operator_councils WHERE id = $1",
            [id]
        );
        const council = result.rows[0];

        if (!council) return res.status(404).json({ message: "Council not found" });

        const isOwner = council.user_id === req.user.id;
        const isAdmin = req.user.role === "admin";

        if (!isOwner && !isAdmin) {
            return res.status(403).json({
                message: "You do not have permission to view this document",
                error_code: "FORBIDDEN"
            });
        }

        await streamFile(res, council.storage_key, council.file_format, `council ${id}`);

    } catch (error) {
        console.error("Error in getCouncilFile:", error);
        res.status(500).json({ message: "Something went wrong while fetching the file" });
    }
};

module.exports = {
    getMe,
    getMyDocumentsPdf,
    loadOperatorPack,
    safeFileName,
    updateProfile,
    uploadDocument,
    addCouncil,
    removeCouncil,
    getOperatorDocumentFile,
    getCouncilFile,
    toOperatorDocument,
    toCouncil,
    toOperatorProfile
};