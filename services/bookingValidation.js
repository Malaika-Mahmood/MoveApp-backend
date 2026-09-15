const pool = require("../config/db");
const {
    ALL_BOOKING_TYPES,
    BOOKING_TYPES,
    BOOKING_STATUS_LABELS,
    BOOKING_TYPE_LABELS
} = require("../constants/bookings");

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

    // ---- Vehicle class ----------------------------------------------------
    if (has("vehicle_class_id")) {
        const classId = Number(body.vehicle_class_id);

        if (!Number.isInteger(classId)) {
            errors.push("vehicle_class_id must be a number");

        } else {
            const result = await pool.query(
                "SELECT * FROM vehicle_classes WHERE id = $1 AND is_active",
                [classId]
            );
            const vehicleClass = result.rows[0];

            if (!vehicleClass) {
                errors.push("vehicle_class_id does not match an active vehicle class");

            } else {
                values.vehicle_class_id = classId;

                // The screen already says "4 pax max · 3 bags". Letting an
                // operator book six people into a saloon would only be
                // discovered by the driver, at the kerb, with the client
                // watching.
                const pax = values.passengers ?? body.passengers;
                if (pax && pax > vehicleClass.max_passengers) {
                    errors.push(
                        `${vehicleClass.name} carries up to ${vehicleClass.max_passengers} passengers, not ${pax}`
                    );
                }

                const large = values.large_bags ?? body.large_bags;
                if (large && large > vehicleClass.max_large_bags) {
                    errors.push(
                        `${vehicleClass.name} takes up to ${vehicleClass.max_large_bags} large bags, not ${large}`
                    );
                }
            }
        }
    }

    return { errors, values };
};

// -----------------------------------------------------------------------------
// Shaping
// -----------------------------------------------------------------------------

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
        // A driver who has not accepted yet does not get the client's number.
        // They can see where the job goes and when; they cannot ring the
        // client about a job they have not taken.
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

    vehicle_class: b.vehicle_class_id
        ? {
            id: b.vehicle_class_id,
            code: b.vehicle_class_code || null,
            name: b.vehicle_class_name || null,
            max_passengers: b.vehicle_class_max_passengers ?? null
        }
        : null,

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

    // Reserved — see migration 013. Always null until fare work is done.
    fare: {
        total: b.fare_total,
        currency: b.fare_currency,
        payment_method: b.payment_method
    }
});

// The SELECT every booking read uses. One list, so a new field appears
// everywhere at once instead of in whichever endpoint someone remembered.
const BOOKING_SELECT = `
    b.*,
    vc.code  AS vehicle_class_code,
    vc.name  AS vehicle_class_name,
    vc.max_passengers AS vehicle_class_max_passengers,
    d.first_name AS driver_first_name,
    d.last_name  AS driver_last_name,
    v.registration_number AS vehicle_registration,
    v.make  AS vehicle_make,
    v.model AS vehicle_model
`;

const BOOKING_JOINS = `
    FROM bookings b
    LEFT JOIN vehicle_classes vc ON vc.id = b.vehicle_class_id
    LEFT JOIN users d            ON d.id  = b.driver_id
    LEFT JOIN vehicles v         ON v.id  = b.vehicle_id
`;

module.exports = {
    normalisePhone,
    validateBooking,
    toBooking,
    BOOKING_SELECT,
    BOOKING_JOINS
};