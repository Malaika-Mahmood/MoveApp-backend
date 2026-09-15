-- =============================================================================
-- MoveApp — 014: favourite drivers
-- =============================================================================
-- The star beside each driver on the assignment screen, and the Favourites tab
-- next to All, Fleet and External.
--
-- Deliberately NOT derived from ratings. The earlier idea was that a driver who
-- reaches five stars becomes a favourite automatically; the decision on 14
-- September was that the operator stars them by hand. The two are different
-- things: a rating is an opinion about a job that happened, a favourite is a
-- decision about who to call next time. A driver can be excellent and still not
-- be who you want for a particular client.
--
-- Per operator, not per company. The operator who works the airport runs knows
-- a different set of drivers from the one who does the corporate accounts, and
-- one of them starring somebody should not fill the other one's list.
--
-- Its own migration rather than part of 013 because 013 has already been run.
--
-- Safe to run more than once.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS operator_favourite_drivers (
    operator_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    driver_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    starred_at   TIMESTAMP NOT NULL DEFAULT NOW(),

    -- "Knows the Heathrow run", "client asks for him". The operator's own note
    -- to themselves; the driver never sees it.
    note         VARCHAR(255),

    PRIMARY KEY (operator_id, driver_id)
);

-- "Show me my favourites" — the tab.
CREATE INDEX IF NOT EXISTS operator_favourites_by_operator
    ON operator_favourite_drivers (operator_id, starred_at DESC);

COMMIT;


-- =============================================================================
-- Checks
-- =============================================================================
--   INSERT INTO operator_favourite_drivers (operator_id, driver_id) VALUES (8, 7);
--   INSERT INTO operator_favourite_drivers (operator_id, driver_id) VALUES (8, 7);
--   -- the second must fail on the primary key
--
--   SELECT * FROM operator_favourite_drivers;