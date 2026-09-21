const {
    ALL_BOOKING_TYPES,
    BOOKING_TYPES,
    BOOKING_STATUS_LABELS,
    BOOKING_TYPE_LABELS
} = require("../constants/bookings");

// The database connection is no longer needed here. It was only ever used to
// look up a vehicle class, and classes are gone — see the note further down.

// Checking and shaping a booking.
//
// Kept out of the controller because the same rules apply in three places —
// creating, editing, and (later) anything that imports bookings from the
// website. A rule written three times is a rule that will only be right once.

// -----------------------------------------------------------------------------
// Phone numbers
// -----------------------------------------------------------------------------

// The client's number has to end up in E.164, because that is what an SMS
// provider needs. An operator typing a job in at speed will write it any of
// these ways, and refusing them would just mean the operator gives up and puts
// the number in the notes field where nothing can use it.
//
//   07700 900123    ->  +447700900123
//   447700900123    ->  +447700900123
//   +44 7700 900123 ->  +447700900123
//
// Anything already starting with + for another country is left alone. Chauffeur
// clients fly in from everywhere, and assuming UK would corrupt their numbers.
const normalisePhone = (value) => {
    if (!value) return null;

    const raw = String(value).trim();
    const digits = raw.replace(/[^\d+]/g, "");

    if (digits.startsWith("+")) {
        return /^\+\d{7,15}$/.test(digits) ? digits : null;
    }

    // UK mobile or landline typed with the leading 0
    if (/^0\d{9,10}$/.test(digits)) return `+44${digits.slice(1)}`;

    // Already 44…, missing only the +
    if (/^44\d{9,10}$/.test(digits)) return `+${digits}`;

    return null;
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const POSTCODE_REGEX = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

// Returns { errors: [...], values: {...} }.
//
// Every problem is collected rather than returning at the first one. An
// operator filling in a six-step form should be told everything that is wrong
// in one go, not sent round the loop six times.
const validateBooking = async (body, { isUpdate = false } = {}) => {
    const errors = [];
    const values = {};

    const has = (key) => body[key] !== undefined;
    const str = (v) => (v === null || v === undefined ? null : String(v).trim());

    // ---- Type -------------------------------------------------------------
    let bookingType = body.booking_type;

    if (has("booking_type")) {
        if (!ALL_BOOKING_TYPES.includes(bookingType)) {
            errors.push(`booking_type must be one of: ${ALL_BOOKING_TYPES.join(", ")}`);
        } else {
            values.booking_type = bookingType;
        }
    } else if (!isUpdate) {
        bookingType = BOOKING_TYPES.DROP_OFF;
        values.booking_type = bookingType;
    }

    // ---- Client -----------------------------------------------------------
    if (has("client_name") || !isUpdate) {
        const name = str(body.client_name);
        if (!name) errors.push("client_name is required");
        else if (name.length > 120) errors.push("client_name must be 120 characters or fewer");
        else values.client_name = name;
    }

    if (has("client_phone") || !isUpdate) {
        const phone = normalisePhone(body.client_phone);
        if (!phone) {
            errors.push("client_phone is required and must be a valid phone number");
        } else {
            values.client_phone = phone;
        }
    }

    if (has("client_email")) {
        const email = str(body.client_email);
        if (email && !EMAIL_REGEX.test(email)) errors.push("client_email is not a valid email address");
        else values.client_email = email || null;
    }

    // ---- Journey ----------------------------------------------------------
    if (has("pickup_address") || !isUpdate) {
        const pickup = str(body.pickup_address);
        if (!pickup) errors.push("pickup_address is required");
        else values.pickup_address = pickup;
    }

    // A drop-off is required unless the car is booked by the hour — "as
    // directed" means the client decides where they are going as they go.
    const effectiveType = values.booking_type || bookingType;

    if (has("dropoff_address") || (!isUpdate && effectiveType !== BOOKING_TYPES.AS_DIRECTED)) {
        const dropoff = str(body.dropoff_address);
        if (!dropoff && effectiveType !== BOOKING_TYPES.AS_DIRECTED) {
            errors.push("dropoff_address is required for this booking type");
        } else {
            values.dropoff_address = dropoff || null;
        }
    }

    for (const key of ["pickup_postcode", "dropoff_postcode"]) {
        if (!has(key)) continue;
        const code = str(body[key]);
        if (code && !POSTCODE_REGEX.test(code)) errors.push(`${key} is not a valid UK postcode`);
        else values[key] = code ? code.toUpperCase() : null;
    }

    if (has("via_address")) values.via_address = str(body.via_address) || null;
    if (has("flight_number")) values.flight_number = str(body.flight_number) || null;

    // ---- When -------------------------------------------------------------
    // ASAP has no appointed time — that is the whole difference. Everything
    // else needs one.
    if (effectiveType === BOOKING_TYPES.ASAP) {
        values.scheduled_at = null;

    } else if (has("scheduled_at") || !isUpdate) {
        const when = str(body.scheduled_at);

        if (!when) {
            errors.push("scheduled_at is required unless the booking is ASAP");

        } else if (!ISO_DATETIME.test(when)) {
            errors.push("scheduled_at must be an ISO date and time, e.g. 2026-09-20T14:30");

        } else {
            const date = new Date(when);
            if (Number.isNaN(date.getTime())) {
                errors.push("scheduled_at is not a real date and time");
            } else {
                // Five minutes' grace. An operator typing in a job that starts
                // "now" will land a minute or two in the past, and refusing
                // that would be pedantry; a booking for last Tuesday is a typo
                // worth catching.
                if (date.getTime() < Date.now() - 5 * 60 * 1000) {
                    errors.push("scheduled_at is in the past");
                }
                values.scheduled_at = date.toISOString();
            }
        }
    }

    if (has("duration_hours")) {
        const hours = Number(body.duration_hours);
        if (Number.isNaN(hours) || hours <= 0 || hours > 24) {
            errors.push("duration_hours must be between 0 and 24");
        } else {
            values.duration_hours = hours;
        }
    }

    if (effectiveType === BOOKING_TYPES.AS_DIRECTED && !isUpdate && !values.duration_hours) {
        errors.push("duration_hours is required for an as-directed booking");
    }

    // ---- What is needed ---------------------------------------------------
    const counts = {
        passengers: { min: 1, max: 16 },
        large_bags: { min: 0, max: 20 },
        small_bags: { min: 0, max: 20 }
    };

    for (const [key, range] of Object.entries(counts)) {
        if (!has(key)) continue;
        const n = Number(body[key]);
        if (!Number.isInteger(n) || n < range.min || n > range.max) {
            errors.push(`${key} must be a whole number between ${range.min} and ${range.max}`);
        } else {
            values[key] = n;
        }
    }

    for (const key of ["child_seat", "wheelchair_accessible"]) {
        if (has(key)) values[key] = Boolean(body[key]);
    }

    if (has("special_instructions")) {
        const notes = str(body.special_instructions);
        if (notes && notes.length > 1000) errors.push("special_instructions must be 1000 characters or fewer");
        else values.special_instructions = notes || null;
    }

    // ---- What the client asked for ----------------------------------------
    // Free text, and free on purpose. The client can ask for a Range Rover, an
    // S Class, "something big", or the same car as last time — a dropdown can
    // only hold the words we thought of in advance, and the client is not
    // reading from our list.
    //
    // Never matched on. It is shown to the operator, who does what they do
    // today on the telephone: works out whether it can be done.
    if (has("requested_vehicle")) {
        const wanted = str(body.requested_vehicle);

        if (wanted && wanted.length > 120) {
            errors.push("requested_vehicle must be 120 characters or fewer");
        } else {
            values.requested_vehicle = wanted || null;
        }
    }

    // NOTE: vehicle_class_id is no longer accepted.
    //
    // Until 21 September a booking carried a class and drivers were matched on
    // it. The operator interview ended that: the office matches on how many
    // people and how much luggage, because those are the same in every
    // language, and a class name is not.
    //
    // The column and the vehicle_classes table still exist (migration 018
    // explains why) but nothing writes to them. A frontend still sending
    // vehicle_class_id is ignored rather than rejected, the same as any other
    // unknown field.

    return { errors, values };
};

// -----------------------------------------------------------------------------
// Does this car fit this job?
// -----------------------------------------------------------------------------
// Written here, once, because the same question is asked from four places: the
// operator's driver list, the pool notification, the driver's available-jobs
// list, and the check before an offer is made. Four copies of a rule is a rule
// that will be right in three places and wrong in the fourth, and nobody will
// know which.
//
// ---------------------------------------------------------------------------
// Unknown capacity means SHOWN, not hidden
// ---------------------------------------------------------------------------
// A car whose seats or luggage nobody has filled in yet passes every test
// below. That is deliberate and it is the important decision in this file.
//
// In September a free-text class mismatch made drivers vanish from the
// assignment screen — no error, no empty-state, no clue. It took two hours to
// find. Hiding is the dangerous default: an operator who sees a car with a
// question mark against it will ask; an operator who cannot see it at all
// never learns it was there.
//
// The API says so out loud with `capacity_known: false`, and the screen shows
// it, so nobody has to guess why a car is on the list.
//
// ---------------------------------------------------------------------------
// Why the numbers are written into the SQL rather than parameterised
// ---------------------------------------------------------------------------
// Every value here comes from a bookings row this same server wrote, and each
// one is forced through Math.trunc(Number(...)) below before it goes anywhere
// near a query. Nothing a caller typed reaches this. Parameters would be
// tidier, but these fragments get spliced into queries that already build
// their own $1, $2 lists, and renumbering those by hand is exactly how an
// off-by-one lands in production.

// Coerce to a whole, non-negative number. Anything unreadable becomes the
// fallback rather than breaking the query.
const count = (value, fallback = 0) => {
    const n = Math.trunc(Number(value));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// For a booking already loaded into JavaScript.
//   WHERE ... AND ${vehicleFits("v", booking)}
const vehicleFits = (v, booking) => {
    const passengers = count(booking?.passengers, 1);
    const large = count(booking?.large_bags, 0);
    const total = large + count(booking?.small_bags, 0);

    return `(
        (${v}.seats IS NULL OR ${v}.seats >= ${passengers})
    AND (${v}.luggage_large IS NULL OR ${v}.luggage_large >= ${large})
    AND (
            (${v}.luggage_large IS NULL AND ${v}.luggage_small IS NULL)
         OR COALESCE(${v}.luggage_large, 0) + COALESCE(${v}.luggage_small, 0) >= ${total}
        )
    )`;
};

// For a query where the bookings table is joined, so the numbers come from
// columns rather than from JavaScript.
//   WHERE ... AND ${vehicleFitsJoined("v", "b")}
const vehicleFitsJoined = (v, b) => `(
    (${v}.seats IS NULL OR ${v}.seats >= COALESCE(${b}.passengers, 1))
AND (${v}.luggage_large IS NULL OR ${v}.luggage_large >= COALESCE(${b}.large_bags, 0))
AND (
        (${v}.luggage_large IS NULL AND ${v}.luggage_small IS NULL)
     OR COALESCE(${v}.luggage_large, 0) + COALESCE(${v}.luggage_small, 0)
        >= COALESCE(${b}.large_bags, 0) + COALESCE(${b}.small_bags, 0)
    )
)`;

// The same question answered in JavaScript, for a vehicle row already in hand.
// Returns null when the car fits, or a sentence saying why it does not — which
// is what an operator needs to read when an offer is refused.
const reasonVehicleCannotFit = (vehicle, booking) => {
    if (!vehicle) return "That driver has no approved vehicle";

    const passengers = count(booking?.passengers, 1);
    const large = count(booking?.large_bags, 0);
    const total = large + count(booking?.small_bags, 0);

    if (vehicle.seats !== null && vehicle.seats !== undefined && vehicle.seats < passengers) {
        return `That car seats ${vehicle.seats}, and this job is for ${passengers}`;
    }

    const hasLuggage =
        (vehicle.luggage_large !== null && vehicle.luggage_large !== undefined) ||
        (vehicle.luggage_small !== null && vehicle.luggage_small !== undefined);

    if (hasLuggage) {
        const vLarge = count(vehicle.luggage_large, 0);
        const vTotal = vLarge + count(vehicle.luggage_small, 0);

        if (vLarge < large) {
            return `That car takes ${vLarge} large cases, and this job has ${large}`;
        }
        if (vTotal < total) {
            return `That car takes ${vTotal} bags in total, and this job has ${total}`;
        }
    }

    return null;
};

// Has anybody recorded what this car holds? Sent to the app so a car on the
// list with no capacity can be labelled rather than silently trusted.
const capacityKnown = (vehicle) =>
    Boolean(vehicle) &&
    vehicle.seats !== null && vehicle.seats !== undefined &&
    ((vehicle.luggage_large !== null && vehicle.luggage_large !== undefined) ||
        (vehicle.luggage_small !== null && vehicle.luggage_small !== undefined));

// -----------------------------------------------------------------------------
// Shaping
// -----------------------------------------------------------------------------

// pg returns NUMERIC as a string — deliberately, so it never silently loses
// precision on a value JavaScript cannot hold. Money is small enough here that
// a number is safe, and an app handed "95.00" to add up gets a surprise.
const num = (value) => (value === null || value === undefined ? null : Number(value));

// One shape for every endpoint that returns a booking, so the app never has to
// handle two versions of the same thing.
const toBooking = (b, { includeClientContact = true } = {}) => ({
    id: b.id,
    reference: b.reference,

    booking_type: b.booking_type,
    booking_type_label: BOOKING_TYPE_LABELS[b.booking_type] || b.booking_type,

    status: b.status,
    status_label: BOOKING_STATUS_LABELS[b.status] || b.status,

    client: {
        name: b.client_name,

        // A driver never gets the client's phone number or email. Not before
        // accepting, not after, not on the job itself.
        //
        // Decided 21 September: the office handles everything between the
        // passenger and the driver, in both directions. That is how Eurocars
        // works today, and it is what protects both sides — the client's
        // number does not end up in a stranger's phone, and the driver is not
        // taking calls about a job the office knows nothing about.
        //
        // Every driver-facing endpoint therefore passes includeClientContact
        // false. The flag stays because the operator and the admin do see
        // these fields, and they are the ones who ring people.
        //
        // The practical cost is real: at an airport a driver often needs to
        // reach the passenger. Until masked calling is built, that goes
        // through the operator — which is why "Contact Operator" needs to be
        // easy to find on the driver's trip screen.
        phone: includeClientContact ? b.client_phone : null,
        email: includeClientContact ? b.client_email : null,
        contact_masked: !includeClientContact
    },

    journey: {
        pickup_address: b.pickup_address,
        pickup_postcode: b.pickup_postcode,
        dropoff_address: b.dropoff_address,
        dropoff_postcode: b.dropoff_postcode,
        via_address: b.via_address,
        scheduled_at: b.scheduled_at,
        duration_hours: b.duration_hours,
        flight_number: b.flight_number
    },

    requirements: {
        passengers: b.passengers,
        large_bags: b.large_bags,
        small_bags: b.small_bags,
        total_luggage: (b.large_bags || 0) + (b.small_bags || 0),
        child_seat: b.child_seat,
        wheelchair_accessible: b.wheelchair_accessible,
        special_instructions: b.special_instructions
    },

    // What the client asked for, in their own words, or null in the ~80% of
    // jobs where they only said how many people and how much luggage.
    //
    // The app should show this prominently when it is set. It is the one thing
    // on the booking the system cannot check for the operator — they have to
    // read it and decide.
    requested_vehicle: b.requested_vehicle || null,

    // Kept so an older build of the app does not break on a missing key. Always
    // null on anything created after 21 September — see migration 018.
    vehicle_class: null,

    driver: b.driver_id
        ? {
            id: b.driver_id,
            full_name: [b.driver_first_name, b.driver_last_name].filter(Boolean).join(" ") || null,
            // Never the driver's own number, to anybody. That rule has not
            // changed because bookings exist.
            phone: null,
            contact_masked: true
        }
        : null,

    vehicle: b.vehicle_id
        ? {
            id: b.vehicle_id,
            registration_number: b.vehicle_registration || null,
            make: b.vehicle_make || null,
            model: b.vehicle_model || null
        }
        : null,

    is_open_to_all: b.is_open_to_all,
    published_at: b.published_at,

    timeline: {
        created_at: b.created_at,
        accepted_at: b.accepted_at,
        en_route_at: b.en_route_at,
        arrived_at: b.arrived_at,
        pob_at: b.pob_at,
        completed_at: b.completed_at,
        cancelled_at: b.cancelled_at
    },

    // Minutes the car waited at the pickup. Null until both ends are known.
    // Computed rather than stored: two timestamps and a subtraction cannot
    // disagree with each other, a third column can.
    waiting_minutes: b.arrived_at && b.pob_at
        ? Math.round((new Date(b.pob_at) - new Date(b.arrived_at)) / 60000)
        : null,

    cancellation: b.cancelled_at
        ? { reason: b.cancellation_reason, cancelled_by: b.cancelled_by, at: b.cancelled_at }
        : null,

    // How this job is priced, and what it settled at.
    //
    // Deliberately not named for whose money it is. The operator calls the
    // amount the driver's earning; the designer's screens show a payment
    // method and a total, which are client-side things. That question is open
    // and the CEO's payments brief will answer it — see migration 019.
    //
    // NUMERIC comes back from pg as a string, because it will not silently
    // lose precision. Converted here so the app is not handed "95.00" to do
    // arithmetic on.
    pricing: {
        mode: b.fare_mode || "fixed",

        // Set when mode is 'fixed'. May be null — the operator interview was
        // clear that jobs are sometimes given out with no amount at all.
        fixed_amount: num(b.fixed_amount),

        // Set when mode is 'bidding'. The window a driver must bid inside.
        bid_low: num(b.bid_low),
        bid_high: num(b.bid_high),

        // What it was agreed at, once a driver has it. Copied from the
        // accepted bid rather than read back through it, so editing that row
        // later cannot change what the job was done for.
        agreed_amount: num(b.agreed_amount),

        currency: b.fare_currency || "GBP"
    },

    // Reserved — see migration 013. The client-side total, still untouched
    // until the payments work.
    fare: {
        total: num(b.fare_total),
        currency: b.fare_currency,
        payment_method: b.payment_method
    }
});

// The SELECT every booking read uses. One list, so a new field appears
// everywhere at once instead of in whichever endpoint someone remembered.
const BOOKING_SELECT = `
    b.*,
    d.first_name AS driver_first_name,
    d.last_name  AS driver_last_name,
    v.registration_number AS vehicle_registration,
    v.make  AS vehicle_make,
    v.model AS vehicle_model,
    v.seats AS vehicle_seats,
    v.luggage_large AS vehicle_luggage_large,
    v.luggage_small AS vehicle_luggage_small
`;

// The vehicle_classes join is gone. Nothing reads it any more, and a join that
// exists only out of habit is a join somebody will eventually build a feature
// on by mistake.
const BOOKING_JOINS = `
    FROM bookings b
    LEFT JOIN users d    ON d.id = b.driver_id
    LEFT JOIN vehicles v ON v.id = b.vehicle_id
`;

module.exports = {
    normalisePhone,
    validateBooking,
    toBooking,
    BOOKING_SELECT,
    BOOKING_JOINS,

    vehicleFits,
    vehicleFitsJoined,
    reasonVehicleCannotFit,
    capacityKnown
};