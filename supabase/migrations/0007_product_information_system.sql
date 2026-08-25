-- ============================================================================
-- PROP-013 · Product Information System — Vertical Integration Engine
-- Ten new tables: BOM tree + cost intelligence + simulation layer
-- Migration number: 0007 (follows 0006_multi_tenant.sql)
-- ============================================================================

-- 1. BOM COMPONENTS — the node table (unlimited depth via bom_edges)
CREATE TABLE bom_components (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  part_number      VARCHAR(100) NOT NULL,
  name             VARCHAR(255) NOT NULL,
  description      TEXT,
  type             TEXT NOT NULL CHECK (type IN (
                     'raw_material', 'purchased_part', 'sub_assembly', 'finished_good'
                   )),
  unit_of_measure  VARCHAR(50) NOT NULL DEFAULT 'ea',
  lifecycle_status TEXT NOT NULL DEFAULT 'concept' CHECK (lifecycle_status IN (
                     'concept', 'specified', 'sourcing', 'approved', 'released', 'obsolete'
                   )),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       UUID REFERENCES users(id),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, part_number)
);
ALTER TABLE bom_components ENABLE ROW LEVEL SECURITY;

-- 2. BOM COMPONENT VERSIONS — immutable spec history (mirrors document_versions)
CREATE TABLE bom_component_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  component_id    UUID NOT NULL REFERENCES bom_components(id),
  revision        VARCHAR(20) NOT NULL,  -- e.g. "A", "B", "1.0", "1.1"
  spec_summary    TEXT,                  -- what changed in this revision
  is_current      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID REFERENCES users(id),
  UNIQUE (component_id, revision)
);
ALTER TABLE bom_component_versions ENABLE ROW LEVEL SECURITY;

-- Trigger: mark all previous versions is_current=FALSE when a new one is inserted
CREATE OR REPLACE FUNCTION fn_set_current_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE bom_component_versions
  SET is_current = FALSE
  WHERE component_id = NEW.component_id AND id <> NEW.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_set_current_version
  AFTER INSERT ON bom_component_versions
  FOR EACH ROW EXECUTE FUNCTION fn_set_current_version();

-- 3. BOM EDGES — the adjacency-list tree (unlimited depth, time-versioned)
CREATE TABLE bom_edges (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id),
  parent_id            UUID NOT NULL REFERENCES bom_components(id),
  child_id             UUID NOT NULL REFERENCES bom_components(id),
  quantity             NUMERIC NOT NULL CHECK (quantity > 0),
  reference_designator VARCHAR(255),  -- e.g. "J1, J2"
  effective_from       DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to         DATE,          -- NULL = currently active
  CONSTRAINT no_self_loop CHECK (parent_id <> child_id),
  UNIQUE (parent_id, child_id, effective_from)
);
ALTER TABLE bom_edges ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_bom_edges_parent ON bom_edges (parent_id) WHERE effective_to IS NULL;
CREATE INDEX idx_bom_edges_child  ON bom_edges (child_id)  WHERE effective_to IS NULL;

-- Cycle-detection trigger: refuse an edge that would create a cycle
CREATE OR REPLACE FUNCTION fn_check_bom_cycle()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT parent_id AS node
      FROM bom_edges
      WHERE child_id = NEW.parent_id AND effective_to IS NULL
      UNION ALL
      SELECT be.parent_id
      FROM bom_edges be
      JOIN ancestors a ON be.child_id = a.node
      WHERE be.effective_to IS NULL
    )
    SELECT 1 FROM ancestors WHERE node = NEW.child_id
  ) THEN
    RAISE EXCEPTION 'BOM cycle detected: component % is already an ancestor of %',
      NEW.child_id, NEW.parent_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_check_bom_cycle
  BEFORE INSERT ON bom_edges
  FOR EACH ROW EXECUTE FUNCTION fn_check_bom_cycle();

-- 4. COMPONENT MATERIALS — per-component substance rows (REACH/RoHS at component level)
CREATE TABLE component_materials (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         UUID NOT NULL REFERENCES organizations(id),
  component_id            UUID NOT NULL REFERENCES bom_components(id),
  substance_name          VARCHAR(255) NOT NULL,
  cas_number              VARCHAR(20),
  percentage_w_w          NUMERIC CHECK (percentage_w_w > 0 AND percentage_w_w <= 100),
  reach_svhc              BOOLEAN NOT NULL DEFAULT FALSE,
  rohs_restricted         BOOLEAN NOT NULL DEFAULT FALSE,
  svhc_threshold_exceeded BOOLEAN,
  notes                   TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, component_id, substance_name)
);
ALTER TABLE component_materials ENABLE ROW LEVEL SECURITY;

