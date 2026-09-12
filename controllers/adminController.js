const pool = require("../config/db");
const { recomputeOperatorStatus } = require("../services/operatorStatus");
const {
    toOperatorDocument,
    toCouncil,
    toOperatorProfile,
    loadOperatorPack,
    safeFileName
} = require("./operatorProfileController");
const { buildOperatorDocumentPdf } = require("../services/pdfService");
const { runExpiryCheck } = require("../services/documentExpiry");
const {
    REQUIRED_OPERATOR_DOCUMENTS,
    OPERATOR_DOCUMENTS_WITH_EXPIRY,
    operatorDocumentNeedsExpiry,
    OPERATOR_DOCUMENT_LABELS
} = require("../constants/operatorDocuments");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const parseDate = (value) => {
    if (!ISO_DATE.test(String(value))) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
};

// -----------------------------------------------------------------------------
// Operator queue
// -----------------------------------------------------------------------------

// GET /api/v1/admin/operators?page=1&limit=20&status=pending_verification
const getOperators = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const offset = (page - 1) * limit;

        const allowed = ["pending_verification", "account_created", "approved", "rejected", "suspended"];
        const status = allowed.includes(req.query.status) ? req.query.status : "pending_verification";

        const operators = await pool.query(
            `SELECT id, title, first_name, middle_name, last_name,
                    date_of_birth, email, phone, address, postcode, status, created_at
             FROM users
             WHERE role = 'operator' AND status = $1
             ORDER BY created_at ASC
             LIMIT $2 OFFSET $3`,
            [status, limit, offset]
        );

        const count = await pool.query(
            "SELECT COUNT(*)::int AS total FROM users WHERE role = 'operator' AND status = $1",
            [status]
        );
        const total = count.rows[0].total;

        res.status(200).json({
            operators: operators.rows,
            pagination: {
                page,
                limit,
                total,
                total_pages: Math.max(1, Math.ceil(total / limit))
            }
        });

    } catch (error) {
        console.error("Error in getOperators:", error);
        res.status(500).json({ message: "Something went wrong while fetching operators" });
    }
};

// GET /api/v1/admin/operators/:id
// The whole review screen in one call: profile, documents, councils.
const getOperatorDetail = async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid operator id" });
        }

        const result = await pool.query(
            "SELECT * FROM users WHERE id = $1 AND role = 'operator'",
            [id]
        );
        const operator = result.rows[0];
        if (!operator) return res.status(404).json({ message: "Operator not found" });

        const docs = await pool.query(
            "SELECT * FROM operator_documents WHERE user_id = $1 AND is_current ORDER BY document_type",
            [id]
        );
        const councils = await pool.query(
            "SELECT * FROM operator_councils WHERE user_id = $1 ORDER BY created_at ASC",
            [id]
        );

        const have = docs.rows.map((d) => d.document_type);

        // How many drivers this operator is responsible for
        const driverCount = await pool.query(
            "SELECT COUNT(*)::int AS total FROM users WHERE role = 'driver'"
        );

        res.status(200).json({
            operator: toOperatorProfile(operator),
            documents: docs.rows.map(toOperatorDocument),
            councils: councils.rows.map(toCouncil),
            missing_documents: REQUIRED_OPERATOR_DOCUMENTS.filter((t) => !have.includes(t)),
            expiry_required: OPERATOR_DOCUMENTS_WITH_EXPIRY,
            labels: OPERATOR_DOCUMENT_LABELS,
            driver_count: driverCount.rows[0].total
        });

    } catch (error) {
        console.error("Error in getOperatorDetail:", error);
        res.status(500).json({ message: "Something went wrong while fetching the operator" });
    }
};

// -----------------------------------------------------------------------------
// Verification
// -----------------------------------------------------------------------------

const validateVerifyBody = (body, needsExpiry) => {
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

    if (needsExpiry) {
        if (!expires_at) {
            return { error: "expires_at is required when approving this document (format YYYY-MM-DD)" };
        }

        const date = parseDate(expires_at);
        if (!date) {
            return { error: "expires_at must be a valid date in YYYY-MM-DD format" };
        }

        if (date.getTime() < Date.now()) {
            return { error: "expires_at is in the past — this document has already expired and cannot be approved" };
        }

        return { status, rejectionReason: null, expiryDate: expires_at };
    }

    return { status, rejectionReason: null, expiryDate: null };
};

