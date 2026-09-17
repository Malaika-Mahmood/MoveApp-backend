-- =============================================================================
-- MoveApp — 017: admin access log
-- =============================================================================
-- The CEO's decision on 16 September was that an admin sees everything: every
-- driver and operator record, every booking, and who created it.
--
-- Everything includes the contact details that are masked from operators. That
-- is correct — somebody has to be able to ring a driver when a client is
-- standing on a pavement at midnight — but "somebody can see everything" is
-- only safe when it comes with "and it is written down who looked".
--
-- Without this table the answer to "who pulled that driver's phone number in
-- March?" is nobody knows. With it, the answer is a row. That is the whole
-- feature: it is not a permission, it is a record.
--
-- Deliberately NOT a full audit of every request. Logging every list page an
-- admin scrolls would bury the one line that matters under thousands that do
-- not. Only the screens that reveal an individual's details are recorded.
--
-- Safe to run more than once.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS admin_views (
    id            SERIAL PRIMARY KEY,

    admin_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- What was opened: 'driver', 'operator' or 'booking'.
    --
    -- No foreign key on subject_id, on purpose. A driver who is deleted later
    -- must not take the record of who looked at them with them — that is
    -- exactly the record somebody would want to destroy.
    subject_type  VARCHAR(20) NOT NULL,
    subject_id    INTEGER NOT NULL,

    -- TRUE when the response actually contained a phone number or email. A
    -- summary screen and a full record are different things to have looked at,
    -- and the difference matters if this is ever read in anger.
    saw_contact   BOOLEAN NOT NULL DEFAULT FALSE,

    viewed_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

-- "Who has looked at this driver?" — read subject-first, because that is the
-- question somebody asks.
CREATE INDEX IF NOT EXISTS admin_views_by_subject
    ON admin_views (subject_type, subject_id, viewed_at DESC);

-- "What did this admin look at last week?" — the other direction, asked when
-- somebody is being investigated rather than protected.
CREATE INDEX IF NOT EXISTS admin_views_by_admin
    ON admin_views (admin_id, viewed_at DESC);

COMMIT;


-- =============================================================================
-- Checks
-- =============================================================================
--   \d admin_views
--
--   -- after opening a driver's record as an admin:
--   SELECT v.id, u.first_name AS admin, v.subject_type, v.subject_id,
--          v.saw_contact, v.viewed_at
--     FROM admin_views v
--     JOIN users u ON u.id = v.admin_id
--    ORDER BY v.viewed_at DESC
--    LIMIT 10;