-- 5. COMPONENT DOCUMENTS — versioned documents attached to a component
CREATE TABLE component_documents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id),
  component_id        UUID NOT NULL REFERENCES bom_components(id),
  document_version_id UUID NOT NULL REFERENCES document_versions(id),
  category            TEXT NOT NULL CHECK (category IN (
                        'datasheet', 'drawing', 'test_report', 'declaration',
                        'quality_cert', 'other'
                      )),
  label               VARCHAR(255),
  is_supplier_visible BOOLEAN NOT NULL DEFAULT FALSE,
  uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by         UUID REFERENCES users(id)
);
ALTER TABLE component_documents ENABLE ROW LEVEL SECURITY;

-- 6. COMPONENT COSTS — unit pricing (internal only, never exposed to suppliers)
CREATE TABLE component_costs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  component_id    UUID NOT NULL REFERENCES bom_components(id),
  supplier_name   VARCHAR(255),
  unit_price      NUMERIC NOT NULL CHECK (unit_price >= 0),
  currency        CHAR(3) NOT NULL DEFAULT 'SEK',
  moq             INTEGER,
  effective_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  quote_reference VARCHAR(255),
  cost_maturity   TEXT NOT NULL DEFAULT 'estimate' CHECK (cost_maturity IN (
                    'estimate', 'budgetary_quote', 'firm_quote', 'contracted', 'actual'
                  )),
  external_ref    VARCHAR(255),  -- ERP line-item ref (future sync anchor)
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID REFERENCES users(id)
);
ALTER TABLE component_costs ENABLE ROW LEVEL SECURITY;

-- 7. LANDED COST FACTORS — BI-layer inputs (freight, duty, currency, overhead)
CREATE TABLE landed_cost_factors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  component_id    UUID NOT NULL REFERENCES bom_components(id),
  factor_type     TEXT NOT NULL CHECK (factor_type IN (
                    'freight', 'duty', 'currency_adjustment', 'overhead'
                  )),
  value           NUMERIC NOT NULL,
  unit            TEXT NOT NULL CHECK (unit IN ('percent', 'fixed_amount')),
  currency        CHAR(3),  -- used when unit = 'fixed_amount'
  effective_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, component_id, factor_type)
);
ALTER TABLE landed_cost_factors ENABLE ROW LEVEL SECURITY;

-- 8. COST SCENARIOS — named what-if simulation workspaces
CREATE TABLE cost_scenarios (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id),
  name              VARCHAR(255) NOT NULL,
  description       TEXT,
  base_component_id UUID NOT NULL REFERENCES bom_components(id),
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        UUID REFERENCES users(id),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE cost_scenarios ENABLE ROW LEVEL SECURITY;

-- 9. SCENARIO OVERRIDES — per-scenario per-component overrides (the diff from production)
CREATE TABLE scenario_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  scenario_id     UUID NOT NULL REFERENCES cost_scenarios(id),
  component_id    UUID NOT NULL REFERENCES bom_components(id),
  override_type   TEXT NOT NULL CHECK (override_type IN (
                    'unit_price', 'quantity', 'lifecycle_status',
                    'sourcing_mode', 'landed_factor'
                  )),
  value           JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scenario_id, component_id, override_type)
);
ALTER TABLE scenario_overrides ENABLE ROW LEVEL SECURITY;

-- 10. COGS SNAPSHOTS — append-only point-in-time COGS rollup
CREATE TABLE cogs_snapshots (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id),
  root_component_id UUID NOT NULL REFERENCES bom_components(id),
  scenario_id       UUID REFERENCES cost_scenarios(id),  -- NULL = production BOM
  snapshot_date     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_cogs        NUMERIC NOT NULL,
  currency          CHAR(3) NOT NULL DEFAULT 'SEK',
  confidence_label  TEXT NOT NULL CHECK (confidence_label IN (
                      'estimate', 'budgetary_quote', 'firm_quote', 'contracted', 'actual'
                    )),
  detail            JSONB NOT NULL DEFAULT '{}'
);
ALTER TABLE cogs_snapshots ENABLE ROW LEVEL SECURITY;

-- Extend product_passports: optional link to the root BOM component
ALTER TABLE product_passports
  ADD COLUMN IF NOT EXISTS root_component_id UUID REFERENCES bom_components(id);

