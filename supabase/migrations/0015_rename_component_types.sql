-- PROP-025: Rename component type values to meaningful manufacturing categories.
-- Old: Component | Product | SparePart | Refurb | product_family
-- New: part | raw_material | sub_assembly | finished_good | spare_part | product_family
--
-- Tab classification moves from type-based to structural (has_children) in the frontend.
-- The type field now describes WHAT the part is (manufacturing category), not where it lives in the UI.

ALTER TABLE bom_components DROP CONSTRAINT bom_components_type_check;

UPDATE bom_components SET type = CASE
  WHEN type = 'Component' THEN 'part'
  WHEN type = 'Product'   THEN 'finished_good'
  WHEN type = 'SparePart' THEN 'spare_part'
  WHEN type = 'Refurb'    THEN 'spare_part'
  ELSE type  -- keeps 'product_family' and any future-safe values
END;

ALTER TABLE bom_components ADD CONSTRAINT bom_components_type_check
  CHECK (type IN ('part', 'raw_material', 'sub_assembly', 'finished_good', 'spare_part', 'product_family'));

ALTER TABLE bom_components ALTER COLUMN type SET DEFAULT 'part';
