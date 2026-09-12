-- =============================================================================
-- MoveApp — 006: CEO's document changes
-- =============================================================================
--   NIC              -> NI
--   valid_mot        -> mot_licence
--   pco_paper_part   -> private_hire_paper_part
--   NEW optional     : passport_copy (driver), rental_agreement (vehicle)
--   luggage          -> luggage_large + luggage_small
--   internal/external driver type: no longer used
--
-- Existing uploads keep their files — only the type names change.
-- Safe to run more than once.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- driver_documents
-- ---------------------------------------------------------------------------

ALTER TABLE driver_documents DROP CONSTRAINT IF EXISTS driver_documents_document_type_check;

UPDATE driver_documents SET document_type = 'ni_front' WHERE document_type = 'nic_front';
UPDATE driver_documents SET document_type = 'ni_back'  WHERE document_type = 'nic_back';
UPDATE driver_documents SET document_type = 'private_hire_paper_part'
    WHERE document_type = 'pco_paper_part';

ALTER TABLE driver_documents ADD CONSTRAINT driver_documents_document_type_check
    CHECK (document_type IN (
        -- required
        'ni_front', 'ni_back',
        'pco_licence_front', 'pco_licence_back',
        'driving_licence_front', 'driving_licence_back',
        'passport_photo',
        'selfie_front', 'selfie_left', 'selfie_right',
        -- optional
        'passport_copy',
        'private_hire_paper_part'
    ));

-- ---------------------------------------------------------------------------
-- vehicle_documents
-- ---------------------------------------------------------------------------

ALTER TABLE vehicle_documents DROP CONSTRAINT IF EXISTS vehicle_documents_document_type_check;

UPDATE vehicle_documents SET document_type = 'mot_licence' WHERE document_type = 'valid_mot';

ALTER TABLE vehicle_documents ADD CONSTRAINT vehicle_documents_document_type_check
    CHECK (document_type IN (
        -- required
        'pco_vehicle_paper', 'v5_logbook', 'mot_road_tax', 'car_insurance', 'mot_licence',
        'photo_front', 'photo_back', 'photo_interior',
        -- optional
        'rental_agreement'
    ));

-- ---------------------------------------------------------------------------
-- vehicles: luggage split into large and small bags
-- ---------------------------------------------------------------------------

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS luggage_large SMALLINT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS luggage_small SMALLINT;

-- The old single number was always the large-bag count in practice
UPDATE vehicles SET luggage_large = luggage
    WHERE luggage_large IS NULL AND luggage IS NOT NULL;

-- ---------------------------------------------------------------------------
-- driver_type is no longer part of the product
-- ---------------------------------------------------------------------------
-- The columns are left in place rather than dropped, so nothing is lost if the
-- decision is revisited. Nothing reads them any more. To remove them for good:
--
--   ALTER TABLE users DROP COLUMN driver_type;
--   ALTER TABLE users DROP COLUMN driver_type_confirmed;

COMMIT;


-- Check it worked:
-- SELECT document_type, COUNT(*) FROM driver_documents GROUP BY 1 ORDER BY 1;
-- SELECT document_type, COUNT(*) FROM vehicle_documents GROUP BY 1 ORDER BY 1;