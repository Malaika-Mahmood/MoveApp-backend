-- =============================================================================
-- MoveApp — 016: ratings and trip counts
-- =============================================================================
-- Two-way rating, decided by the CEO on 16 September: the operator rates the
-- driver after a job, and the driver rates the operator. Both sides, because
-- a system where only one side is judged stops being feedback and becomes
-- surveillance — and because an operator who sends wrong addresses is a real
-- problem that nobody currently has anywhere to record.
--
-- One rating per side per booking. That is what the UNIQUE below enforces, and
-- it is enforced in the database rather than only in the service because a
-- double-tap on a phone with a bad signal sends the same request twice.
--
-- Ratings hang off a BOOKING, not off a person. "Four stars" on its own is an
-- opinion; "four stars on job BK-1043, which happened, which this person drove"
-- can be looked into when somebody disputes it.
--
-- Deliberately NOT connected to favourites. Favourites stay a hand-made list
-- (see 014) — a rating is an opinion about a job that already happened, a
-- favourite is a decision about who to call next time.
--
-- Safe to run more than once.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- The ratings themselves
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_ratings (
    id           SERIAL PRIMARY KEY,

    booking_id   INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,

    -- Who gave it, and from which side of the job. rater_role is stored rather
    -- than read from users.role at display time, because a person's role could
    -- in principle change later and this record must keep saying what it meant
    -- on the day.
    rater_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rater_role   VARCHAR(20) NOT NULL,          -- operator | driver

    -- Who it is about. Always the other party on the same booking; the service
    -- works it out, it is never sent by the app.
    subject_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- 1 to 5. A CHECK is right here where it would be wrong on status columns:
    -- this domain is fixed forever, five stars is five stars.
    score        SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 5),

    -- Why. "dress_code", "late", "wrong_details" and so on — the allowed list
    -- lives in constants/bookings.js, not in a CHECK here, because it will grow
    -- and growing it should be a code change rather than a migration.
    --
    -- An array because more than one thing can be wrong with the same job.
    -- Empty is normal: a five-star rating usually needs no explanation.
    reasons      TEXT[] NOT NULL DEFAULT '{}',

    -- Free text, optional. Short on purpose — this is a note, not an essay,
    -- and a 5,000-word complaint belongs in Report an Issue.
    comment      VARCHAR(500),

    created_at   TIMESTAMP NOT NULL DEFAULT NOW(),

    -- One per side per booking. The operator rates once, the driver rates once.
    UNIQUE (booking_id, rater_role)
);

-- "Show me this driver's ratings, newest first" — the operator's driver profile
-- screen, and the driver's own.
CREATE INDEX IF NOT EXISTS booking_ratings_by_subject
    ON booking_ratings (subject_id, created_at DESC);

-- "Has this booking been rated yet?" — asked every time a completed job is
-- opened, by both sides.
CREATE INDEX IF NOT EXISTS booking_ratings_by_booking
    ON booking_ratings (booking_id);

-- -----------------------------------------------------------------------------
-- The running totals
-- -----------------------------------------------------------------------------
-- Kept on users rather than worked out each time.
--
-- The assignment screen lists up to a hundred drivers and shows a star rating
-- and a trip count against every one of them. Counting rows for each driver on
-- each of those requests is the kind of query that is fine with eleven drivers
-- and unusable with four hundred. These three columns are written at the moment
-- something changes, and read everywhere else.
--
-- The trade is that they can drift if a rating is ever deleted by hand. The
-- recompute in services/ratings.js is the cure, and it runs from the rating
-- itself so ordinary use keeps them correct.
ALTER TABLE users ADD COLUMN IF NOT EXISTS rating_average   NUMERIC(3,2);
ALTER TABLE users ADD COLUMN IF NOT EXISTS rating_count     INTEGER NOT NULL DEFAULT 0;

-- "847 trips" on the driver's profile. Jobs that reached completed — not jobs
-- accepted, not jobs cancelled halfway.
ALTER TABLE users ADD COLUMN IF NOT EXISTS completed_trips  INTEGER NOT NULL DEFAULT 0;

-- NULL average rather than 0.00 for somebody with no ratings yet. Zero would
-- sort a brand new driver below a terrible one, and the app needs to show
-- "New" rather than "0 stars".

-- -----------------------------------------------------------------------------
-- Backfill
-- -----------------------------------------------------------------------------
-- Jobs already completed before this migration existed still count. Without
-- this every driver starts at zero trips tomorrow morning, which is both wrong
-- and the kind of wrong a driver notices immediately.
UPDATE users u
   SET completed_trips = done.total
  FROM (
        SELECT driver_id, COUNT(*)::int AS total
          FROM bookings
         WHERE status = 'completed'
           AND driver_id IS NOT NULL
         GROUP BY driver_id
       ) AS done
 WHERE u.id = done.driver_id
   AND u.completed_trips <> done.total;

COMMIT;


-- =============================================================================
-- Checks
-- =============================================================================
--   \d booking_ratings
--
--   SELECT id, first_name, rating_average, rating_count, completed_trips
--     FROM users WHERE role = 'driver' ORDER BY id;
--
--   -- the UNIQUE must stop a second operator rating on the same booking:
--   INSERT INTO booking_ratings (booking_id, rater_id, rater_role, subject_id, score)
--   VALUES (1, 8, 'operator', 7, 5);
--   INSERT INTO booking_ratings (booking_id, rater_id, rater_role, subject_id, score)
--   VALUES (1, 8, 'operator', 7, 4);   -- must fail
--
--   -- and the CHECK must stop a six-star rating:
--   INSERT INTO booking_ratings (booking_id, rater_id, rater_role, subject_id, score)
--   VALUES (1, 7, 'driver', 8, 6);     -- must fail
