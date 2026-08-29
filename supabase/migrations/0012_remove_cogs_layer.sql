-- PROP-019: Remove COGS/financial layer from the compliance portal.
-- Financial analysis belongs in ERP, not in a compliance portal.
-- The BOM tree (bom_components, bom_edges) is kept for compliance tracing.

DROP TABLE IF EXISTS scenario_overrides;
DROP TABLE IF EXISTS cogs_snapshots;
DROP TABLE IF EXISTS cost_scenarios;
DROP TABLE IF EXISTS landed_cost_factors;
DROP TABLE IF EXISTS component_costs;
