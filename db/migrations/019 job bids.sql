-- =============================================================================
-- MoveApp — 019: fixed fare, bidding, and the operator's final say
-- =============================================================================
-- From the operator interview on 21 September, and the designer's screens.
--
-- Two ways a job gets its price:
--
--   FIXED    the operator names one amount. Take it or leave it.
--   BIDDING  the operator names a range — £85 to £110 — and drivers say what
--            they will do it for.
--
-- And one rule that runs through both, which is the real change here:
--
--   A DRIVER SAYING YES DOES NOT WIN THE JOB. The operator chooses.
--
-- Part A built the open pool as first-to-claim: whoever tapped fastest got the
-- booking and the operator found out afterwards. The operator says that is not
-- how the office works. They look at who put their hand up, and they decide —
-- because the fastest tap is not always the right driver for that client.
--
-- ---------------------------------------------------------------------------
-- Why the money columns are named the way they are
-- ---------------------------------------------------------------------------
-- They are not called driver_earning, and they are not called client_fare.
--
-- It is not yet settled whose money this is: the operator described it as the
-- driver's earning, while the designer's screens show a payment method and a
-- total, which are client-side things. That question is open, and the CEO has
-- the payments brief coming separately.
--
-- So these columns say only what is true today — "the amount agreed for this
-- job". If they were named for a guess and the guess turned out wrong, the
-- name would go on lying long after everybody had forgotten, and every later
-- feature would be built on top of the lie.
--
-- Commission, additional charges, payment method and totals are deliberately
-- NOT here. They come with the payments work.
--
-- Currency: bookings already carries fare_currency, default GBP. Everything in
-- this migration is in that same currency; a second currency column would be
-- one more thing to keep in step for no gain.
--
-- Safe to run more than once.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- How this booking is priced
-- -----------------------------------------------------------------------------
-- 'fixed' is the default so that every booking already in the table keeps
-- behaving exactly as it does now. Nothing live changes when this runs.
--
-- No CHECK constraint, for the same reason as booking status: the list will
-- grow, and growing it should be a code change rather than a migration.
ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS fare_mode VARCHAR(10) NOT NULL DEFAULT 'fixed';

COMMENT ON COLUMN bookings.fare_mode IS
    'fixed = the operator names one amount. bidding = drivers offer within a range.';

-- The one amount, when fare_mode is 'fixed'. Nullable: the operator interview
-- was clear that jobs are sometimes handed out with no amount at all.
ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS fixed_amount NUMERIC(10,2);

-- The window, when fare_mode is 'bidding'. Both or neither.
ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS bid_low  NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS bid_high NUMERIC(10,2);

-- A range whose low is above its high is not a range. This one IS worth a
-- constraint — unlike a list of statuses, the relationship between these two
-- numbers can never legitimately change.
DO $$
BEGIN
    ALTER TABLE bookings
        ADD CONSTRAINT bookings_bid_range_sane
        CHECK (bid_low IS NULL OR bid_high IS NULL OR bid_low <= bid_high);
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- What was settled on, once a driver has the job.
--
-- Copied from the winning bid rather than read back through it, because the
-- bid can be looked at later and this must not change if anybody edits that
-- row. This is the number the job was done for.
ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS agreed_amount NUMERIC(10,2);

COMMENT ON COLUMN bookings.agreed_amount IS
    'The amount this job was agreed at. Copied from the accepted bid, or from fixed_amount. Whose money it is has not been decided — see migration 019.';

-- -----------------------------------------------------------------------------
-- Bids live in booking_offers
-- -----------------------------------------------------------------------------
-- Not a new table, on purpose.
--
-- A bid and a direct offer have the same life: a row linking a booking to a
-- driver, that is pending and then becomes something else, that can be
-- withdrawn, that gets notified about. Two tables would mean writing those
-- rules twice, and within a month the two copies would have drifted.
--
-- What differs is who started it and whether money is attached, and that is
-- exactly what these two columns say.
ALTER TABLE booking_offers
    ADD COLUMN IF NOT EXISTS offer_kind VARCHAR(10) NOT NULL DEFAULT 'direct',
    ADD COLUMN IF NOT EXISTS amount     NUMERIC(10,2);

COMMENT ON COLUMN booking_offers.offer_kind IS
    'direct = the operator put this job to one named driver. bid = the driver put their hand up for an open job.';
COMMENT ON COLUMN booking_offers.amount IS
    'What the driver will do it for. NULL on a direct offer, and on a bid for a fixed-fare job where there is nothing to name.';

-- One live bid per driver per booking.
--
-- A driver changing their mind updates their row; they do not get to stack
-- five bids and have the operator wade through them. Enforced here rather than
-- only in the service, because two taps a millisecond apart would both pass a
-- check-then-insert.
--
-- Partial, on 'pending' only: a rejected bid and a fresh one from the same
-- driver are both legitimate, and must be able to sit side by side.
CREATE UNIQUE INDEX IF NOT EXISTS booking_offers_one_live_bid
    ON booking_offers (booking_id, driver_id)
    WHERE offer_kind = 'bid' AND status = 'pending';

-- The operator's bid list: this booking's bids, cheapest first. The screen is
-- headed "LOWEST BID", so that is the order the index serves.
CREATE INDEX IF NOT EXISTS booking_offers_bids_by_amount
    ON booking_offers (booking_id, amount)
    WHERE offer_kind = 'bid';

-- "My bids" on the driver's side.
CREATE INDEX IF NOT EXISTS booking_offers_bids_by_driver
    ON booking_offers (driver_id, offered_at DESC)
    WHERE offer_kind = 'bid';

COMMIT;


-- =============================================================================
-- Checks
-- =============================================================================
--   SELECT id, reference, fare_mode, fixed_amount, bid_low, bid_high,
--          agreed_amount, is_open_to_all, status
--     FROM bookings ORDER BY id;
--
--   -- every existing booking must come back fare_mode = 'fixed' with the
--   -- three amount columns null. Nothing that is live changes.
--
--   SELECT o.id, o.booking_id, o.driver_id, o.offer_kind, o.amount, o.status
--     FROM booking_offers o ORDER BY o.id;
--
--   -- the unique index must refuse a second live bid:
--   INSERT INTO booking_offers (booking_id, driver_id, offer_kind, amount, status)
--   VALUES (2, 7, 'bid', 95.00, 'pending');
--   INSERT INTO booking_offers (booking_id, driver_id, offer_kind, amount, status)
--   VALUES (2, 7, 'bid', 90.00, 'pending');   -- must fail
--
--   -- and the range check must refuse a backwards range:
--   UPDATE bookings SET bid_low = 200, bid_high = 100 WHERE id = 2;  -- must fail