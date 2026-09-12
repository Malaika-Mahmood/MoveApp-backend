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
    ACCOUNT_SUSPENDED: "account_suspended"
};

const ALL_NOTIFICATION_TYPES = Object.values(NOTIFICATION_TYPES);

const isValidNotificationType = (type) => ALL_NOTIFICATION_TYPES.includes(type);

module.exports = {
    NOTIFICATION_TYPES,
    ALL_NOTIFICATION_TYPES,
    isValidNotificationType
};