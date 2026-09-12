const pool = require("../config/db");
const { create } = require("./appNotifications");
const { NOTIFICATION_TYPES } = require("../constants/notifications");
const { DOCUMENT_LABELS } = require("../constants/documents");

// The daily expiry check.
//
// Two jobs, in this order:
//
//   1. Warn drivers whose documents expire in 14, 7, 3, 2 or 1 days.
//   2. Suspend drivers whose documents have already expired.
//
// Written as one function that can be called from anywhere — a script, a cron
// job, an admin button — rather than tied to a scheduler. Whatever runs it, the
// behaviour is identical, which is what makes it testable.

// The CEO's list. Getting louder as the date approaches: a warning a fortnight
// out is easy to forget, one the day before is not.
const WARNING_DAYS = [14, 7, 3, 2, 1];

// A date-only difference, no clock arithmetic.
//
// expires_at is a DATE and comes back as "YYYY-MM-DD" (config/db.js makes sure
// of that), so both sides are compared at UTC midnight. Using Date.now()
// directly would make the answer depend on the time of day the job ran — the
// same document could be "7 days left" at 09:00 and "6 days left" at 18:00.
const daysUntil = (expiresAt, today = new Date()) => {
    const end = new Date(`${String(expiresAt).slice(0, 10)}T00:00:00Z`);

    const start = Date.UTC(
        today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()
    );

    return Math.round((end.getTime() - start) / (24 * 60 * 60 * 1000));
};

const labelFor = (documentType) => DOCUMENT_LABELS[documentType] || documentType;

// Has this exact warning already gone out?
//
// Keyed on the document and the number of days, not just the type — otherwise
// the 7-day warning would suppress the 3-day one. The dedupe matters because
// the job may run more than once a day (a retry, a manual run, a server
// restart) and a driver must not get the same warning twice.
const alreadyWarned = async (userId, documentId, scope, daysLeft) => {
    const result = await pool.query(
        `SELECT 1 FROM notifications
         WHERE user_id = $1
           AND type = $2
           AND data->>'document_id' = $3
           AND data->>'scope' = $4
           AND data->>'days_left' = $5
         LIMIT 1`,
        [
            userId,
            NOTIFICATION_TYPES.DOCUMENT_EXPIRING,
            String(documentId),
            scope,
            String(daysLeft)
        ]
    );
    return result.rows.length > 0;
};

// Every current document that carries an expiry date, driver's and vehicle's
// together, with the driver they belong to.
//
// A vehicle document is the driver's problem too — an expired MOT stops them
// working exactly like an expired licence does.
const loadExpiringDocuments = async () => {
    const driverDocs = await pool.query(
        `SELECT d.id, d.user_id, d.document_type, d.expires_at,
                'driver' AS scope, NULL::text AS registration_number
         FROM driver_documents d
         JOIN users u ON u.id = d.user_id
         WHERE d.is_current
           AND d.expires_at IS NOT NULL
           AND d.status = 'approved'
           AND u.role = 'driver'
           AND u.status IN ('approved', 'pending_verification', 'suspended')`
    );

    const vehicleDocs = await pool.query(
        `SELECT vd.id, v.driver_id AS user_id, vd.document_type, vd.expires_at,
                'vehicle' AS scope, v.registration_number
         FROM vehicle_documents vd
         JOIN vehicles v ON v.id = vd.vehicle_id
         JOIN users u ON u.id = v.driver_id
         WHERE vd.is_current
           AND vd.expires_at IS NOT NULL
           AND vd.status = 'approved'
           AND u.status IN ('approved', 'pending_verification', 'suspended')`
    );

    return [...driverDocs.rows, ...vehicleDocs.rows];
};

// Only an approved document can expire in a way that matters. One still waiting
// for review is already blocking the driver for a different reason, and warning
// them about a date nobody has confirmed yet would be noise.

