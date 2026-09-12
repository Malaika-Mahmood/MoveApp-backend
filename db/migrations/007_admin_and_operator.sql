-- =============================================================================
-- MoveApp — 007: Admin role, operator documents, operator councils
-- =============================================================================
--   Admin verifies Operators, the same way Operators verify Drivers.
--   Operators now submit their own business and identity documents, plus one
--   or more council licences.
--
-- Safe to run more than once.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- users: the admin role
-- ---------------------------------------------------------------------------

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('driver', 'operator', 'admin'));

-- The operator's trading name. A person's name is already in first/last_name;
-- this is the business the licence is issued to.
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_name VARCHAR(150);

-- ---------------------------------------------------------------------------
-- operator_documents
-- ---------------------------------------------------------------------------
-- Same shape as driver_documents, so everything already built for documents —
-- supersede on re-upload, magic-byte checks, private file serving, expiry
-- dates — works here unchanged.

CREATE TABLE IF NOT EXISTS operator_documents (
    id               SERIAL PRIMARY KEY,

    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    document_type    VARCHAR(50) NOT NULL CHECK (document_type IN (
                         'operator_licence',
                         'public_liability_insurance',
                         'employers_liability_insurance',
                         'operator_passport',
                         'operator_driving_licence',
                         'proof_of_address'
                     )),

    file_url         VARCHAR(500) NOT NULL,
    storage_key      VARCHAR(500),
    file_format      VARCHAR(50),
    file_size        INTEGER,
    source           VARCHAR(20) CHECK (source IN ('scan', 'gallery', 'pdf')),

    status           VARCHAR(30) NOT NULL DEFAULT 'pending_review'
                                 CHECK (status IN ('pending_review', 'approved', 'rejected')),
    rejection_reason VARCHAR(255),
    expires_at       DATE,

    verified_by      INTEGER REFERENCES users(id),
    verified_at      TIMESTAMP,

    is_current       BOOLEAN NOT NULL DEFAULT TRUE,
    uploaded_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- One current document per type, enforced by the database
CREATE UNIQUE INDEX IF NOT EXISTS operator_documents_current_unique
    ON operator_documents (user_id, document_type) WHERE is_current;

CREATE INDEX IF NOT EXISTS operator_documents_expiry_idx
    ON operator_documents (expires_at) WHERE is_current AND expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- operator_councils
-- ---------------------------------------------------------------------------
-- A UK private hire operator licence is issued by a local council, and one
-- operator may hold licences from several. Each row carries its own licence
-- number, expiry and document, and is approved or rejected on its own.

CREATE TABLE IF NOT EXISTS operator_councils (
    id               SERIAL PRIMARY KEY,

    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    council_name     VARCHAR(150) NOT NULL,
    licence_number   VARCHAR(50)  NOT NULL,
    expires_at       DATE         NOT NULL,

    -- The licence document for this specific council
    file_url         VARCHAR(500),
    storage_key      VARCHAR(500),
    file_format      VARCHAR(50),
    file_size        INTEGER,
    source           VARCHAR(20) CHECK (source IN ('scan', 'gallery', 'pdf')),

    status           VARCHAR(30) NOT NULL DEFAULT 'pending_review'
                                 CHECK (status IN ('pending_review', 'approved', 'rejected')),
    rejection_reason VARCHAR(255),

    verified_by      INTEGER REFERENCES users(id),
    verified_at      TIMESTAMP,

    created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

-- The same council cannot be added twice by one operator
CREATE UNIQUE INDEX IF NOT EXISTS operator_councils_unique
    ON operator_councils (user_id, LOWER(council_name));

CREATE INDEX IF NOT EXISTS operator_councils_expiry_idx
    ON operator_councils (expires_at);

COMMIT;


-- =============================================================================
-- SEED — the first admin
-- =============================================================================
-- Admins can never be created through sign-up. This one is inserted by hand;
-- after that an admin can create the others.
--
-- The phone number matters: admins log in with phone + OTP.
-- Change the values, then run this separately.
--
-- INSERT INTO users (first_name, last_name, email, phone, role, status, email_verified)
-- VALUES ('Malaika', 'Khan', 'admin@eurocarslondon.co.uk', '07700900999',
--         'admin', 'approved', TRUE);