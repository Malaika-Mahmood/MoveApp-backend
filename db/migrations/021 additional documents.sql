-- =============================================================================
-- MoveApp — 021: the "choose any 2" additional driver documents
-- =============================================================================
-- From the driver document screens, 25 September 2026.
--
-- Sign-up now has two document steps. Step 1 is the fixed list every driver
-- must produce. Step 2 is new: nine documents, of which the driver picks any
-- TWO. Address proof or ID proof, either, both — the rule is a count, not a
-- category.
--
-- Nothing here enforces the count. A CHECK constraint can see one row; "two of
-- these nine, approved" is a question about the whole set, and it belongs where
-- every other rule of that shape already lives — recomputeDriverStatus. All
-- this migration does is let the rows exist.
--
-- ---------------------------------------------------------------------------
-- Two entries that look like duplicates and are not
-- ---------------------------------------------------------------------------
--   id_photocard_licence    the plastic card
--   driving_licence_front   the paper counterpart, already required
--
-- Same licence, two physical documents. The screens ask for both on purpose.
--
-- The passport appears ONCE, as the optional passport_copy on step 1. It was
-- removed from the ID proof list rather than being carried in both places.
--
-- ---------------------------------------------------------------------------
-- Issue dates
-- ---------------------------------------------------------------------------
-- The screens say "issued within the last 3 months" for most of these and 12
-- for council tax and HMRC. No column is added for it: the operator reads the
-- date off the document while approving, which is the decision taken. Should
-- that ever need enforcing it wants an `issued_on` date, NOT the existing
-- expires_at — one is when a document starts being true and the other is when
-- it stops, and storing one in the other's column would be a lie the next
-- feature is built on.
--
-- Safe to run more than once.
-- =============================================================================

BEGIN;

ALTER TABLE driver_documents DROP CONSTRAINT IF EXISTS driver_documents_document_type_check;

ALTER TABLE driver_documents ADD CONSTRAINT driver_documents_document_type_check
    CHECK (document_type IN (
        -- required (step 1)
        'pco_licence_front', 'pco_licence_back',
        'driving_licence_front', 'driving_licence_back',
        'passport_photo',
        'selfie',

        -- optional (step 1) — never blocks verification
        'passport_copy',
        'private_hire_paper_part',

        -- additional (step 2) — any two of these, approved
        'addr_bank_building_society',
        'addr_utility_bill',
        'addr_credit_card_bill',
        'addr_bank_statement',
        'addr_council_tax',
        'addr_mortgage_statement',
        'addr_hmrc_document',
        'id_photocard_licence',
        'id_uk_eea_national_id',

        -- retired, kept so old rows still satisfy the constraint.
        -- Nothing writes these any more:
        --   ni_front / ni_back      replaced by the typed NI number
        --   selfie_front/left/right replaced by the single live selfie
        'ni_front', 'ni_back',
        'selfie_front', 'selfie_left', 'selfie_right'
    ));

COMMIT;


-- =============================================================================
-- Checks
-- =============================================================================
-- Nothing that exists today can fail this constraint — every old type is still
-- listed. Confirm:
--
--   SELECT document_type, COUNT(*)
--     FROM driver_documents
--    GROUP BY document_type
--    ORDER BY document_type;
--
-- And that the new ones are now accepted:
--
--   INSERT INTO driver_documents (user_id, document_type, storage_key, status)
--   VALUES (7, 'addr_utility_bill', 'test', 'pending_review');
--   -- should succeed; delete it afterwards
--
--   INSERT INTO driver_documents (user_id, document_type, storage_key, status)
--   VALUES (7, 'not_a_real_type', 'test', 'pending_review');
--   -- must fail