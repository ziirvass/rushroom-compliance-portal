-- PROP-024: Component Version History — Full State Access Per Revision
-- Adds version_snapshot JSONB to bom_component_versions.
-- Populated by bumpComponentVersion at bump time.
-- NULL for rows created before this migration; UI handles gracefully.
ALTER TABLE bom_component_versions
  ADD COLUMN version_snapshot JSONB;
