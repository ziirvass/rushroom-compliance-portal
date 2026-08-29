-- ============================================================================
-- PROP-015: Configure-to-Order Variant BOM (Product Families)
-- ============================================================================

-- 1. Extend bom_components type CHECK constraint to include product_family
ALTER TABLE bom_components DROP CONSTRAINT IF EXISTS bom_components_type_check;
ALTER TABLE bom_components ADD CONSTRAINT bom_components_type_check
  CHECK (type IN ('Product', 'Component', 'SparePart', 'Refurb', 'product_family'));

-- 2. Add variant_condition to bom_edges (nullable, backward-compatible)
--    NULL  = edge is active in ALL configurations
--    JSONB = edge is active only when all keys in the object match the selected attributes
--    e.g. {"Power": "50W"} means: include only when Power=50W is selected
ALTER TABLE bom_edges ADD COLUMN IF NOT EXISTS variant_condition JSONB DEFAULT NULL;

-- 3. family_attributes — one configurable dimension per product family
--    e.g. "Power" with display_name "Power rating"
CREATE TABLE IF NOT EXISTS family_attributes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  family_id        UUID NOT NULL REFERENCES bom_components(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  is_required      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, family_id, name)
);
ALTER TABLE family_attributes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny all" ON family_attributes FOR ALL USING (FALSE);

-- 4. family_attribute_values — valid options per attribute
--    e.g. {value: "50W", label: "50 W"}
CREATE TABLE IF NOT EXISTS family_attribute_values (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  attribute_id     UUID NOT NULL REFERENCES family_attributes(id) ON DELETE CASCADE,
  value            TEXT NOT NULL,
  label            TEXT NOT NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, attribute_id, value)
);
ALTER TABLE family_attribute_values ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny all" ON family_attribute_values FOR ALL USING (FALSE);

-- 5. saved_configurations — named, orderable product configurations
--    selections = {"Power": "50W", "Size": "L", "Color": "White"}
CREATE TABLE IF NOT EXISTS saved_configurations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  family_id        UUID NOT NULL REFERENCES bom_components(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  part_number      TEXT,
  description      TEXT,
  selections       JSONB NOT NULL,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, family_id, name)
);
ALTER TABLE saved_configurations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny all" ON saved_configurations FOR ALL USING (FALSE);

-- 6. Index for fast condition filtering in resolveVariant
CREATE INDEX IF NOT EXISTS bom_edges_variant_condition_idx
  ON bom_edges (parent_id) WHERE variant_condition IS NOT NULL;
