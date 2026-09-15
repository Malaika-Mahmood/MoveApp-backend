const crypto = require("crypto");
const pool = require("../config/db");

// A driver's share code, and the permission it leads to.
//
// The shape of the thing:
//
//   1. Every driver has a permanent share_id and a PIN they can change.
//   2. An operator types both in. If they match, the operator immediately
//      learns the driver's name and whether they are verified. No permission
//      needed — that is the one fact the driver is trying to prove.
//   3. Seeing the DOCUMENTS is a separate step. It raises a request, the
//      driver taps Allow or Deny, and an Allow is good for thirty minutes.
//
// Everything to do with codes, requests and grants lives here so that no
// controller has to remember the rules. A permission check scattered across
// three endpoints is a permission check that will be missing from the fourth.

// Thirty minutes. Long enough to read a passport against a licence, short
// enough that a driver who allowed something at lunchtime is not still exposed
// in the evening.
const GRANT_MINUTES = 30;

// A request nobody answered is not pending forever. After a day it is stale —
// the operator has moved on, and an Allow tapped a week later would be the
// driver approving something they no longer remember.
const REQUEST_EXPIRY_HOURS = 24;

// Five wrong PINs in an hour and this operator stops being able to try.
//
// Six digits is a million combinations, so guessing is not really the worry.
// Walking the ID space to find out which codes exist is, and this stops that
// too.
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MINUTES = 60;

// ---------------------------------------------------------------------------
// Making a code
// ---------------------------------------------------------------------------

// Hex, deliberately. It has no O and no I, so there is nothing to confuse with
// 0 and 1 when a driver reads their code down a phone line — which is exactly
// how this will be used. The same alphabet is used by migration 012 so codes
// made before and after today look alike.
const randomBlock = (length) =>
    crypto.randomBytes(length).toString("hex").toUpperCase().slice(0, length);

const generateShareId = () => `MV-${randomBlock(4)}-${randomBlock(3)}`;

// randomInt, not Math.random. Math.random is predictable enough that a
// determined person could work out what somebody else's PIN is going to be,
// and it costs nothing to use the proper one.
const generatePin = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");

// "MV-1a2b-3c4", "mv1a2b3c4" and "MV 1A2B 3C4" are all the same code.
//
// People will type it with and without dashes, in either case, with a stray
// space from copy and paste. Refusing those would be technically correct and
// practically useless.
const normaliseShareId = (value) => {
    const bare = String(value || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");

    if (!/^MV[0-9A-F]{7}$/.test(bare)) return null;

    return `MV-${bare.slice(2, 6)}-${bare.slice(6, 9)}`;
};

const normalisePin = (value) => {
    const digits = String(value || "").replace(/\D/g, "");
    return /^\d{6}$/.test(digits) ? digits : null;
};

// The driver's own code, made on first use if they do not have one.
//
// Lazy rather than at registration, so a driver created by any route — the
// normal one, Google, a future import — ends up with a code without every one
// of those places having to remember to make it.
const getOrCreateShareCode = async (driverId) => {
    const existing = await pool.query(
        `SELECT share_id, share_pin, share_pin_updated_at
         FROM users WHERE id = $1`,
        [driverId]
    );

    const row = existing.rows[0];
    if (!row) return null;
    if (row.share_id && row.share_pin) return row;

    // The loop is for the vanishingly unlikely collision. 16^7 is 268 million,
    // so this will essentially never run twice — but "essentially never" is not
    // never, and the unique index would otherwise turn it into a 500.
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const shareId = generateShareId();
        const pin = generatePin();

        try {
            const updated = await pool.query(
                `UPDATE users
                 SET share_id = COALESCE(share_id, $2),
                     share_pin = COALESCE(share_pin, $3),
                     share_pin_updated_at = COALESCE(share_pin_updated_at, NOW())
                 WHERE id = $1
                 RETURNING share_id, share_pin, share_pin_updated_at`,
                [driverId, shareId, pin]
            );
            return updated.rows[0];

        } catch (error) {
            // 23505 is unique_violation — this ID is already somebody's.
            if (error.code !== "23505") throw error;
        }
    }

    throw new Error("Could not allocate a share ID");
};

// The driver changes their PIN. The ID never changes.
const changePin = async (driverId, requestedPin = null) => {
    const pin = requestedPin ? normalisePin(requestedPin) : generatePin();
    if (!pin) return null;

    const updated = await pool.query(
        `UPDATE users
         SET share_pin = $2, share_pin_updated_at = NOW(), updated_at = NOW()
         WHERE id = $1
         RETURNING share_id, share_pin, share_pin_updated_at`,
        [driverId, pin]
    );

    return updated.rows[0] || null;
};

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

const recordAttempt = (operatorId, shareIdTried, succeeded) =>
    pool.query(
        `INSERT INTO share_lookup_attempts (operator_id, share_id_tried, succeeded)
         VALUES ($1, $2, $3)`,
        [operatorId, shareIdTried || null, succeeded]
    );

