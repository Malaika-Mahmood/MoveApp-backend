// MoveApp — ratings.
//
// Two-way: the operator who created a booking rates the driver who did it, and
// that driver rates the operator. One rating per side per job.
//
// Every rule about who may rate whom lives here rather than in the controller,
// because the same question is asked from two directions — an operator posting
// a rating and a driver posting one — and two copies of that answer would drift
// apart within a month.
//
// ---------------------------------------------------------------------------
// The thing this file is careful about
// ---------------------------------------------------------------------------
// The subject of a rating is never sent by the app. It is worked out from the
// booking: if an operator is rating, the subject is that booking's driver, and
// nobody else. Accepting a subject_id from the request would let anybody rate
// anybody, which is the whole feature broken in one line.

const pool = require("../config/db");
const {
    isValidReason,
    RATING_WINDOW_DAYS,
    MAX_RATING_REASONS,
    MAX_RATING_COMMENT
} = require("../constants/bookings");

// -----------------------------------------------------------------------------
// The running totals on users
// -----------------------------------------------------------------------------
// Recomputed from the ratings themselves rather than nudged up and down.
//
// An incremental update is faster and wrong the first time anything unusual
// happens — a rating deleted by hand in the database, a half-finished
// transaction. Recounting one person's ratings is a handful of rows on an
// indexed column, and it is correct by construction. Speed is not the problem
// here; a wrong star rating on a driver's profile is.
//
// Takes a client rather than using the pool, so it runs inside the same
// transaction as the INSERT that caused it. Either both happen or neither does.
const recomputeFor = async (client, userId) => {
    await client.query(
        `UPDATE users u
            SET rating_average = agg.average,
                rating_count   = agg.total,
                updated_at     = NOW()
           FROM (
                 SELECT ROUND(AVG(score)::numeric, 2) AS average,
                        COUNT(*)::int                 AS total
                   FROM booking_ratings
                  WHERE subject_id = $1
                ) AS agg
          WHERE u.id = $1`,
        [userId]
    );
};

// Run by hand if the totals are ever suspected of drifting:
//   node -e "require('./services/ratings').recomputeAll().then(console.log)"
const recomputeAll = async () => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const result = await client.query(
            `UPDATE users u
                SET rating_average = agg.average,
                    rating_count   = agg.total
               FROM (
                     SELECT subject_id,
                            ROUND(AVG(score)::numeric, 2) AS average,
                            COUNT(*)::int                 AS total
                       FROM booking_ratings
                      GROUP BY subject_id
                    ) AS agg
              WHERE u.id = agg.subject_id
              RETURNING u.id`
        );

        // Anybody with no ratings at all goes back to NULL rather than keeping
        // a stale average from ratings that no longer exist.
        await client.query(
            `UPDATE users
                SET rating_average = NULL, rating_count = 0
              WHERE rating_count > 0
                AND id NOT IN (SELECT DISTINCT subject_id FROM booking_ratings)`
        );

        await client.query("COMMIT");
        return { recomputed: result.rowCount };

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        throw error;

    } finally {
        client.release();
    }
};

// -----------------------------------------------------------------------------
// Validating what was sent
// -----------------------------------------------------------------------------
// Every problem collected, not just the first. A form that reports one error,
// gets fixed, then reports the next one is a form people come to hate.
const validateRating = ({ score, reasons, comment }, raterRole) => {
    const errors = [];

    if (score === undefined || score === null || score === "") {
        errors.push({ field: "score", message: "A star rating is required" });
    } else if (!Number.isInteger(Number(score)) || Number(score) < 1 || Number(score) > 5) {
        errors.push({ field: "score", message: "score must be a whole number from 1 to 5" });
    }

    let cleanReasons = [];

    if (reasons !== undefined && reasons !== null) {
        if (!Array.isArray(reasons)) {
            errors.push({ field: "reasons", message: "reasons must be a list" });
        } else if (reasons.length > MAX_RATING_REASONS) {
            errors.push({
                field: "reasons",
                message: `No more than ${MAX_RATING_REASONS} reasons`
            });
        } else {
            // Duplicates removed rather than rejected — picking the same chip
            // twice is a UI accident, not something to fail a request over.
            cleanReasons = [...new Set(reasons.map((r) => String(r).trim()))];

            for (const reason of cleanReasons) {
                if (!isValidReason(raterRole, reason)) {
                    errors.push({
                        field: "reasons",
                        message: `"${reason}" is not a reason ${raterRole}s can give`
                    });
                }
            }
        }
    }

    let cleanComment = null;

    if (comment !== undefined && comment !== null && String(comment).trim() !== "") {
        cleanComment = String(comment).trim();

        if (cleanComment.length > MAX_RATING_COMMENT) {
            errors.push({
                field: "comment",
                message: `Keep the comment under ${MAX_RATING_COMMENT} characters`
            });
        }
    }

    return {
        errors,
        value: {
            score: Number(score),
            reasons: cleanReasons,
            comment: cleanComment
        }
    };
};

