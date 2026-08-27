-- ============================================================================
-- PROP-013 amendment: full audit trail for bom_components
-- Every INSERT and UPDATE writes an immutable snapshot to bom_component_history.
-- Each row answers: "what did this component look like from changed_at onward?"
-- ============================================================================

-- 1. Add updated_by so the trigger can record who triggered each change
ALTER TABLE bom_components ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id);

-- 2. History table — append-only, one row per state
CREATE TABLE bom_component_history (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  component_id     UUID NOT NULL,  -- no FK so rows survive a delete + stay as evidence
  changed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by       UUID REFERENCES users(id),
  change_type      TEXT NOT NULL CHECK (change_type IN ('created', 'updated')),
  -- Full field snapshot at this point in time
  part_number      VARCHAR(100),
  oem_number       VARCHAR(255),
  name             VARCHAR(255),
  description      TEXT,
  type             TEXT,
  lifecycle_status TEXT,
  notes            TEXT
);
ALTER TABLE bom_component_history ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_bom_hist_component ON bom_component_history (component_id, changed_at DESC);

-- 3. Trigger function for UPDATE: snapshot the NEW (post-change) state
CREATE OR REPLACE FUNCTION fn_bom_component_history_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO bom_component_history (
    organization_id, component_id, changed_at, changed_by, change_type,
    part_number, oem_number, name, description, type, lifecycle_status, notes
  ) VALUES (
    NEW.organization_id, NEW.id, NOW(), NEW.updated_by, 'updated',
    NEW.part_number, NEW.oem_number, NEW.name, NEW.description,
    NEW.type, NEW.lifecycle_status, NEW.notes
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_bom_component_history_update
  AFTER UPDATE ON bom_components
  FOR EACH ROW
  WHEN (
    OLD.part_number      IS DISTINCT FROM NEW.part_number      OR
    OLD.oem_number       IS DISTINCT FROM NEW.oem_number       OR
    OLD.name             IS DISTINCT FROM NEW.name             OR
    OLD.description      IS DISTINCT FROM NEW.description      OR
    OLD.type             IS DISTINCT FROM NEW.type             OR
    OLD.lifecycle_status IS DISTINCT FROM NEW.lifecycle_status OR
    OLD.notes            IS DISTINCT FROM NEW.notes
  )
  EXECUTE FUNCTION fn_bom_component_history_update();

-- 4. Trigger for INSERT: record the initial creation state
CREATE OR REPLACE FUNCTION fn_bom_component_history_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO bom_component_history (
    organization_id, component_id, changed_at, changed_by, change_type,
    part_number, oem_number, name, description, type, lifecycle_status, notes
  ) VALUES (
    NEW.organization_id, NEW.id, NOW(), NEW.created_by, 'created',
    NEW.part_number, NEW.oem_number, NEW.name, NEW.description,
    NEW.type, NEW.lifecycle_status, NEW.notes
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_bom_component_history_insert
  AFTER INSERT ON bom_components
  FOR EACH ROW EXECUTE FUNCTION fn_bom_component_history_insert();
