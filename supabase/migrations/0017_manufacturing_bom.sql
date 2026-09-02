-- PROP-030: Manufacturing BOM — Postponement Routing & Work Orders
-- Four new tenant tables: family_routing_steps, work_orders, work_order_steps, work_order_components

-- 1. Routing steps on a product_family — atomic, ordered, variant-conditional
CREATE TABLE family_routing_steps (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  family_id               UUID        NOT NULL REFERENCES bom_components(id) ON DELETE CASCADE,
  step_number             INTEGER     NOT NULL,
  operation_type          TEXT        NOT NULL CHECK (operation_type IN (
                            'drill','route','insert','attach','cut','surface_treat','inspect','other')),
  instruction_text        TEXT        NOT NULL,
  reference_document_id   UUID        REFERENCES document_versions(id) ON DELETE SET NULL,
  applies_to_component_id UUID        REFERENCES bom_components(id) ON DELETE SET NULL,
  variant_condition       JSONB,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (family_id, step_number)
);
ALTER TABLE family_routing_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny all" ON family_routing_steps AS RESTRICTIVE FOR ALL TO PUBLIC USING (false);

-- 2. Work order — one per customer order, tied to a family + selections
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

-- 3. Work order steps — immutable snapshot of resolved routing at order creation time
CREATE TABLE work_order_steps (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  work_order_id           UUID        NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  step_number             INTEGER     NOT NULL,
  operation_type          TEXT        NOT NULL,
  instruction_text        TEXT        NOT NULL,
  reference_document_id   UUID        REFERENCES document_versions(id) ON DELETE SET NULL,
  applies_to_component_id UUID        REFERENCES bom_components(id) ON DELETE SET NULL,
  notes                   TEXT,
  status                  TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','in_progress','done')),
  completed_at            TIMESTAMPTZ,
  completed_by            UUID        REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (work_order_id, step_number)
);
ALTER TABLE work_order_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny all" ON work_order_steps AS RESTRICTIVE FOR ALL TO PUBLIC USING (false);

-- 4. Work order components — immutable snapshot of resolved pull list at order creation time
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
