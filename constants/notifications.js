// Every notification type in the product, in one place.
//
// The database deliberately has no CHECK on notifications.type — this list is
// what the API validates against, so adding a type is a code change rather than
// a migration. Chat, bookings and payments will each add their own.

const NOTIFICATION_TYPES = {
    // An operator opened a driver's document pack.
    DOCUMENTS_VIEWED: "documents_viewed",

    // A driver asked their operator to get in touch.
    CONTACT_REQUEST: "contact_request",

    // Built next, with the expiry job — listed now so the app can handle every
    // type from day one instead of meeting an unknown one later.
    DOCUMENT_EXPIRING: "document_expiring",
    DOCUMENT_EXPIRED: "document_expired",

    // Raised where documents are verified.
    DOCUMENT_APPROVED: "document_approved",
    DOCUMENT_REJECTED: "document_rejected",
    ACCOUNT_APPROVED: "account_approved",
    ACCOUNT_REJECTED: "account_rejected",
    ACCOUNT_SUSPENDED: "account_suspended",

    // Share code. An operator typed a driver's ID and PIN and wants to see the
    // documents; the driver answers yes or no.
    //
    // ACCESS_REQUEST goes to the driver and is the only notification in the
    // product that the app must not simply display — it needs two buttons.
    ACCESS_REQUEST: "access_request",
    ACCESS_GRANTED: "access_granted",
    ACCESS_DENIED: "access_denied",

    // Work. JOB_OFFERED is the second notification in the product that the
    // app must render with buttons rather than as a line of text — see
    // requires_decision.
    JOB_OFFERED: "job_offered",
    JOB_PUBLISHED: "job_published",
    OFFER_WITHDRAWN: "offer_withdrawn",
    OFFER_EXPIRED: "offer_expired",
    JOB_ACCEPTED: "job_accepted",
    JOB_DECLINED: "job_declined",
    JOB_STATUS_CHANGED: "job_status_changed",
    JOB_CANCELLED: "job_cancelled",

    // Somebody rated you for a completed job. Goes to both sides — a driver
    // rated by an operator, and an operator rated by a driver.
    RATING_RECEIVED: "rating_received",

    // Your job is finished and the other side is waiting on your rating. Sent
    // once, not nagged.
    RATING_REMINDER: "rating_reminder"
};

// Which tab of the driver's Inbox a notification belongs in: All / Jobs /
// Payments / System.
//
// Decided here rather than in the app, so that adding a type is one change in
// one file. An app switching on type would need releasing every time.
const NOTIFICATION_CATEGORIES = {
    JOBS: "jobs",
    PAYMENTS: "payments",
    SYSTEM: "system"
};

const CATEGORY_BY_TYPE = {
    job_offered: "jobs",
    job_published: "jobs",
    offer_withdrawn: "jobs",
    offer_expired: "jobs",
    job_accepted: "jobs",
    job_declined: "jobs",
    job_status_changed: "jobs",
    job_cancelled: "jobs",

    // A rating is about a job, so it belongs in the Jobs tab rather than
    // System — that is where somebody will go looking for it.
    rating_received: "jobs",
    rating_reminder: "jobs"
    // Everything else — documents, access requests, account changes — is
    // system. That is the default below rather than a list to keep in step.
};

const categoryFor = (type) => CATEGORY_BY_TYPE[type] || NOTIFICATION_CATEGORIES.SYSTEM;

const ALL_NOTIFICATION_TYPES = Object.values(NOTIFICATION_TYPES);

const isValidNotificationType = (type) => ALL_NOTIFICATION_TYPES.includes(type);

module.exports = {
    NOTIFICATION_TYPES,
    NOTIFICATION_CATEGORIES,
    categoryFor,
    ALL_NOTIFICATION_TYPES,
    isValidNotificationType
};
