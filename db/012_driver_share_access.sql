-- =============================================================================
-- MoveApp — 012: driver share code, and operator access by permission
-- =============================================================================
-- A driver carries a permanent ID and a PIN they can change. They give both to
-- any operator who asks. The operator types them in and immediately learns one
-- thing — is this driver verified or not. That is all the driver is trying to
-- prove, and it needs no permission.
--
-- The documents are a separate question. Those the operator only sees if the
-- driver taps Allow, and then only for thirty minutes.
--
-- Two pieces of state:
--
--   users.share_id / share_pin   the code itself
--   driver_access_requests       one row per "someone asked", and the answer
--
-- The second one is also the audit trail. Months later the company can still
-- say who asked to see a driver's passport, and whether the driver agreed.
--
-- Safe to run more than once.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- The code
-- ---------------------------------------------------------------------------

-- Permanent. Printed on the driver's screen, read out over the phone, typed in
-- by an operator. Shaped MV-1A2B-3C4 so it survives being spoken aloud.
ALTER TABLE users ADD COLUMN IF NOT EXISTS share_id VARCHAR(20);

-- Six digits. Stored as written, not hashed — the driver has to be able to
-- read it off their own screen, and a hash cannot be shown back.
--
-- That is a deliberate trade, not an oversight. The PIN is not what protects
-- the documents; the driver's Allow is. The PIN only decides WHICH driver an
-- operator is asking about, and a wrong one is rate limited in the controller
-- so it cannot be guessed a thousand times.
ALTER TABLE users ADD COLUMN IF NOT EXISTS share_pin VARCHAR(6);

-- When the driver last changed it. Shown on their security screen so they can
-- tell at a glance whether the PIN they gave out last month is still the one.
ALTER TABLE users ADD COLUMN IF NOT EXISTS share_pin_updated_at TIMESTAMP;

-- Every existing driver needs one, or the feature only works for people who
-- register after today.
--
-- Hex is used for the letters on purpose: it contains no O and no I, so it can
-- never be confused with 0 or 1 when a driver reads the code down a phone line.
UPDATE users
SET share_id = 'MV-'
        || UPPER(SUBSTR(MD5(RANDOM()::text || id::text), 1, 4)) || '-'
        || UPPER(SUBSTR(MD5(RANDOM()::text || id::text || 'x'), 1, 3)),
    share_pin = LPAD((FLOOR(RANDOM() * 1000000))::int::text, 6, '0'),
    share_pin_updated_at = NOW()
WHERE role = 'driver' AND share_id IS NULL;

-- Two drivers must never share an ID — the whole lookup depends on it.
-- Partial, because operators and admins have no share_id and several NULLs are
-- not a clash.
CREATE UNIQUE INDEX IF NOT EXISTS users_share_id_unique
    ON users (share_id)
    WHERE share_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The requests
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS driver_access_requests (
    id              SERIAL PRIMARY KEY,

    driver_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operator_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- pending | approved | denied | expired
    --
    -- No CHECK constraint, same reasoning as notifications.type: the list will
    -- grow (revoked, say) and that should not need a migration. The service
    -- validates it.
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',

    -- The code as typed. Kept even though driver_id says the same thing,
    -- because if a driver changes their PIN and later disputes an access, this
    -- is the record of what was actually presented.
    share_id_used   VARCHAR(20),

    requested_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    decided_at      TIMESTAMP,

    -- When the thirty minutes run out. Set at the moment of approval, not at
    -- the moment of asking — a driver who answers an hour later should still
    -- get their full half hour.
    expires_at      TIMESTAMP
);

-- "Does this operator have a live grant for this driver right now?" — asked on
-- every single document read, so it must not be a table scan.
CREATE INDEX IF NOT EXISTS driver_access_requests_grant
    ON driver_access_requests (operator_id, driver_id, status, expires_at);

-- The driver's own list of who has asked, newest first.
CREATE INDEX IF NOT EXISTS driver_access_requests_driver
    ON driver_access_requests (driver_id, requested_at DESC);

-- ---------------------------------------------------------------------------
-- Attempts
-- ---------------------------------------------------------------------------
-- Every lookup, including the ones that fail.
--
-- A failed lookup cannot go in the table above — it has no driver_id, because
-- the whole point is that no driver matched. It still has to be written
-- somewhere, for two reasons: it is what the rate limiter counts, and a burst
-- of failures from one operator is worth being able to see afterwards.
CREATE TABLE IF NOT EXISTS share_lookup_attempts (
    id              SERIAL PRIMARY KEY,
    operator_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- What they typed. Kept even when wrong — a series of near misses on one
    -- driver's ID looks very different from a typo.
    share_id_tried  VARCHAR(20),

    succeeded       BOOLEAN NOT NULL DEFAULT FALSE,
    attempted_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

-- "How many times has this operator got it wrong in the last hour?"
CREATE INDEX IF NOT EXISTS share_lookup_attempts_recent
    ON share_lookup_attempts (operator_id, attempted_at DESC);

COMMIT;


-- =============================================================================
-- Checks
-- =============================================================================
-- Every driver should now have a code, and no two the same:
--
--   SELECT id, first_name, share_id, share_pin FROM users WHERE role = 'driver';
--
--   SELECT share_id, COUNT(*) FROM users
--   WHERE share_id IS NOT NULL GROUP BY share_id HAVING COUNT(*) > 1;
--   -- must return no rows
--
-- After an operator looks a driver up and the driver allows it:
--
--   SELECT id, driver_id, operator_id, status, requested_at, decided_at, expires_at
--   FROM driver_access_requests ORDER BY id DESC LIMIT 5;