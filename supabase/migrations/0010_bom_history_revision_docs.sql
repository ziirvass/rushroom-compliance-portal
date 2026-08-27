-- ============================================================================
-- PROP-013 amendment: extend bom_component_history to track revision bumps
-- and document-link events (which don't touch bom_components directly, so
-- the AFTER UPDATE trigger never fires for them).
-- ============================================================================

-- Widen change_type to allow 'version_bumped' and 'document_linked'
ALTER TABLE bom_component_history
  DROP CONSTRAINT IF EXISTS bom_component_history_change_type_check;

ALTER TABLE bom_component_history
  ADD CONSTRAINT bom_component_history_change_type_check
  CHECK (change_type IN ('created', 'updated', 'version_bumped', 'document_linked'));
