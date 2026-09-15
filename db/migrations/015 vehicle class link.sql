-- =============================================================================
-- MoveApp — 015: link vehicles to a vehicle class properly
-- =============================================================================
-- vehicles.vehicle_class has always been free text — whatever the driver typed
-- when they added the car. One wrote "Executive Saloon", the seeded class list
-- says "saloon", and matching one against the other by string comparison finds
-- nothing.
--
-- That was never going to hold. "E-Class", "e class", "Executive Saloon" and
-- "saloon" are one car to a human and four different values to Postgres, and a
-- booking that quietly matches no drivers is the worst kind of failure: nothing
-- errors, the list is simply empty and nobody knows why.
--
-- So a vehicle now points at a class by id. The old text column is left alone —
-- it is what the driver typed, it may be more specific than the class, and
-- throwing it away would lose information for no gain.
--
-- Anything the backfill cannot place is left NULL and listed at the bottom for
-- somebody to set by hand. Guessing would be worse than asking: put a car in
-- the wrong class and it gets offered work it cannot do.
--
-- Safe to run more than once.
-- =============================================================================

BEGIN;

ALTER TABLE vehicles
    ADD COLUMN IF NOT EXISTS vehicle_class_id INTEGER
    REFERENCES vehicle_classes(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
-- Matched case-insensitively and ignoring spaces and punctuation, against both
-- the class code and its name. "E-Class", "e class" and "eclass" all reduce to
-- the same thing.
--
-- Only rows that have not been set already — re-running this must not undo a
-- correction somebody made by hand.
UPDATE vehicles v
SET vehicle_class_id = vc.id
FROM vehicle_classes vc
WHERE v.vehicle_class_id IS NULL
  AND v.vehicle_class IS NOT NULL
  AND (
        REGEXP_REPLACE(LOWER(v.vehicle_class), '[^a-z0-9]', '', 'g')
      = REGEXP_REPLACE(LOWER(vc.code),         '[^a-z0-9]', '', 'g')
     OR REGEXP_REPLACE(LOWER(v.vehicle_class), '[^a-z0-9]', '', 'g')
      = REGEXP_REPLACE(LOWER(vc.name),         '[^a-z0-9]', '', 'g')
  );

-- The obvious aliases. Deliberately a short list of things that are certain
-- rather than a clever guess at everything:
--
--   "Executive Saloon" is the trade's name for an E-Class — a saloon, driven
--   by a chauffeur. It is NOT the S-Class, which is the upgrade.
--
-- Add to this list rather than widening the matching above; a rule that is
-- nearly right will put somebody's car in the wrong class silently.
UPDATE vehicles v
SET vehicle_class_id = (SELECT id FROM vehicle_classes WHERE code = 'saloon')
WHERE v.vehicle_class_id IS NULL
  AND REGEXP_REPLACE(LOWER(v.vehicle_class), '[^a-z0-9]', '', 'g')
      IN ('executivesaloon', 'eclass', 'mercedeseclass', 'businesssaloon');

UPDATE vehicles v
SET vehicle_class_id = (SELECT id FROM vehicle_classes WHERE code = 'executive')
WHERE v.vehicle_class_id IS NULL
  AND REGEXP_REPLACE(LOWER(v.vehicle_class), '[^a-z0-9]', '', 'g')
      IN ('sclass', 'mercedessclass', 'firstclass', 'luxury');

UPDATE vehicles v
SET vehicle_class_id = (SELECT id FROM vehicle_classes WHERE code = 'mpv')
WHERE v.vehicle_class_id IS NULL
  AND REGEXP_REPLACE(LOWER(v.vehicle_class), '[^a-z0-9]', '', 'g')
      IN ('vclass', 'mercedesvclass', 'minivan', 'peoplecarrier', 'van', 'suv');

-- Matching a booking to drivers now reads this on every assignment screen.
CREATE INDEX IF NOT EXISTS vehicles_class_lookup
    ON vehicles (vehicle_class_id, verification_status)
    WHERE driver_id IS NOT NULL;

COMMIT;


-- =============================================================================
-- Checks — run this one, it matters
-- =============================================================================
-- Anything still unplaced cannot be given work. Set these by hand:
--
--   SELECT v.id, v.registration_number, v.vehicle_class AS typed_by_driver
--   FROM vehicles v
--   WHERE v.vehicle_class_id IS NULL;
--
--   UPDATE vehicles SET vehicle_class_id =
--       (SELECT id FROM vehicle_classes WHERE code = 'saloon')
--   WHERE id = <that vehicle>;
--
-- And to see the result:
--
--   SELECT v.registration_number, v.vehicle_class AS typed, vc.code, vc.name
--   FROM vehicles v LEFT JOIN vehicle_classes vc ON vc.id = v.vehicle_class_id;