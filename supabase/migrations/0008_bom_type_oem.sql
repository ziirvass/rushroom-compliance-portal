-- ============================================================================
-- PROP-013 amendment: OEM number + revised type enum + UOM nullable
-- ============================================================================

-- 1. Add OEM number column
ALTER TABLE bom_components ADD COLUMN IF NOT EXISTS oem_number VARCHAR(255);

-- 2. Make unit_of_measure nullable (field removed from UI)
ALTER TABLE bom_components ALTER COLUMN unit_of_measure DROP NOT NULL;

-- 3. Migrate existing type values to the new enum before adding the constraint
UPDATE bom_components SET type = 'Product'   WHERE type = 'finished_good';
UPDATE bom_components SET type = 'Component' WHERE type IN ('sub_assembly', 'purchased_part', 'raw_material');

-- 4. Drop the old inline CHECK constraint (Postgres names it <table>_type_check)
ALTER TABLE bom_components DROP CONSTRAINT IF EXISTS bom_components_type_check;

-- 5. Add new constraint
ALTER TABLE bom_components ADD CONSTRAINT bom_components_type_check
  CHECK (type IN ('Product', 'Component', 'SparePart', 'Refurb'));
