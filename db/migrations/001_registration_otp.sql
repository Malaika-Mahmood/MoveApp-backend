-- MoveApp — Step 1
-- OTP-verified driver registration.
--
-- Run this ONCE, inside a transaction, against your MoveApp database.
--
-- BEFORE RUNNING, check you have no duplicates that would block the new
-- unique indexes:
--
--   SELECT LOWER(email), COUNT(*) FROM users GROUP BY 1 HAVING COUNT(*) > 1;
--   SELECT phone, COUNT(*) FROM users WHERE phone IS NOT NULL
--     GROUP BY 1 HAVING COUNT(*) > 1;
--
-- If either query returns rows, clean them up first.
 
BEGIN;
 
-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
 
-- Auth is passwordless (email OTP / phone OTP / Google), so no password is
-- collected any more. The column is kept for now so nothing breaks; it can be
-- dropped in a later step once every login path is confirmed working.
ALTER TABLE users ALTER COLUMN password DROP NOT NULL;
 
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN   NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN   NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMP NOT NULL DEFAULT NOW();
 
-- Existing accounts predate email verification. They were created before this
-- flow existed, so treat them as verified rather than locking them out.
UPDATE users SET email_verified = TRUE WHERE email IS NOT NULL;
 
-- Case-insensitive email uniqueness. Without this, Raj@x.com and raj@x.com
-- become two separate accounts.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique
    ON users (LOWER(email));
 
-- Phone uniqueness, but only for rows that have one (Google sign-ups do not).
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique
    ON users (phone) WHERE phone IS NOT NULL;
 
-- ---------------------------------------------------------------------------
-- pending_registrations
-- ---------------------------------------------------------------------------
-- Sign-ups waiting on their email OTP. Nothing is written to `users` until the
-- code is verified, so the users table never holds an unverified account.
 
CREATE TABLE IF NOT EXISTS pending_registrations (
    id            SERIAL PRIMARY KEY,
    full_name     VARCHAR(150) NOT NULL,
    email         VARCHAR(255) NOT NULL,
    phone         VARCHAR(30)  NOT NULL,
    role          VARCHAR(20)  NOT NULL DEFAULT 'driver'
                               CHECK (role IN ('driver', 'operator')),
    otp_hash      VARCHAR(64)  NOT NULL,
    expires_at    TIMESTAMP    NOT NULL,
    attempt_count SMALLINT     NOT NULL DEFAULT 0,
    resend_count  SMALLINT     NOT NULL DEFAULT 0,
    last_sent_at  TIMESTAMP    NOT NULL DEFAULT NOW(),
    consumed_at   TIMESTAMP,
    created_at    TIMESTAMP    NOT NULL DEFAULT NOW()
);
 
CREATE INDEX IF NOT EXISTS pending_registrations_lookup
    ON pending_registrations (LOWER(email), consumed_at, created_at DESC);
 
COMMIT;
 
-- ---------------------------------------------------------------------------
-- Seed the first operator account
-- ---------------------------------------------------------------------------
-- Operators are assigned by the company, not created through public sign-up.
-- Edit the values, then run this separately.
--
-- INSERT INTO users (full_name, email, phone, role, status, email_verified)
-- VALUES ('Ops Admin', 'ops@eurocarslondon.co.uk', '07700900001',
--         'operator', 'approved', TRUE);