// PATCH /api/v1/admin/operator-documents/:documentId/verify
const verifyOperatorDocument = async (req, res) => {
    const client = await pool.connect();

    try {
        const { documentId } = req.params;
        if (!/^\d+$/.test(documentId)) {
            return res.status(400).json({ message: "Invalid document id" });
        }

        const existing = await pool.query(
            "SELECT * FROM operator_documents WHERE id = $1",
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

        const parsed = validateVerifyBody(req.body, operatorDocumentNeedsExpiry(doc.document_type));
        if (parsed.error) return res.status(400).json({ message: parsed.error });

        await client.query("BEGIN");

        const updated = await client.query(
            `UPDATE operator_documents
             SET status = $1, rejection_reason = $2, expires_at = $3,
                 verified_by = $4, verified_at = NOW()
             WHERE id = $5
             RETURNING *`,
            [parsed.status, parsed.rejectionReason, parsed.expiryDate, req.user.id, documentId]
        );

        const operatorStatus = await recomputeOperatorStatus(client, doc.user_id);

        await client.query("COMMIT");

        res.status(200).json({
            message: parsed.status === "approved" ? "Document approved" : "Document rejected",
            document: toOperatorDocument(updated.rows[0]),
            operator_status: operatorStatus
        });

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        console.error("Error in verifyOperatorDocument:", error);
        res.status(500).json({ message: "Something went wrong while verifying the document" });
    } finally {
        client.release();
    }
};

// PATCH /api/v1/admin/councils/:councilId/verify
//
// The council licence carries its own expiry, which the operator typed when
// adding it. The admin confirms it against the document rather than retyping,
// so `expires_at` here is optional — send it only to correct what was entered.
const verifyCouncil = async (req, res) => {
    const client = await pool.connect();

    try {
        const { councilId } = req.params;
        if (!/^\d+$/.test(councilId)) {
            return res.status(400).json({ message: "Invalid council id" });
        }

        const { status, rejection_reason, expires_at, licence_number } = req.body;

        if (!["approved", "rejected"].includes(status)) {
            return res.status(400).json({ message: "status must be 'approved' or 'rejected'" });
        }

        if (status === "rejected" && (!rejection_reason || String(rejection_reason).trim().length < 3)) {
            return res.status(400).json({ message: "rejection_reason is required when rejecting" });
        }

        const existing = await pool.query("SELECT * FROM operator_councils WHERE id = $1", [councilId]);
        const council = existing.rows[0];
        if (!council) return res.status(404).json({ message: "Council not found" });

        let expiryDate = null;
        if (expires_at) {
            const date = parseDate(expires_at);
            if (!date) {
                return res.status(400).json({ message: "expires_at must be in YYYY-MM-DD format" });
            }
            if (status === "approved" && date.getTime() < Date.now()) {
                return res.status(400).json({
                    message: "expires_at is in the past — this licence has already expired"
                });
            }
            expiryDate = expires_at;
        }

        await client.query("BEGIN");

        const updated = await client.query(
            `UPDATE operator_councils
             SET status = $1,
                 rejection_reason = $2,
                 expires_at = COALESCE($3, expires_at),
                 licence_number = COALESCE($4, licence_number),
                 verified_by = $5,
                 verified_at = NOW(),
                 updated_at = NOW()
             WHERE id = $6
             RETURNING *`,
            [
                status,
                status === "rejected" ? String(rejection_reason).trim() : null,
                expiryDate,
                licence_number ? String(licence_number).trim().toUpperCase() : null,
                req.user.id,
                councilId
            ]
        );

        const operatorStatus = await recomputeOperatorStatus(client, council.user_id);

        await client.query("COMMIT");

        res.status(200).json({
            message: status === "approved" ? "Council licence approved" : "Council licence rejected",
            council: toCouncil(updated.rows[0]),
            operator_status: operatorStatus
        });

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        console.error("Error in verifyCouncil:", error);
        res.status(500).json({ message: "Something went wrong while verifying the council" });
    } finally {
        client.release();
    }
};

// PATCH /api/v1/admin/operators/:id/suspend
const setOperatorSuspension = async (req, res) => {
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
                 WHERE id = $1 AND role = 'operator' RETURNING id, status`,
                [id]
            );

            if (updated.rows.length === 0) {
                await client.query("ROLLBACK");
                return res.status(404).json({ message: "Operator not found" });
            }

            await client.query("COMMIT");
            return res.status(200).json({ message: "Operator suspended", operator: updated.rows[0] });
        }

        await client.query(
            "UPDATE users SET status = 'account_created' WHERE id = $1 AND role = 'operator'",
            [id]
        );
        const status = await recomputeOperatorStatus(client, id);

        await client.query("COMMIT");

        res.status(200).json({
            message: "Suspension lifted",
            operator: { id: Number(id), status }
        });

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        console.error("Error in setOperatorSuspension:", error);
        res.status(500).json({ message: "Something went wrong" });
    } finally {
        client.release();
    }
};

// -----------------------------------------------------------------------------
// Admins
// -----------------------------------------------------------------------------

// GET /api/v1/admin/admins
const listAdmins = async (req, res) => {
    try {
        const admins = await pool.query(
            `SELECT id, first_name, last_name, email, phone, status, created_at
             FROM users WHERE role = 'admin' ORDER BY created_at ASC`
        );

        res.status(200).json({ admins: admins.rows, total: admins.rows.length });

    } catch (error) {
        console.error("Error in listAdmins:", error);
        res.status(500).json({ message: "Something went wrong while fetching admins" });
    }
};

// POST /api/v1/admin/admins
// Only an existing admin can create another. There is no public route to this
// role at all — the first one is inserted by hand.
const MAX_ADMINS = 4;

const createAdmin = async (req, res) => {
    try {
        const { first_name, last_name, email, phone } = req.body;

        if (!first_name || !last_name || !email || !phone) {
            return res.status(400).json({
                message: "first_name, last_name, email and phone are required"
            });
        }

        const count = await pool.query(
            "SELECT COUNT(*)::int AS total FROM users WHERE role = 'admin'"
        );

        if (count.rows[0].total >= MAX_ADMINS) {
            return res.status(400).json({
                message: `There can be at most ${MAX_ADMINS} admins. Remove one before adding another.`,
                error_code: "ADMIN_LIMIT_REACHED"
            });
        }

        const created = await pool.query(
            `INSERT INTO users (first_name, last_name, email, phone, role, status, email_verified)
             VALUES ($1, $2, $3, $4, 'admin', 'approved', TRUE)
             RETURNING id, first_name, last_name, email, phone, role, status, created_at`,
            [
                String(first_name).trim(),
                String(last_name).trim(),
                String(email).trim().toLowerCase(),
                String(phone).trim()
            ]
        );

        res.status(201).json({
            message: "Admin created. They log in with their phone number and an OTP.",
            admin: created.rows[0]
        });

    } catch (error) {
        if (error.code === "23505") {
            return res.status(409).json({
                message: "An account with this email or phone already exists"
            });
        }
        console.error("Error in createAdmin:", error);
        res.status(500).json({ message: "Something went wrong while creating the admin" });
    }
};

// -----------------------------------------------------------------------------
// Document packs
// -----------------------------------------------------------------------------

// GET /api/v1/admin/operators/:id/documents/pdf
// The admin's copy of an operator's pack — review status included.
const getOperatorDocumentsPdf = async (req, res) => {
    try {
        const { id } = req.params;

        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid operator id" });
        }

        const pack = await loadOperatorPack(id);

        if (!pack) {
            return res.status(404).json({ message: "Operator not found" });
        }

        if (pack.documents.length === 0) {
            return res.status(404).json({
                message: "This operator has not uploaded any documents yet",
                error_code: "NO_DOCUMENTS"
            });
        }

        const buffer = await buildOperatorDocumentPdf(
            pack.operator,
            pack.documents,
            pack.councils,
            { showStatus: true }
        );

        const name = safeFileName(
            `${pack.operator.first_name}-${pack.operator.last_name}`
        );

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="MoveApp-${name}-${id}.pdf"`);
        res.setHeader("Cache-Control", "private, no-store");
        res.send(buffer);

    } catch (error) {
        console.error("Error in getOperatorDocumentsPdf:", error);
        res.status(500).json({ message: "Something went wrong while building the PDF" });
    }
};