-- ============================================================================
-- PostgreSQL function for recursive COGS computation (called via db.rpc())
-- Returns a flat list of every node in the BOM tree with cost contribution.
-- Scenario overrides are applied when p_scenario_id is not NULL.
-- ============================================================================
CREATE OR REPLACE FUNCTION compute_bom_cogs(
  p_root_id     UUID,
  p_org_id      UUID,
  p_scenario_id UUID DEFAULT NULL
)
RETURNS TABLE (
  component_id   UUID,
  part_number    TEXT,
  name           TEXT,
  depth          INT,
  path           UUID[],
  own_quantity   NUMERIC,
  cum_quantity   NUMERIC,
  unit_price     NUMERIC,
  currency       TEXT,
  cost_maturity  TEXT,
  landed_cost    NUMERIC,
  node_cogs      NUMERIC
)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE tree AS (
    SELECT
      c.id                AS component_id,
      c.part_number::TEXT,
      c.name,
      0                   AS depth,
      ARRAY[c.id]         AS path,
      1::NUMERIC          AS own_quantity,
      1::NUMERIC          AS cum_quantity
    FROM bom_components c
    WHERE c.id = p_root_id AND c.organization_id = p_org_id

    UNION ALL

    SELECT
      c.id,
      c.part_number::TEXT,
      c.name,
      t.depth + 1,
      t.path || c.id,
      -- quantity: apply scenario override if present
      COALESCE(
        (SELECT (so.value->>'quantity')::NUMERIC
         FROM scenario_overrides so
         WHERE so.scenario_id = p_scenario_id
           AND so.component_id = e.child_id
           AND so.override_type = 'quantity'),
        e.quantity
      ),
      t.cum_quantity * COALESCE(
        (SELECT (so.value->>'quantity')::NUMERIC
         FROM scenario_overrides so
         WHERE so.scenario_id = p_scenario_id
           AND so.component_id = e.child_id
           AND so.override_type = 'quantity'),
        e.quantity
      )
    FROM tree t
    JOIN bom_edges e      ON e.parent_id = t.component_id AND e.effective_to IS NULL
    JOIN bom_components c ON c.id = e.child_id AND c.organization_id = p_org_id
    WHERE NOT c.id = ANY(t.path)  -- cycle guard at query level
  ),
  costs AS (
    -- Best cost row per component: scenario override wins, then highest maturity
    SELECT DISTINCT ON (cc.component_id)
      cc.component_id,
      COALESCE(
        (SELECT (so.value->>'unit_price')::NUMERIC
         FROM scenario_overrides so
         WHERE so.scenario_id = p_scenario_id
           AND so.component_id = cc.component_id
           AND so.override_type = 'unit_price'),
        cc.unit_price
      ) AS unit_price,
      cc.currency,
      cc.cost_maturity
    FROM component_costs cc
    WHERE cc.organization_id = p_org_id
    ORDER BY cc.component_id,
             CASE cc.cost_maturity
               WHEN 'actual'          THEN 1
               WHEN 'contracted'      THEN 2
               WHEN 'firm_quote'      THEN 3
               WHEN 'budgetary_quote' THEN 4
               ELSE 5 END,
             cc.effective_date DESC
  ),
  factors AS (
    -- Sum percent-type landed cost factors as a multiplier per component
    SELECT
      component_id,
      1 + SUM(CASE WHEN unit = 'percent' THEN value / 100 ELSE 0 END) AS multiplier
    FROM landed_cost_factors
    WHERE organization_id = p_org_id
    GROUP BY component_id
  )
  SELECT
    t.component_id,
    t.part_number,
    t.name,
    t.depth,
    t.path,
    t.own_quantity,
    t.cum_quantity,
    COALESCE(c.unit_price, 0)             AS unit_price,
    COALESCE(c.currency, 'SEK')           AS currency,
    COALESCE(c.cost_maturity, 'estimate') AS cost_maturity,
    COALESCE(c.unit_price, 0) * COALESCE(f.multiplier, 1)                AS landed_cost,
    COALESCE(c.unit_price, 0) * COALESCE(f.multiplier, 1) * t.cum_quantity AS node_cogs
  FROM tree t
  LEFT JOIN costs   c ON c.component_id = t.component_id
  LEFT JOIN factors f ON f.component_id = t.component_id
  ORDER BY t.depth, t.name;
$$;
