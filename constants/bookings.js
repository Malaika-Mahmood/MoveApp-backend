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
// Offers and bids
// -----------------------------------------------------------------------------
// Two ways a driver ends up connected to a booking, sharing one table because
// they share one life — see migration 019.
//
//   direct  the operator put the job to one named driver
//   bid     the driver put their hand up for an open job
const OFFER_KIND = {
    DIRECT: "direct",
    BID: "bid"
};

const OFFER_STATUS = {
    PENDING: "pending",
    ACCEPTED: "accepted",

    // The DRIVER said no. Only a direct offer can be declined — nobody
    // declines a job they were never given.
    DECLINED: "declined",

    // The OPERATOR said no to this bid. Different from declined, and kept
    // apart on purpose: "the driver turned us down" and "we turned the driver
    // down" are not the same fact, and one day somebody will count them.
    REJECTED: "rejected",

    // The job went to somebody else. Not a judgement on this driver — they
    // were simply not the one chosen — which is why it is not 'rejected'.
    LOST: "lost",

    EXPIRED: "expired",

    // A direct offer taken back by the operator, or a bid taken back by the
    // driver. Same word because it is the same act: whoever made it, unmade it.
    WITHDRAWN: "withdrawn"
};

// -----------------------------------------------------------------------------
// How a booking is priced
// -----------------------------------------------------------------------------
// FIXED    the operator names one amount
// BIDDING  the operator names a range and drivers say what they will take
//
// Whose money this is has not been decided — the operator calls it the
// driver's earning, the designer's screens show client-side payment. See the
// note at the top of migration 019.
const FARE_MODE = {
    FIXED: "fixed",
    BIDDING: "bidding"
};

const ALL_FARE_MODES = Object.values(FARE_MODE);

// Amounts are held to two decimal places and cannot be negative. The ceiling
// is not a business rule, it is a typo catch: a £900,000 airport transfer is
// somebody's finger slipping, and it is better refused at the door than
// discovered on an invoice.
const MAX_AMOUNT = 100000;

const isValidAmount = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= MAX_AMOUNT;
};

// Money as a number the database will accept, or null. Rounded rather than
// truncated — £10.005 becoming £10.00 loses somebody a penny every time, and
// pennies are what people notice.
const toAmount = (value) => {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
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
// Ratings
// -----------------------------------------------------------------------------
// A score on its own tells you almost nothing. "Three stars" could mean the
// driver was late, or rude, or turned up in jeans — and those are three
// different conversations. So a rating may carry reasons.
//
// A fixed list rather than free text, because free text cannot be counted. The
// question the office will actually ask is "how often is this driver marked
// down for dress code?", and that is only answerable if everybody picks from
// the same words.
//
// Two lists, because the things that go wrong with a driver are not the things
// that go wrong with an operator.
const RATING_REASONS = {
    // Operator rating the driver
    operator: [
        "dress_code",          // not in a suit — this is where the photo feature lands
        "late",
        "vehicle_condition",
        "communication",
        "driving",
        "professional"
    ],

    // Driver rating the operator
    driver: [
        "clear_instructions",
        "communication",
        "wrong_details",       // bad address, wrong number, wrong time
        "payment"
    ]
};

// The words shown to whoever is picking. Kept beside the codes so the app does
// not invent its own wording and end up saying something different from the
// reports.
const RATING_REASON_LABELS = {
    dress_code: "Dress code",
    late: "Late",
    vehicle_condition: "Vehicle condition",
    communication: "Communication",
    driving: "Driving",
    professional: "Professionalism",
    clear_instructions: "Clear instructions",
    wrong_details: "Wrong booking details",
    payment: "Payment"
};

const reasonsFor = (raterRole) => RATING_REASONS[raterRole] || [];

const isValidReason = (raterRole, reason) => reasonsFor(raterRole).includes(reason);

// How long after a job somebody may still rate it.
//
// A rating given three months later is not a memory, it is a grudge. Seven days
// covers a Monday job rated at the weekend, which is the real case.
const RATING_WINDOW_DAYS = 7;

// A cap so a malformed request cannot write a thousand-element array. Nobody
// picking honestly will reach it.
const MAX_RATING_REASONS = 6;

// Matches the column width in migration 016. A note, not an essay — a long
// complaint belongs in Report an Issue.
const MAX_RATING_COMMENT = 500;

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
    OFFER_KIND,
    OFFER_TIMEOUT_MINUTES,
    offerTimeoutFor,

    FARE_MODE,
    ALL_FARE_MODES,
    MAX_AMOUNT,
    isValidAmount,
    toAmount,
    BOOKING_STATUS_LABELS,
    BOOKING_TYPE_LABELS,

    RATING_REASONS,
    RATING_REASON_LABELS,
    reasonsFor,
    isValidReason,
    RATING_WINDOW_DAYS,
    MAX_RATING_REASONS,
    MAX_RATING_COMMENT
};