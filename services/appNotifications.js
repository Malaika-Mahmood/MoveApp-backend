const pool = require("../config/db");
const { NOTIFICATION_TYPES, isValidNotificationType } = require("../constants/notifications");

// In-app notifications — the bell icon.
//
// NOT the same thing as services/notificationService.js, which sends OTP codes
// by email and SMS. That one talks to the outside world; this one only writes
// rows other screens in MoveApp will read. Two different jobs, two files.
//
// Every notification in the product is created through here rather than by
// controllers writing their own INSERT. That is what keeps the wording
// consistent, and it is the single place Firebase push will later hook into.

// Raising a notification must never break the thing that caused it. If an
// operator opens a driver's documents and the notification INSERT fails, the
// operator must still see the documents. So failures here are logged and
// swallowed — the caller does not await a promise that can reject.
const safely = async (label, fn) => {
    try {
        return await fn();
    } catch (error) {
        console.error(`Notification failed (${label}):`, error.message);
        return null;
    }
};

// The one function that writes a row.
const create = async ({ userId, actorId = null, type, title, body = null, data = {} }) => {
    if (!userId) throw new Error("userId is required");
    if (!isValidNotificationType(type)) throw new Error(`Unknown notification type: ${type}`);
    if (!title) throw new Error("title is required");

    // Nobody needs telling about something they did themselves.
    if (actorId && Number(actorId) === Number(userId)) return null;

    const result = await pool.query(
        `INSERT INTO notifications (user_id, actor_id, type, title, body, data)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [userId, actorId, type, title, body, JSON.stringify(data)]
    );

    return result.rows[0];
};

// Has this exact notification already gone out today?
//
// Used to stop repeats. "Today" is a rolling 24 hours rather than a calendar
// day — a calendar day would let an operator who looks at 23:55 and again at
// 00:05 send two notifications ten minutes apart.
const sentWithinLastDay = async (userId, actorId, type) => {
    const result = await pool.query(
        `SELECT 1 FROM notifications
         WHERE user_id = $1
           AND actor_id IS NOT DISTINCT FROM $2
           AND type = $3
           AND created_at > NOW() - INTERVAL '24 hours'
         LIMIT 1`,
        [userId, actorId, type]
    );
    return result.rows.length > 0;
};

// -----------------------------------------------------------------------------
// The notifications themselves
// -----------------------------------------------------------------------------

// An operator opened a driver's document pack.
//
// Once a day per operator, not once per page load. An operator checking a
// passport against a licence will open that screen four or five times in ten
// minutes; without this the driver's phone would buzz for each one and the
// whole feature would feel like being watched.
const notifyDocumentsViewed = (driverId, operatorId) =>
    safely("documents_viewed", async () => {
        if (await sentWithinLastDay(driverId, operatorId, NOTIFICATION_TYPES.DOCUMENTS_VIEWED)) {
            return null;
        }

        return create({
            userId: driverId,
            actorId: operatorId,
            type: NOTIFICATION_TYPES.DOCUMENTS_VIEWED,
            title: "An operator viewed your documents",
            // No operator name. The masking rule runs both ways — a driver is
            // not told which individual is reviewing them.
            body: "Your document pack was opened for review.",
            data: { driver_id: driverId }
        });
    });

// A driver asked to be contacted.
const notifyContactRequest = (operatorId, driver, message) =>
    safely("contact_request", async () =>
        create({
            userId: operatorId,
            actorId: driver.id,
            type: NOTIFICATION_TYPES.CONTACT_REQUEST,
            title: `${driver.first_name} ${driver.last_name} wants to contact you`,
            body: message || "A driver has asked you to get in touch.",
            data: { driver_id: driver.id }
        })
    );

// The expiry lock has been lifted.
//
// A driver who was suspended for an expired document, uploaded a replacement,
// and has now had it approved. Until this arrives they are looking at a lock
// screen, so it is the one notification they are actually waiting for.
const notifyExpiryLockCleared = (driverId) =>
    safely("expiry_lock_cleared", async () =>
        create({
            userId: driverId,
            type: NOTIFICATION_TYPES.ACCOUNT_APPROVED,
            title: "Your account is active again",
            body: "Your new document has been approved. You can start working.",
            data: { scope: "account", cleared: "document_expired" }
        })
    );

// Somebody typed this driver's share code and wants to see the documents.
//
// Neither name appears. The driver knows who they gave their code to; naming
// the operator would tell them who ELSE holds it, which is a different and
// worse thing to reveal.
//
// `data.request_id` is what the Allow and Deny buttons send back — so this one
// notification is not simply text to display, the app has to render it as a
// decision with two buttons.
const notifyAccessRequest = (driverId, requestId) =>
    safely("access_request", async () =>
        create({
            userId: driverId,
            type: NOTIFICATION_TYPES.ACCESS_REQUEST,
            title: "An operator wants to view your documents",
            body: "They used your share code. Allow only if you gave it to them.",
            data: { request_id: requestId, requires_decision: true }
        })
    );

// The driver answered. The operator has to be told, or they sit watching a
// screen that never changes.
const notifyAccessDecision = (operatorId, driverName, approved, requestId) =>
    safely("access_decision", async () =>
        create({
            userId: operatorId,
            type: approved
                ? NOTIFICATION_TYPES.ACCESS_GRANTED
                : NOTIFICATION_TYPES.ACCESS_DENIED,
            title: approved
                ? `${driverName} allowed access to their documents`
                : `${driverName} declined your request`,
            body: approved
                ? "You can view them for the next 30 minutes."
                : null,
            data: { request_id: requestId }
        })
    );

module.exports = {
    create,
    sentWithinLastDay,
    notifyDocumentsViewed,
    notifyContactRequest,
    notifyExpiryLockCleared,
    notifyAccessRequest,
    notifyAccessDecision
};