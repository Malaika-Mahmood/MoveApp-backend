-- =============================================================================
-- MoveApp — 013: bookings, offers and the company roster
-- =============================================================================
-- The job itself. A booking arrives by phone or website, an operator types it
-- in, and it reaches a driver one of two ways:
--
--   1. The operator offers it to one named driver, who accepts or declines.
--   2. The operator publishes it, and any driver who is online can claim it.
--
-- Both are real. The first is how a chauffeur firm actually works — a regular
-- client gets the driver they know. The second is what fills the gaps.
--
-- What this migration deliberately does NOT add: fare, surge, payment method,
-- earnings, driver location. Those are decided later; the columns are reserved
-- here so adding them is an ALTER and not a redesign.
--
-- Safe to run more than once.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Vehicle classes
-- ---------------------------------------------------------------------------
-- A booking asks for a KIND of car, never a particular one. "Executive, 4
-- passengers, 3 bags" — and any driver whose car is that class can take it.
--
-- This is also what keeps the app universal: a company Mercedes and an outside
-- driver's Mercedes are the same thing to a booking. Nothing matches on who
-- owns the car.
--
-- vehicles.vehicle_class already exists and holds the code, so nothing about
-- the existing table changes. This is the list of what those codes mean.
CREATE TABLE IF NOT EXISTS vehicle_classes (
    id              SERIAL PRIMARY KEY,

    -- What vehicles.vehicle_class holds
    code            VARCHAR(50) NOT NULL UNIQUE,

    -- What the operator and driver see
    name            VARCHAR(80) NOT NULL,
    description     VARCHAR(200),

    max_passengers  SMALLINT NOT NULL DEFAULT 4,
    max_large_bags  SMALLINT NOT NULL DEFAULT 3,
    max_small_bags  SMALLINT NOT NULL DEFAULT 2,

    -- "Leather · WiFi", shown under the name on the selection screen
    features        VARCHAR(200),

    -- The order they appear in. Cheapest first, so the recommended one is
    -- usually the first that fits.
    sort_order      SMALLINT NOT NULL DEFAULT 100,

    is_active       BOOLEAN NOT NULL DEFAULT TRUE,

    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Three to start with, matching the designer's screens. An admin can add more
-- later; these are seeded so the module works the moment it is deployed.
--
-- ON CONFLICT DO NOTHING, not an UPDATE: if Eurocars has already corrected the
-- passenger count on one of these, re-running the migration must not undo it.
INSERT INTO vehicle_classes
    (code, name, description, max_passengers, max_large_bags, max_small_bags, features, sort_order)
VALUES
    ('saloon',    'Mercedes E-Class', 'Recommended for 2 pax + 3 bags', 4, 3, 2, 'Leather · WiFi', 10),
    ('executive', 'Mercedes S-Class', 'Upgrade option',                 4, 3, 2, 'Premium Leather · First Class', 20),
    ('mpv',       'Mercedes V-Class', 'For larger groups',              7, 6, 4, 'Spacious Cabin · Conference Seating', 30)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- The company roster
-- ---------------------------------------------------------------------------
-- Company VEHICLES need nothing new — vehicles.owner_type already says
-- 'driver' or 'company'.
--
-- Company DRIVERS do, and this is where the rule about the universal app
-- lives. The marker is NOT on the driver's own record:
--
--   - The driver never sees it, in their profile or anywhere else.
--   - A share-code lookup never reveals it.
--   - A driver who leaves keeps their account exactly as it was; they simply
--     stop being on the roster.
--
-- The operator, on the other hand, sees it plainly — the Fleet and External
-- tabs on the assignment screen are built from this. Nothing is hidden from
-- the operator. The rule was only ever about the driver.
CREATE TABLE IF NOT EXISTS company_drivers (
    id              SERIAL PRIMARY KEY,

    driver_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    added_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
    added_at        TIMESTAMP NOT NULL DEFAULT NOW(),

    -- Set instead of deleting the row, so "was on the fleet last March" is
    -- still answerable. A booking from back then should still make sense.
    removed_at      TIMESTAMP,
    removed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,

    notes           VARCHAR(255)
);

-- One live roster entry per driver. Partial, so a driver who left and rejoined
-- has one current row and any number of historical ones.
CREATE UNIQUE INDEX IF NOT EXISTS company_drivers_current
    ON company_drivers (driver_id)
    WHERE removed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------

-- BK-1046. Shown on every screen and read out on the phone, so it is a
-- sequence rather than the primary key — nobody should be able to tell how
-- many bookings the company has taken from the number on their confirmation.
CREATE SEQUENCE IF NOT EXISTS booking_reference_seq START WITH 1001;

CREATE TABLE IF NOT EXISTS bookings (
    id                      SERIAL PRIMARY KEY,

    reference               VARCHAR(20) NOT NULL UNIQUE
                            DEFAULT ('BK-' || nextval('booking_reference_seq')),

    created_by_operator_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

    -- asap        — now, nearest available driver
    -- as_directed — booked by the hour
    -- drop_off    — scheduled point to point
    booking_type            VARCHAR(20) NOT NULL DEFAULT 'drop_off',

    -- pending | offered | accepted | en_route | arrived | in_progress
    -- | completed | cancelled
    --
    -- No CHECK, same reasoning as notifications.type: this list will grow (a
    -- no-show status is already foreseeable) and that should be a code change,
    -- not a migration. The service validates every transition.
    status                  VARCHAR(20) NOT NULL DEFAULT 'pending',

    -- ---- The client ----
    -- Not a user. There is no passenger app; these are people the operator
    -- types in, reached only by SMS and email.
    client_name             VARCHAR(120) NOT NULL,
    client_phone            VARCHAR(20)  NOT NULL,   -- E.164, e.g. +447123456789
    client_email            VARCHAR(255),            -- optional on the form

    -- ---- The journey ----
    pickup_address          VARCHAR(255) NOT NULL,
    pickup_postcode         VARCHAR(12),
    dropoff_address         VARCHAR(255),
    dropoff_postcode        VARCHAR(12),
    via_address             VARCHAR(255),

    -- Null for ASAP. That is the difference between the two: an ASAP booking
    -- has no appointed time, it is simply now.
    scheduled_at            TIMESTAMP,

    -- Hours booked, for as_directed
    duration_hours          NUMERIC(4,1),

    flight_number           VARCHAR(20),

    -- ---- What is needed ----
    passengers              SMALLINT NOT NULL DEFAULT 1,
    large_bags              SMALLINT NOT NULL DEFAULT 0,
    small_bags              SMALLINT NOT NULL DEFAULT 0,
    child_seat              BOOLEAN NOT NULL DEFAULT FALSE,
    wheelchair_accessible   BOOLEAN NOT NULL DEFAULT FALSE,
    special_instructions    TEXT,

    vehicle_class_id        INTEGER REFERENCES vehicle_classes(id) ON DELETE SET NULL,

    -- ---- Who is driving ----
    -- Both stay NULL until a driver accepts. The vehicle is recorded as well
    -- as the driver because a driver may have more than one car, and the
    -- client is told a registration number.
    driver_id               INTEGER REFERENCES users(id) ON DELETE SET NULL,
    vehicle_id              INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,

    -- TRUE once published to the open pool. An offer to one named driver
    -- leaves this FALSE.
    is_open_to_all          BOOLEAN NOT NULL DEFAULT FALSE,
    published_at            TIMESTAMP,

    -- ---- Every step, timed ----
    -- Separate columns rather than one status_changed_at, because the gaps
    -- between them are the answers to real questions: arrived_at to pob_at is
    -- waiting time, pob_at to completed_at is the journey. Both become money
    -- later, and neither can be recovered if it was never written down.
    accepted_at             TIMESTAMP,
    en_route_at             TIMESTAMP,
    arrived_at              TIMESTAMP,
    pob_at                  TIMESTAMP,   -- passenger on board
    completed_at            TIMESTAMP,

    cancelled_at            TIMESTAMP,
    cancelled_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
    cancellation_reason     VARCHAR(255),

    -- ---- Reserved ----
    -- Fare and payment are a later decision. The columns exist now so that
    -- adding them does not mean rewriting every query that selects a booking.
    -- They stay NULL until then.
    fare_total              NUMERIC(10,2),
    fare_currency           CHAR(3) DEFAULT 'GBP',
    payment_method          VARCHAR(20),

    created_at              TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMP NOT NULL DEFAULT NOW()
);

-- The operator's list, which is nearly always filtered by status and ordered
-- by when the job is.
CREATE INDEX IF NOT EXISTS bookings_status_scheduled
    ON bookings (status, scheduled_at);

-- "My jobs" for a driver
CREATE INDEX IF NOT EXISTS bookings_driver
    ON bookings (driver_id, scheduled_at DESC)
    WHERE driver_id IS NOT NULL;

-- The open pool the driver's "Available Jobs" tab reads. Partial, because it
-- is a small slice of a table that will grow without limit.
CREATE INDEX IF NOT EXISTS bookings_open_pool
    ON bookings (scheduled_at)
    WHERE is_open_to_all AND status = 'pending';

CREATE INDEX IF NOT EXISTS bookings_operator
    ON bookings (created_by_operator_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Offers
-- ---------------------------------------------------------------------------
-- One row per "this job was put to this driver". Also the audit trail.
--
-- On the phone none of this survives: an operator rings four drivers and the
-- only record is their memory. Here it is possible to ask later which drivers
-- turn down half of what they are sent, and which never answer at all.
CREATE TABLE IF NOT EXISTS booking_offers (
    id                      SERIAL PRIMARY KEY,

    booking_id              INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    driver_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    offered_by_operator_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,

    -- pending | accepted | declined | expired | withdrawn
    status                  VARCHAR(20) NOT NULL DEFAULT 'pending',

    offered_at              TIMESTAMP NOT NULL DEFAULT NOW(),
    responded_at            TIMESTAMP,

    -- Set on ASAP offers only — three minutes, because the client is already
    -- standing there. A scheduled job has no deadline and the operator
    -- withdraws it by hand.
    expires_at              TIMESTAMP,

    decline_reason          VARCHAR(255)
);

-- "Does this driver have an offer waiting?" — asked on every load of the
-- driver's home screen.
CREATE INDEX IF NOT EXISTS booking_offers_driver_pending
    ON booking_offers (driver_id, status, offered_at DESC);

CREATE INDEX IF NOT EXISTS booking_offers_booking
    ON booking_offers (booking_id, offered_at DESC);

-- The sweep that expires ASAP offers nobody answered.
CREATE INDEX IF NOT EXISTS booking_offers_expiring
    ON booking_offers (expires_at)
    WHERE status = 'pending' AND expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Driver availability
-- ---------------------------------------------------------------------------
-- The Go Online / Offline switch on the driver's home screen, and the
-- AVAILABLE badge the operator sees on the assignment screen. The same fact,
-- read from both ends.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_online BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_online_at TIMESTAMP;

-- Who can be offered a job right now
CREATE INDEX IF NOT EXISTS users_online_drivers
    ON users (is_online, status)
    WHERE role = 'driver';

-- ---------------------------------------------------------------------------
-- Notification categories
-- ---------------------------------------------------------------------------
-- The driver's Inbox has tabs: All / Jobs / Payments / System. Without this
-- the app would have to keep its own list of which type belongs to which tab,
-- and that list would fall out of date the first time a type is added here.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS category VARCHAR(20);

UPDATE notifications SET category = 'system' WHERE category IS NULL;

CREATE INDEX IF NOT EXISTS notifications_user_category
    ON notifications (user_id, category, created_at DESC);

COMMIT;


-- =============================================================================
-- Checks
-- =============================================================================
-- Three classes seeded, and a reference that looks right:
--
--   SELECT code, name, max_passengers, max_large_bags FROM vehicle_classes
--   ORDER BY sort_order;
--
--   SELECT nextval('booking_reference_seq');   -- 1001, 1002, ...
--
-- Company vehicles need nothing new — they are already there:
--
--   SELECT registration_number, vehicle_class, owner_type FROM vehicles;
--
-- Put a driver on the roster:
--
--   INSERT INTO company_drivers (driver_id, added_by) VALUES (7, 1);
--
-- And confirm a driver can only be on it once:
--
--   INSERT INTO company_drivers (driver_id, added_by) VALUES (7, 1);
--   -- must fail with company_drivers_current