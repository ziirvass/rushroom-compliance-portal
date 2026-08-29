# Rushroom Compliance Portal — Roadmap
_Last updated: 2026-08-29 · Auto-maintained by /ship_

## Now — In Progress
- PROP-012 Multi-tenant SaaS (organizations, memberships, invitations, platform_audit, ai_usage_events) — Stages 5b+6 remaining

## Next — Approved for Build
- PROP-014 Compliance–BOM Integration: Component Evidence Bridge — spec complete, awaiting "go ahead"

## Backlog — Ideas to Spec
- PROP-005 Generate DPP from compliance matrix
- PROP-009 Scheduled compliance scans + email alerts
- PROP-007 Multi-language support EN/DE/SV

## Shipped
- **PROP-019 COGS Layer Removal** (5 tables, 10 API actions, Cost Canvas subtab removed; BOM tree kept for compliance tracing; cache v141) — 2026-08-29
- **PROP-017 BOM Tree UX Polish** (always-show QTY, Expand All / Collapse All, sticky header, compact action labels) — 2026-08-29
- **PROP-016 BOM Tree — Add Sibling shortcut button** (`+sib` on every non-root row opens add-child modal with parent context) — 2026-08-29
- **PROP-015 Configure-to-Order Variant BOM** (product_family node type, variant_condition on bom_edges, family_attributes/values, saved_configurations, resolveVariant BFS filter, ⚙ Configure modal, condition picker in + child modal) — 2026-08-28
- **PROP-013 Product Information System — Vertical Integration Engine** (BOM tree, REACH/RoHS at component level, COGS simulation, Cost Canvas, Status Overview, full field-level audit trail with `bom_component_history`) — 2026-08-25 → 2026-08-27
- **Level 1 — Versioning & provenance** (immutable document/standard versions, audit trail, AI-assisted drafting, deviation scan) — live 2026-07-07
- **Level 2 — Clauses / Interpretations / Matrix / Passports** (PROP-001) — 2026-07-05
- **EU Directive Analyser (CELLAR)** — live 2026-07-07
- **Classification — Compliance Status dimension (Lifecycle × Scope)** — live 2026-07-07
- **Compliance Status board (Compliance Map)** — live 2026-07-07
- PROP-001 Level 2 Frontend UI ("Clauses & DPP" tab) — 2026-07-05
- PROP-006 AI-Suggested Compliance Status — by 2026-07-07
- PROP-008 Version control for interpretations (diff view) — by 2026-07-07
- PROP-011 Requirement Threads (requirement_links + document_statements) — 2026-07-08