// How long until this operator may try again? 0 means they may try now.
const failureLockoutSeconds = async (operatorId) => {
    const result = await pool.query(
        `SELECT attempted_at
         FROM share_lookup_attempts
         WHERE operator_id = $1
           AND succeeded = FALSE
           AND attempted_at > NOW() - ($2 || ' minutes')::interval
         ORDER BY attempted_at ASC`,
        [operatorId, FAILURE_WINDOW_MINUTES]
    );

    if (result.rows.length < MAX_FAILURES) return 0;

    // The lock lifts when the OLDEST failure falls out of the window, so the
    // operator is not punished for an hour from their last try — they get back
    // in as the window slides.
    const oldest = new Date(result.rows[0].attempted_at).getTime();
    const freeAt = oldest + FAILURE_WINDOW_MINUTES * 60 * 1000;

    return Math.max(0, Math.ceil((freeAt - Date.now()) / 1000));
};

// ---------------------------------------------------------------------------
// Looking a driver up
// ---------------------------------------------------------------------------

// Both must match, and the account must be a driver's.
//
// The two are checked in one query on purpose. Checking the ID first and the
// PIN second would let somebody tell a real ID from a made-up one by how long
// the answer took, which is the thing the PIN is there to prevent.
const findByShareCode = async (shareIdInput, pinInput) => {
    const shareId = normaliseShareId(shareIdInput);
    const pin = normalisePin(pinInput);

    if (!shareId || !pin) return null;

    const result = await pool.query(
        `SELECT id, first_name, middle_name, last_name, status, share_id
         FROM users
         WHERE role = 'driver' AND share_id = $1 AND share_pin = $2`,
        [shareId, pin]
    );

    return result.rows[0] || null;
};

// ---------------------------------------------------------------------------
// Requests and grants
// ---------------------------------------------------------------------------

// Anything still pending after a day is dead. Swept lazily rather than by a
// job, because it only matters at the moment somebody looks.
const expireStaleRequests = () =>
    pool.query(
        `UPDATE driver_access_requests
         SET status = 'expired', decided_at = NOW()
         WHERE status = 'pending'
           AND requested_at < NOW() - ($1 || ' hours')::interval`,
        [REQUEST_EXPIRY_HOURS]
    );

// Is this operator allowed to see this driver's documents right now?
const activeGrant = async (operatorId, driverId) => {
    const result = await pool.query(
        `SELECT id, expires_at
         FROM driver_access_requests
         WHERE operator_id = $1
           AND driver_id = $2
           AND status = 'approved'
           AND expires_at > NOW()
         ORDER BY expires_at DESC
         LIMIT 1`,
        [operatorId, driverId]
    );

    return result.rows[0] || null;
};

const pendingRequest = async (operatorId, driverId) => {
    const result = await pool.query(
        `SELECT id, requested_at
         FROM driver_access_requests
         WHERE operator_id = $1 AND driver_id = $2 AND status = 'pending'
         ORDER BY requested_at DESC
         LIMIT 1`,
        [operatorId, driverId]
    );

    return result.rows[0] || null;
};

// Ask. Returns the request, and whether it is new.
//
// An operator who already has a live grant does not raise a second request —
// they already have permission, and pestering the driver again would train
// them to tap Allow without reading it.
const createRequest = async (operatorId, driver) => {
    await expireStaleRequests();

    const granted = await activeGrant(operatorId, driver.id);
    if (granted) {
        return { status: "approved", request: granted, isNew: false };
    }

    const waiting = await pendingRequest(operatorId, driver.id);
    if (waiting) {
        return { status: "pending", request: waiting, isNew: false };
    }

    const created = await pool.query(
        `INSERT INTO driver_access_requests (driver_id, operator_id, share_id_used)
         VALUES ($1, $2, $3)
         RETURNING id, status, requested_at`,
        [driver.id, operatorId, driver.share_id]
    );

    return { status: "pending", request: created.rows[0], isNew: true };
};

// The driver answers. Only their own requests, and only ones still pending —
// an Allow tapped twice must not extend the window a second time.
const decideRequest = async (driverId, requestId, decision) => {
    if (decision !== "approved" && decision !== "denied") return null;

    await expireStaleRequests();

    const expiresAt = decision === "approved"
        ? `NOW() + INTERVAL '${GRANT_MINUTES} minutes'`
        : "NULL";

    const updated = await pool.query(
        `UPDATE driver_access_requests
         SET status = $3,
             decided_at = NOW(),
             expires_at = ${expiresAt}
         WHERE id = $1
           AND driver_id = $2
           AND status = 'pending'
         RETURNING *`,
        [requestId, driverId, decision]
    );

    return updated.rows[0] || null;
};

// The driver's own list: who asked, when, what they answered.
const requestsForDriver = async (driverId, limit = 20) => {
    await expireStaleRequests();

    const result = await pool.query(
        `SELECT r.id, r.status, r.requested_at, r.decided_at, r.expires_at,
                (r.status = 'approved' AND r.expires_at > NOW()) AS is_active
         FROM driver_access_requests r
         WHERE r.driver_id = $1
         ORDER BY r.requested_at DESC
         LIMIT $2`,
        [driverId, limit]
    );

    // No operator name anywhere in here. Masking runs both ways: the driver is
    // told that an operator asked, not which one — the same rule as
    // "An operator viewed your documents".
    return result.rows;
};

module.exports = {
    GRANT_MINUTES,
    MAX_FAILURES,
    generateShareId,
    generatePin,
    normaliseShareId,
    normalisePin,
    getOrCreateShareCode,
    changePin,
    recordAttempt,
    failureLockoutSeconds,
    findByShareCode,
    activeGrant,
    createRequest,
    decideRequest,
    requestsForDriver,
    expireStaleRequests
};