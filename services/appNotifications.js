const pool = require("../config/db");
const {
    NOTIFICATION_TYPES,
    isValidNotificationType,
    categoryFor
} = require("../constants/notifications");

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

    // The category is worked out from the type rather than passed in, so no
    // caller can put a job notification in the wrong tab of the driver's inbox.
    const result = await pool.query(
        `INSERT INTO notifications (user_id, actor_id, type, title, body, data, category)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [userId, actorId, type, title, body, JSON.stringify(data), categoryFor(type)]
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

// -----------------------------------------------------------------------------
// Work
// -----------------------------------------------------------------------------

// A job has been put to this driver.
//
// Like access_request, this one carries requires_decision — the app renders it
// with Accept and Decline, not as a line of text. Both buttons send the
// offer_id back.
const notifyJobOffered = (driverId, bookingId, offerId, expiresInMinutes) =>
    safely("job_offered", async () =>
        create({
            userId: driverId,
            type: NOTIFICATION_TYPES.JOB_OFFERED,
            title: "New job offer",
            body: expiresInMinutes
                ? `Respond within ${expiresInMinutes} minutes.`
                : "Tap to see the details.",
            data: {
                booking_id: bookingId,
                offer_id: offerId,
                requires_decision: true,
                expires_in_minutes: expiresInMinutes || null
            }
        })
    );

// A job has gone into the open pool. Sent only to drivers who are online and
// whose car fits — see publishBooking.
const notifyJobPublished = (driverId, bookingId) =>
    safely("job_published", async () =>
        create({
            userId: driverId,
            type: NOTIFICATION_TYPES.JOB_PUBLISHED,
            title: "A job is available",
            body: "First to accept takes it.",
            data: { booking_id: bookingId }
        })
    );

const notifyOfferWithdrawn = (driverId, bookingId) =>
    safely("offer_withdrawn", async () =>
        create({
            userId: driverId,
            type: NOTIFICATION_TYPES.OFFER_WITHDRAWN,
            title: "A job offer was withdrawn",
            body: "The operator has given it to someone else.",
            data: { booking_id: bookingId }
        })
    );

// The operator hears back. Without these they are watching a screen that
// never changes — which is exactly what the phone call used to solve.
const notifyOfferAccepted = (operatorId, bookingId, driverName) =>
    safely("job_accepted", async () =>
        create({
            userId: operatorId,
            type: NOTIFICATION_TYPES.JOB_ACCEPTED,
            title: `${driverName} accepted the job`,
            body: null,
            data: { booking_id: bookingId }
        })
    );

const notifyOfferDeclined = (operatorId, bookingId, driverName) =>
    safely("job_declined", async () =>
        create({
            userId: operatorId,
            type: NOTIFICATION_TYPES.JOB_DECLINED,
            title: `${driverName} declined the job`,
            body: "The booking is unassigned again.",
            data: { booking_id: bookingId }
        })
    );

// Wording the operator can read at a glance from across the office.
const JOB_STATUS_WORDS = {
    en_route: "is on the way to the pickup",
    arrived: "has arrived at the pickup",
    in_progress: "has the passenger on board",
    completed: "has completed the job"
};

const notifyJobStatusChanged = (operatorId, bookingId, status, driverName) =>
    safely("job_status_changed", async () =>
        create({
            userId: operatorId,
            type: NOTIFICATION_TYPES.JOB_STATUS_CHANGED,
            title: `${driverName} ${JOB_STATUS_WORDS[status] || `moved the job to ${status}`}`,
            body: null,
            data: { booking_id: bookingId, status }
        })
    );

const notifyJobCancelled = (driverId, bookingId, reference) =>
    safely("job_cancelled", async () =>
        create({
            userId: driverId,
            type: NOTIFICATION_TYPES.JOB_CANCELLED,
            title: `Job ${reference} has been cancelled`,
            body: null,
            data: { booking_id: bookingId }
        })
    );

// -----------------------------------------------------------------------------
// Ratings
// -----------------------------------------------------------------------------

// Somebody has rated you.
//
// The rater is NOT named, in either direction. A driver who could see that a
// particular operator gave them two stars would go and argue about it, and
// that operator would quietly stop rating honestly. The office can see who
// gave what; the person rated sees the score and the reasons.
//
// The score IS included. "You have been rated" with the number withheld is
// worse than saying nothing — it sends somebody to the app in a panic.
const notifyRatingReceived = (subjectId, reference, score, reasons = []) =>
    safely("rating_received", async () =>
        create({
            userId: subjectId,
            type: NOTIFICATION_TYPES.RATING_RECEIVED,
            title: `You received a ${score}-star rating`,
            body: reasons.length
                ? `For job ${reference}. Tap to see what was noted.`
                : `For job ${reference}.`,
            // No rater id in here. It is not shown, so it is not sent: a value
            // that reaches the phone is a value that can be read off it.
            data: { reference, score, reasons }
        })
    );

// The job is finished — now please rate it.
//
// Sent once, when the job completes, to both sides. Never repeated: a system
// that nags for ratings collects ratings given to stop the nagging, and those
// are worth nothing.
const notifyRatingDue = (userId, bookingId, reference) =>
    safely("rating_reminder", async () =>
        create({
            userId,
            type: NOTIFICATION_TYPES.RATING_REMINDER,
            title: `How did job ${reference} go?`,
            body: "Leave a rating — it only takes a moment.",
            data: { booking_id: bookingId, reference }
        })
    );

module.exports = {
    create,
    notifyJobOffered,
    notifyJobPublished,
    notifyOfferWithdrawn,
    notifyOfferAccepted,
    notifyOfferDeclined,
    notifyJobStatusChanged,
    notifyJobCancelled,
    sentWithinLastDay,
    notifyDocumentsViewed,
    notifyContactRequest,
    notifyExpiryLockCleared,
    notifyAccessRequest,
    notifyAccessDecision,
    notifyRatingReceived,
    notifyRatingDue
};
