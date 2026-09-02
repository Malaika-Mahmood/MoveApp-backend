-- =============================================================================
-- MoveApp — Step 3: document storage
-- =============================================================================
-- Adds storage metadata, supersede-on-re-upload, and the optional PCO paper part.
-- Safe to run more than once.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- driver_documents
-- ---------------------------------------------------------------------------

-- storage_key is how the file is found in whatever storage is in use. Today
-- that is a path under uploads/; after the move to Cloudinary or S3 it becomes
-- their object id. file_url is kept for the API response only.
ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS storage_key VARCHAR(500);
ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS file_size   INTEGER;

-- Where the file came from, for audit
ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS source VARCHAR(20);
DO $$
BEGIN
    ALTER TABLE driver_documents ADD CONSTRAINT driver_documents_source_check
        CHECK (source IN ('scan', 'gallery', 'pdf'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Re-uploading replaces rather than piles up: the old row stays for history
-- with is_current = FALSE, and only the current one counts towards completion.
ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT TRUE;

-- Set in Step 6 by the operator when approving (insurance, MOT, licences expire)
ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS expires_at DATE;

-- The optional PCO paper part ("Skip now" on the app)
DO $$
BEGIN
    ALTER TABLE driver_documents DROP CONSTRAINT IF EXISTS driver_documents_document_type_check;
    ALTER TABLE driver_documents ADD CONSTRAINT driver_documents_document_type_check
        CHECK (document_type IN (
            'nic_front', 'nic_back',
            'pco_licence_front', 'pco_licence_back',
            'driving_licence_front', 'driving_licence_back',
            'passport_photo',
            'selfie_front', 'selfie_left', 'selfie_right',
            'pco_paper_part'
        ));
END $$;

-- Older rows predate is_current; keep only the newest of each type as current.
UPDATE driver_documents d
SET is_current = FALSE
WHERE EXISTS (
    SELECT 1 FROM driver_documents newer
    WHERE newer.user_id = d.user_id
      AND newer.document_type = d.document_type
      AND newer.uploaded_at > d.uploaded_at
);

-- One current document per type, enforced by the database rather than by hope.
CREATE UNIQUE INDEX IF NOT EXISTS driver_documents_current_unique
    ON driver_documents (user_id, document_type) WHERE is_current;


-- ---------------------------------------------------------------------------
-- vehicle_documents — same treatment
-- ---------------------------------------------------------------------------

ALTER TABLE vehicle_documents ADD COLUMN IF NOT EXISTS storage_key VARCHAR(500);
ALTER TABLE vehicle_documents ADD COLUMN IF NOT EXISTS file_size   INTEGER;
ALTER TABLE vehicle_documents ADD COLUMN IF NOT EXISTS source      VARCHAR(20);

DO $$
BEGIN
    ALTER TABLE vehicle_documents ADD CONSTRAINT vehicle_documents_source_check
        CHECK (source IN ('scan', 'gallery', 'pdf'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE vehicle_documents ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE vehicle_documents ADD COLUMN IF NOT EXISTS expires_at DATE;

UPDATE vehicle_documents d
SET is_current = FALSE
WHERE EXISTS (
    SELECT 1 FROM vehicle_documents newer
    WHERE newer.vehicle_id = d.vehicle_id
      AND newer.document_type = d.document_type
      AND newer.uploaded_at > d.uploaded_at
);

CREATE UNIQUE INDEX IF NOT EXISTS vehicle_documents_current_unique
    ON vehicle_documents (vehicle_id, document_type) WHERE is_current;

COMMIT;