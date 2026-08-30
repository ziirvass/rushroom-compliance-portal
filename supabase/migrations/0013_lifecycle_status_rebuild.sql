-- PROP-023: Component Lifecycle Status — Rebuild
-- Replaces 6 engineering-stage values with 4 operational states.
-- concept/specified/sourcing → inactive  |  approved/released → active  |  obsolete → replaced

-- 1. Drop the existing CHECK constraint
ALTER TABLE bom_components
  DROP CONSTRAINT bom_components_lifecycle_status_check;

-- 2. Add auxiliary columns for the two contextual states
ALTER TABLE bom_components
  ADD COLUMN replacement_note TEXT,
  ADD COLUMN flag_reason      TEXT;

-- 3. Migrate existing rows deterministically
UPDATE bom_components
SET lifecycle_status = CASE
  WHEN lifecycle_status IN ('concept', 'specified', 'sourcing') THEN 'inactive'
  WHEN lifecycle_status IN ('approved', 'released')             THEN 'active'
  WHEN lifecycle_status = 'obsolete'                            THEN 'replaced'
  ELSE 'inactive'
END;

-- 4. Set the new column default
ALTER TABLE bom_components
  ALTER COLUMN lifecycle_status SET DEFAULT 'inactive';

-- 5. Enforce the new 4-value constraint
ALTER TABLE bom_components
  ADD CONSTRAINT bom_components_lifecycle_status_check
  CHECK (lifecycle_status IN ('active', 'inactive', 'replaced', 'flagged'));
