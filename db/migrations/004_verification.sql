-- =============================================================================
-- MoveApp — Step 4: verification data
-- =============================================================================
-- Adds date of birth, the vehicle's PCO licence number, and the indexes the
-- expiry checks will need. Safe to run more than once.
-- =============================================================================

BEGIN;

-- Shown on the operator's summary sheet, and needed for licensing checks
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE;

-- These should already exist from the initial schema. Adding them defensively
-- costs nothing and means this migration cannot fail on a database that was
-- built by hand rather than from 000_initial_schema.sql.
ALTER TABLE users ADD COLUMN IF NOT EXISTS driving_licence_number VARCHAR(30);
ALTER TABLE users ADD COLUMN IF NOT EXISTS pco_licence_number     VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS address                VARCHAR(255);

-- The vehicle's own PCO licence number (e.g. 467485).
-- The driver's licence numbers already live on `users`.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS pco_licence_number VARCHAR(20);

-- Expiry lookups: "which documents expire in the next 30 days?"
CREATE INDEX IF NOT EXISTS driver_documents_expiry_idx
    ON driver_documents (expires_at) WHERE is_current AND expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS vehicle_documents_expiry_idx
    ON vehicle_documents (expires_at) WHERE is_current AND expires_at IS NOT NULL;

COMMIT;