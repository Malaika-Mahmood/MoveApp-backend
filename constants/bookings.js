// Everything about a booking's shape, in one place.
//
// The statuses and the moves between them live here rather than inside the
// controller, because "can this booking go from X to Y?" is asked from three
// different directions — the operator cancelling, the driver tapping a button,
// the expiry sweep — and three copies of that answer would drift apart.

// -----------------------------------------------------------------------------
// Types of booking
// -----------------------------------------------------------------------------
const BOOKING_TYPES = {
    // Now. No appointed time — the client is standing there.
    ASAP: "asap",

    // Booked by the hour. The driver stays with the client.
    AS_DIRECTED: "as_directed",

    // A scheduled journey from one place to another. The common case.
    DROP_OFF: "drop_off"
};

const ALL_BOOKING_TYPES = Object.values(BOOKING_TYPES);

// -----------------------------------------------------------------------------
// Statuses
// -----------------------------------------------------------------------------
const BOOKING_STATUS = {
    PENDING: "pending",          // nobody has it yet
    OFFERED: "offered",          // put to one driver, waiting on them
    ACCEPTED: "accepted",        // a driver has it, not moving yet
    EN_ROUTE: "en_route",        // driving to the pickup
    ARRIVED: "arrived",          // at the pickup, waiting
    IN_PROGRESS: "in_progress",  // passenger on board
    COMPLETED: "completed",
    CANCELLED: "cancelled"
};

const ALL_BOOKING_STATUSES = Object.values(BOOKING_STATUS);

// Where a booking may go next.
//
// Arrived and in_progress are separate on purpose: the gap between them is
// waiting time, and a client who kept a car waiting forty minutes is billed
// for it. Merge them and that number is gone for good.
const ALLOWED_TRANSITIONS = {
    pending: ["offered", "accepted", "cancelled"],
    offered: ["accepted", "pending", "cancelled"],   // back to pending on a decline
    accepted: ["en_route", "pending", "cancelled"],  // back to pending if unassigned
    en_route: ["arrived", "cancelled"],
    arrived: ["in_progress", "cancelled"],
    in_progress: ["completed", "cancelled"],
    completed: [],
    cancelled: []
};

const canTransition = (from, to) =>
    Boolean(ALLOWED_TRANSITIONS[from] && ALLOWED_TRANSITIONS[from].includes(to));

// The status a driver's button sets, and the column that records the moment.
//
// Every step is timestamped separately rather than keeping one
// status_changed_at, because the gaps are the interesting part: arrived to POB
// is waiting, POB to completed is the journey itself.
const DRIVER_STATUS_STEPS = {
    en_route: "en_route_at",
    arrived: "arrived_at",
    in_progress: "pob_at",
    completed: "completed_at"
};

// -----------------------------------------------------------------------------
// Offers
// -----------------------------------------------------------------------------
const OFFER_STATUS = {
    PENDING: "pending",
    ACCEPTED: "accepted",
    DECLINED: "declined",
    EXPIRED: "expired",
    WITHDRAWN: "withdrawn"
};

// How long a driver has to answer.
//
// ASAP gets three minutes because somebody is waiting on a pavement. A
// scheduled job gets no deadline at all — the driver may be mid-journey and
// will look at it when they stop, and an offer for next Tuesday that expired
// while they drove would help nobody. The operator withdraws those by hand.
const OFFER_TIMEOUT_MINUTES = {
    asap: 3,
    as_directed: null,
    drop_off: null
};

const offerTimeoutFor = (bookingType) =>
    OFFER_TIMEOUT_MINUTES[bookingType] ?? null;

// -----------------------------------------------------------------------------
// Labels
// -----------------------------------------------------------------------------
// Written once here so the app, the notifications and any future PDF all say
// the same words.
const BOOKING_STATUS_LABELS = {
    pending: "Unassigned",
    offered: "Awaiting driver",
    accepted: "Assigned",
    en_route: "En route to pickup",
    arrived: "Arrived at pickup",
    in_progress: "On board",
    completed: "Completed",
    cancelled: "Cancelled"
};

const BOOKING_TYPE_LABELS = {
    asap: "ASAP",
    as_directed: "As Directed",
    drop_off: "Drop-off"
};

module.exports = {
    BOOKING_TYPES,
    ALL_BOOKING_TYPES,
    BOOKING_STATUS,
    ALL_BOOKING_STATUSES,
    ALLOWED_TRANSITIONS,
    canTransition,
    DRIVER_STATUS_STEPS,
    OFFER_STATUS,
    OFFER_TIMEOUT_MINUTES,
    offerTimeoutFor,
    BOOKING_STATUS_LABELS,
    BOOKING_TYPE_LABELS
};