// -----------------------------------------------------------------------------
// Who is allowed to rate this booking, and about whom
// -----------------------------------------------------------------------------
// The one place that answers it. Returns the subject, or the reason not.
const resolveSides = (booking, raterId, raterRole) => {
    if (raterRole === "operator") {
        // The operator who CREATED the booking, not any operator. Another
        // operator in the same office had nothing to do with this job and has
        // no opinion worth recording about it.
        if (booking.created_by_operator_id !== raterId) {
            return { error: "NOT_YOURS", message: "This is not your booking" };
        }

        if (!booking.driver_id) {
            return { error: "NO_DRIVER", message: "Nobody drove this booking" };
        }

        return { subjectId: booking.driver_id };
    }

    if (raterRole === "driver") {
        if (booking.driver_id !== raterId) {
            return { error: "NOT_YOURS", message: "This is not your job" };
        }

        return { subjectId: booking.created_by_operator_id };
    }

    // Admins included. Somebody who was not on the job does not get an opinion
    // recorded as though they were.
    return { error: "NOT_A_PARTY", message: "Only the operator and the driver on a job can rate it" };
};

// -----------------------------------------------------------------------------
// Giving a rating
// -----------------------------------------------------------------------------
const rateBooking = async ({ bookingId, raterId, raterRole, score, reasons, comment }) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const result = await client.query(
            `SELECT id, reference, status, created_by_operator_id, driver_id, completed_at
               FROM bookings
              WHERE id = $1`,
            [bookingId]
        );

        const booking = result.rows[0];

        if (!booking) {
            await client.query("ROLLBACK");
            return { error: "NOT_FOUND", message: "No booking with that id" };
        }

        const sides = resolveSides(booking, raterId, raterRole);

        if (sides.error) {
            await client.query("ROLLBACK");
            return sides;
        }

        // Only finished jobs. Rating a job that is still running would be
        // rating a guess, and a driver who is marked down mid-journey has no
        // way to put it right.
        if (booking.status !== "completed") {
            await client.query("ROLLBACK");
            return {
                error: "NOT_COMPLETED",
                message: "A job can only be rated once it is completed",
                current_status: booking.status
            };
        }

        // Inside the window. Measured from completed_at, which is written the
        // moment the driver taps the last button.
        const windowResult = await client.query(
            `SELECT (completed_at > NOW() - ($2 || ' days')::interval) AS open,
                    completed_at
               FROM bookings WHERE id = $1`,
            [bookingId, String(RATING_WINDOW_DAYS)]
        );

        if (!windowResult.rows[0].open) {
            await client.query("ROLLBACK");
            return {
                error: "TOO_LATE",
                message: `Jobs can be rated for ${RATING_WINDOW_DAYS} days after they finish`,
                completed_at: windowResult.rows[0].completed_at
            };
        }

        // ON CONFLICT rather than a SELECT first. Two taps arriving a
        // millisecond apart would both pass a check-then-insert; this lets the
        // unique index decide, which it can do correctly.
        const inserted = await client.query(
            `INSERT INTO booking_ratings
                 (booking_id, rater_id, rater_role, subject_id, score, reasons, comment)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (booking_id, rater_role) DO NOTHING
             RETURNING *`,
            [bookingId, raterId, raterRole, sides.subjectId, score, reasons, comment]
        );

        if (inserted.rows.length === 0) {
            await client.query("ROLLBACK");
            return {
                error: "ALREADY_RATED",
                message: "You have already rated this job"
            };
        }

        await recomputeFor(client, sides.subjectId);

        await client.query("COMMIT");

        return {
            rating: inserted.rows[0],
            subjectId: sides.subjectId,
            reference: booking.reference
        };

    } catch (error) {
        await client.query("ROLLBACK").catch(() => { });
        throw error;

    } finally {
        client.release();
    }
};