const runExpiryCheck = async ({ today = new Date(), dryRun = false } = {}) => {
    const summary = {
        checked: 0,
        warnings_sent: 0,
        drivers_suspended: 0,
        already_expired: 0,
        warnings: [],
        suspended: []
    };

    const documents = await loadExpiringDocuments();
    summary.checked = documents.length;

    // Drivers to suspend, gathered first so a driver with three expired
    // documents is suspended once and told about all three.
    const expiredByDriver = new Map();

    for (const doc of documents) {
        const daysLeft = daysUntil(doc.expires_at, today);

        if (daysLeft <= 0) {
            summary.already_expired += 1;

            if (!expiredByDriver.has(doc.user_id)) expiredByDriver.set(doc.user_id, []);
            expiredByDriver.get(doc.user_id).push(doc);
            continue;
        }

        if (!WARNING_DAYS.includes(daysLeft)) continue;
        if (await alreadyWarned(doc.user_id, doc.id, doc.scope, daysLeft)) continue;

        const label = labelFor(doc.document_type);
        const what = doc.scope === "vehicle"
            ? `${label} for ${doc.registration_number}`
            : label;

        const when = daysLeft === 1 ? "tomorrow" : `in ${daysLeft} days`;

        summary.warnings.push({
            user_id: doc.user_id, document_id: doc.id, scope: doc.scope,
            document_type: doc.document_type, days_left: daysLeft
        });

        if (dryRun) continue;

        await create({
            userId: doc.user_id,
            type: NOTIFICATION_TYPES.DOCUMENT_EXPIRING,
            title: `Your ${what} expires ${when}`,
            body: "Upload a new one now so your account is not suspended.",
            data: {
                document_id: doc.id,
                scope: doc.scope,
                document_type: doc.document_type,
                days_left: daysLeft,
                expires_at: doc.expires_at
            }
        });

        summary.warnings_sent += 1;
    }

    // ---- Suspend ------------------------------------------------------------
    for (const [userId, docs] of expiredByDriver) {
        const names = docs.map((d) => labelFor(d.document_type)).join(", ");

        // "MOT licence, Car insurance has expired" reads like a bug. A driver
        // who is being locked out should at least be told so in a sentence.
        const verb = docs.length === 1 ? "has" : "have";
        const one = docs.length === 1 ? "a new one" : "new ones";

        summary.suspended.push({ user_id: userId, documents: names });

        if (dryRun) continue;

        // WHERE status <> 'suspended' means a driver already suspended is not
        // suspended again — and, more usefully, is not told again every single
        // morning until they fix it.
        const updated = await pool.query(
            `UPDATE users
             SET status = 'suspended',
                 suspension_reason = 'document_expired',
                 suspended_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1 AND status <> 'suspended'
             RETURNING id`,
            [userId]
        );

        if (updated.rows.length === 0) continue;

        await create({
            userId,
            type: NOTIFICATION_TYPES.DOCUMENT_EXPIRED,
            title: "Your account has been suspended",
            body: `${names} ${verb} expired. Upload ${one} to start working again.`,
            data: {
                scope: "account",
                documents: docs.map((d) => ({
                    document_id: d.id,
                    scope: d.scope,
                    document_type: d.document_type,
                    expires_at: d.expires_at
                }))
            }
        });

        summary.drivers_suspended += 1;
    }

    return summary;
};

// Which documents are the reason a driver is locked out right now.
//
// Used by the app's lock screen, so it can name them instead of saying
// "a document expired" and leaving the driver to guess which.
const expiredDocumentsFor = async (userId, today = new Date()) => {
    const documents = await loadExpiringDocuments();

    return documents
        .filter((d) => d.user_id === userId && daysUntil(d.expires_at, today) <= 0)
        .map((d) => ({
            document_id: d.id,
            scope: d.scope,
            document_type: d.document_type,
            label: labelFor(d.document_type),
            registration_number: d.registration_number,
            expires_at: d.expires_at
        }));
};

module.exports = {
    WARNING_DAYS,
    daysUntil,
    runExpiryCheck,
    expiredDocumentsFor,
    loadExpiringDocuments
};