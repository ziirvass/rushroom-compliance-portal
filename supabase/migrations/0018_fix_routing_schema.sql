-- PROP-030 schema correction: routing steps are owned by a component, scoped to a product family.
-- The same purchased component can appear in multiple families with different operations per family.
-- Drop 0017 tables (no production data yet) and recreate with corrected schema.

DROP TABLE IF EXISTS work_order_components;
DROP TABLE IF EXISTS work_order_steps;
DROP TABLE IF EXISTS work_orders;
DROP TABLE IF EXISTS family_routing_steps;

-- 1. Component routing steps: owned by component, scoped to product family
--    (component_id, family_id) = the compound scope — same component, different steps per family
CREATE TABLE component_routing_steps (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  component_id          UUID        NOT NULL REFERENCES bom_components(id) ON DELETE CASCADE,
  family_id             UUID        NOT NULL REFERENCES bom_components(id) ON DELETE CASCADE,
  step_number           INTEGER     NOT NULL,
  operation_type        TEXT        NOT NULL CHECK (operation_type IN (
                          'drill','route','insert','attach','cut','surface_treat','inspect','other')),
  instruction_text      TEXT        NOT NULL,
  reference_document_id UUID        REFERENCES document_versions(id) ON DELETE SET NULL,
  variant_condition     JSONB,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (component_id, family_id, step_number)
);
ALTER TABLE component_routing_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny all" ON component_routing_steps AS RESTRICTIVE FOR ALL TO PUBLIC USING (false);

-- 2. Work orders (unchanged structure)
CREATE TABLE work_orders (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  family_id         UUID        NOT NULL REFERENCES bom_components(id) ON DELETE RESTRICT,
  external_order_id TEXT,
  selections        JSONB       NOT NULL DEFAULT '{}',
  status            TEXT        NOT NULL DEFAULT 'planned'
                      CHECK (status IN ('planned','in_progress','completed','shipped')),
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny all" ON work_orders AS RESTRICTIVE FOR ALL TO PUBLIC USING (false);

-- 3. Work order steps: immutable snapshot; component_id identifies which component is being processed
CREATE TABLE work_order_steps (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  work_order_id         UUID        NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  component_id          UUID        REFERENCES bom_components(id) ON DELETE SET NULL,
  step_number           INTEGER     NOT NULL,
  operation_type        TEXT        NOT NULL,
  instruction_text      TEXT        NOT NULL,
  reference_document_id UUID        REFERENCES document_versions(id) ON DELETE SET NULL,
  notes                 TEXT,
  status                TEXT        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','in_progress','done')),
  completed_at          TIMESTAMPTZ,
  completed_by          UUID        REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (work_order_id, step_number)
);
ALTER TABLE work_order_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny all" ON work_order_steps AS RESTRICTIVE FOR ALL TO PUBLIC USING (false);

-- 4. Work order components (unchanged)
CREATE TABLE work_order_components (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  work_order_id   UUID        NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  component_id    UUID        NOT NULL REFERENCES bom_components(id) ON DELETE RESTRICT,
  quantity        NUMERIC     NOT NULL DEFAULT 1,
  UNIQUE (work_order_id, component_id)
);
ALTER TABLE work_order_components ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny all" ON work_order_components AS RESTRICTIVE FOR ALL TO PUBLIC USING (false);
