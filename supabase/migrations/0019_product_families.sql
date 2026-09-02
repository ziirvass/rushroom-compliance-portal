-- PROP-030 continuation: product families as a separate entity dimension.
-- A product family = a named set of components/assemblies (many-to-many).
-- The same purchased component can belong to multiple families with different
-- manufacturing steps per family. This is independent of the Configure-to-Order
-- variant BOM (product_family BOM node type, which stays for dynamic BOMs).

-- 1. Product families (standalone entity, not a BOM node type)
CREATE TABLE product_families (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
ALTER TABLE product_families ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny all" ON product_families AS RESTRICTIVE FOR ALL TO PUBLIC USING (false);

-- 2. Component membership in product families (many-to-many)
CREATE TABLE product_family_members (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  family_id       UUID        NOT NULL REFERENCES product_families(id) ON DELETE CASCADE,
  component_id    UUID        NOT NULL REFERENCES bom_components(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (family_id, component_id)
);
ALTER TABLE product_family_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny all" ON product_family_members AS RESTRICTIVE FOR ALL TO PUBLIC USING (false);

-- 3. Fix component_routing_steps: family_id → product_families (not bom_components)
--    Drop and recreate — no production data in 0017/0018 tables.
DROP TABLE IF EXISTS component_routing_steps;
CREATE TABLE component_routing_steps (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  component_id          UUID        NOT NULL REFERENCES bom_components(id) ON DELETE CASCADE,
  family_id             UUID        NOT NULL REFERENCES product_families(id) ON DELETE CASCADE,
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

-- 4. Fix work_orders: family_id → product_families; remove selections (no variant config at WO level)
DROP TABLE IF EXISTS work_order_steps;
DROP TABLE IF EXISTS work_order_components;
DROP TABLE IF EXISTS work_orders;

CREATE TABLE work_orders (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  family_id         UUID        NOT NULL REFERENCES product_families(id) ON DELETE RESTRICT,
  external_order_id TEXT,
  notes             TEXT,
  status            TEXT        NOT NULL DEFAULT 'planned'
                      CHECK (status IN ('planned','in_progress','completed','shipped')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny all" ON work_orders AS RESTRICTIVE FOR ALL TO PUBLIC USING (false);

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