// -----------------------------------------------------------------------------
// Drivers
// -----------------------------------------------------------------------------

// GET /api/v1/admin/drivers?page=1&limit=20&status=approved&q=khan
//
// An admin can see every driver in the system, whichever operator reviewed
// them, and unlike an operator they see the phone number and email — the
// masking rule applies between operator and driver, not to the company.
const getDrivers = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const offset = (page - 1) * limit;

        const allowed = ["account_created", "pending_verification", "approved",
            "rejected", "suspended"];

        // No status filter means every driver, which is what an admin looking
        // someone up by name actually wants.
        const status = allowed.includes(req.query.status) ? req.query.status : null;

        const search = req.query.q ? `%${String(req.query.q).trim()}%` : null;

        const where = ["role = 'driver'"];
        const params = [];

        if (status) {
            params.push(status);
            where.push(`status = $${params.length}`);
        }

        if (search) {
            params.push(search);
            const p = params.length;
            where.push(`(first_name ILIKE $${p} OR last_name ILIKE $${p}
                         OR email ILIKE $${p} OR phone ILIKE $${p})`);
        }

        const whereSql = where.join(" AND ");

        const listParams = [...params, limit, offset];

        const drivers = await pool.query(
            `SELECT id, title, first_name, middle_name, last_name, email, phone,
                    date_of_birth, address, postcode, ni_number, status, created_at
             FROM users
             WHERE ${whereSql}
             ORDER BY created_at DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            listParams
        );

        const count = await pool.query(
            `SELECT COUNT(*)::int AS total FROM users WHERE ${whereSql}`,
            params
        );

        const total = count.rows[0].total;

        res.status(200).json({
            drivers: drivers.rows.map((d) => ({
                ...d,
                full_name: [d.first_name, d.middle_name, d.last_name].filter(Boolean).join(" ")
            })),
            pagination: {
                page,
                limit,
                total,
                total_pages: Math.ceil(total / limit) || 1
            },
            filters: { status: status || "all", q: req.query.q || null }
        });

    } catch (error) {
        console.error("Error in getDrivers:", error);
        res.status(500).json({ message: "Something went wrong while fetching drivers" });
    }
};

// -----------------------------------------------------------------------------
// Jobs
// -----------------------------------------------------------------------------

// POST /api/v1/admin/jobs/expiry?dry_run=true
//
// Runs the daily document expiry check on demand.
//
// It exists because Vercel has no long-running process to put a cron job in —
// a Vercel Cron calls this URL instead. It is also the way to run the check by
// hand after changing an expiry date, without waiting until tomorrow morning.
//
// dry_run=true reports what it would do and changes nothing. Worth using the
// first time: suspending a driver is not something to find out about by
// accident.
const runDocumentExpiryJob = async (req, res) => {
    try {
        const dryRun = req.query.dry_run === "true";
        const summary = await runExpiryCheck({ dryRun });

        res.status(200).json({
            message: dryRun
                ? "Dry run complete — nothing was changed"
                : "Expiry check complete",
            dry_run: dryRun,
            ...summary
        });

    } catch (error) {
        console.error("Error in runDocumentExpiryJob:", error);
        res.status(500).json({ message: "The expiry check failed" });
    }
};

module.exports = {
    getOperators,
    getOperatorDetail,
    getOperatorDocumentsPdf,
    getDrivers,
    runDocumentExpiryJob,
    verifyOperatorDocument,
    verifyCouncil,
    setOperatorSuspension,
    listAdmins,
    createAdmin
};