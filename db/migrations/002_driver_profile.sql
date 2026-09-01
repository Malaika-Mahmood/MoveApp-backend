-- =============================================================================
-- MoveApp — Step 2: driver profile fields
-- =============================================================================
-- Adds: title, ni_number (renamed from nic_number), postcode, driver_type.
--
-- Safe to run more than once — every statement checks first.
-- Run in Neon SQL Editor.
-- =============================================================================

BEGIN;

-- Title: Mr / Mrs / Ms only (no Dr).
-- Nullable in the database because existing rows have no title yet; the API
-- requires it when the driver submits their personal information.
ALTER TABLE users ADD COLUMN IF NOT EXISTS title VARCHAR(5);

DO $$
BEGIN
    ALTER TABLE users ADD CONSTRAINT users_title_check
        CHECK (title IN ('Mr', 'Mrs', 'Ms'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;


-- nic_number was a misleading name: this is a UK National Insurance number,
-- not a National Identity Card. Rename it while the table is still small.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'users' AND column_name = 'nic_number')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'users' AND column_name = 'ni_number')
    THEN
        ALTER TABLE users RENAME COLUMN nic_number TO ni_number;
    END IF;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS ni_number VARCHAR(20);


-- Postcode is what the driver types. `address` stays optional — insurance and
-- PHV licensing usually need the full address eventually, and adding the column
-- later, once there are hundreds of drivers, is much harder than adding it now.
ALTER TABLE users ADD COLUMN IF NOT EXISTS postcode VARCHAR(10);


-- internal  = drives for the company
-- external  = independent driver
--
-- Both upload their own documents, so this does not change what is required.
-- The driver chooses it; the operator confirms it during verification, which is
-- why the confirmation is stored separately from the claim.
ALTER TABLE users ADD COLUMN IF NOT EXISTS driver_type VARCHAR(20);

DO $$
BEGIN
    ALTER TABLE users ADD CONSTRAINT users_driver_type_check
        CHECK (driver_type IN ('internal', 'external'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS driver_type_confirmed BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;


-- Check it worked:
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_name = 'users'
-- ORDER BY ordinal_position;