// -----------------------------------------------------------------------------
// Reading ratings back
// -----------------------------------------------------------------------------

// What one person's record looks like.
//
// The breakdown matters as much as the average: 4.2 from forty jobs with two
// one-star ratings in it is a different driver from a flat 4.2 across the
// board, and the office should be able to see which they are looking at.
const summaryFor = async (userId) => {
    const user = await pool.query(
        `SELECT id, rating_average, rating_count, completed_trips
           FROM users WHERE id = $1`,
        [userId]
    );

    if (user.rows.length === 0) return null;

    const breakdown = await pool.query(
        `SELECT score, COUNT(*)::int AS total
           FROM booking_ratings
          WHERE subject_id = $1
          GROUP BY score`,
        [userId]
    );

    // Every score present, including the ones nobody gave — so the app can
    // draw five bars without inventing the missing rows itself.
    const scores = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const row of breakdown.rows) scores[row.score] = row.total;

    // How often each reason has been picked. This is the number the dress-code
    // question will actually be answered with.
    const reasons = await pool.query(
        `SELECT reason, COUNT(*)::int AS total
           FROM booking_ratings, UNNEST(reasons) AS reason
          WHERE subject_id = $1
          GROUP BY reason
          ORDER BY total DESC`,
        [userId]
    );

    const row = user.rows[0];

    return {
        // A number, not a string. pg returns NUMERIC as a string because it
        // will not silently lose precision, and an app doing maths on "4.20"
        // gets a surprise.
        rating_average: row.rating_average === null ? null : Number(row.rating_average),
        rating_count: row.rating_count,
        completed_trips: row.completed_trips,
        score_breakdown: scores,
        reason_counts: reasons.rows.reduce((all, r) => {
            all[r.reason] = r.total;
            return all;
        }, {})
    };
};

// The individual ratings somebody has received.
//
// includeRater decides whether the person who gave each one is named. False
// when a driver is looking at their own record — see the note on
// notifyRatingReceived. True for the office.
const listForSubject = async (userId, { includeRater = false, limit = 50 } = {}) => {
    const result = await pool.query(
        `SELECT r.id, r.score, r.reasons, r.comment, r.created_at,
                r.rater_role,
                b.id AS booking_id, b.reference, b.completed_at,
                rater.first_name AS rater_first_name,
                rater.last_name  AS rater_last_name
           FROM booking_ratings r
           JOIN bookings b   ON b.id = r.booking_id
           JOIN users rater  ON rater.id = r.rater_id
          WHERE r.subject_id = $1
          ORDER BY r.created_at DESC
          LIMIT $2`,
        [userId, Math.min(Number(limit) || 50, 100)]
    );

    return result.rows.map((r) => ({
        id: r.id,
        score: r.score,
        reasons: r.reasons || [],
        comment: r.comment,
        created_at: r.created_at,

        booking: {
            id: r.booking_id,
            reference: r.reference,
            completed_at: r.completed_at
        },

        // The role is always shown ("rated by an operator"); the name only
        // where the reader is entitled to it.
        rated_by_role: r.rater_role,
        ...(includeRater
            ? {
                rated_by: {
                    full_name: [r.rater_first_name, r.rater_last_name]
                        .filter(Boolean).join(" ")
                }
            }
            : {})
    }));
};

// What is on a single booking. Used by both sides' job screens to decide
// whether to show the rating form or the rating already given.
const forBooking = async (bookingId) => {
    const result = await pool.query(
        `SELECT id, rater_id, rater_role, subject_id, score, reasons, comment, created_at
           FROM booking_ratings
          WHERE booking_id = $1`,
        [bookingId]
    );

    const byRole = { operator: null, driver: null };

    for (const row of result.rows) {
        byRole[row.rater_role] = {
            id: row.id,
            score: row.score,
            reasons: row.reasons || [],
            comment: row.comment,
            created_at: row.created_at,
            rater_id: row.rater_id,
            subject_id: row.subject_id
        };
    }

    return byRole;
};

module.exports = {
    validateRating,
    resolveSides,
    rateBooking,
    summaryFor,
    listForSubject,
    forBooking,
    recomputeFor,
    recomputeAll
};
