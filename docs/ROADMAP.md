# Rushroom Compliance Portal — Roadmap
_Last updated: 2026-08-30 · Auto-maintained by /ship_

## Now — In Progress
- PROP-021 Component Document Lifecycle — Layer 1 shipped (upload & link from component panel); Layers 2–4 (new revision, AI diff, data extraction) pending; PROP-014 must be reviewed before Layer 2 design
- PROP-012 Multi-tenant SaaS (organizations, memberships, invitations, platform_audit, ai_usage_events) — Stages 5b+6 remaining

## Next — Approved for Build
- PROP-014 Compliance–BOM Integration: Component Evidence Bridge — spec complete, awaiting "go ahead"

## Backlog — Ideas to Spec
- PROP-005 Generate DPP from compliance matrix
- PROP-009 Scheduled compliance scans + email alerts
- PROP-007 Multi-language support EN/DE/SV

## Shipped
- **Bug fix — "Can't find variable: role" complete fix** (`renderBomTree` is also a peer function lacking `role`; added as 8th param and updated its call site; all three peer functions — `bomTreeView`, `renderBomTree`, `openComponentDetail` — now receive `role` explicitly from `renderProduct`; cache v155) — 2026-08-30
- **Bug fix — "Can't find variable: role" correct fix** (`openComponentDetail` is a peer function of `bomTreeView`, not nested — added `role` as explicit 5th param and updated all 7 call sites; v154 supersedes the incorrect v153 attempt) — 2026-08-30
- **Bug fix — "Can't find variable: role" incorrect attempt** (v153 added role to `bomTreeView` param but `openComponentDetail` is not nested inside it so it had no effect) (`role` not passed into `bomTreeView`; `renderProduct(role)` called `bomTreeView(token)` without it; fixed by adding `role` as second param; cache v153) — 2026-08-30
- **Bug fix — Component detail tables only showing first row** (all 5 tables in the component detail panel — Versions, Documents, Materials, Used In, Change Log — were silently showing only their first row; root cause: `el("tbody", {}, ...rows)` spread rows as positional args but `el(tag, attrs, kids)` only reads the 3rd param; fix: remove spread so arrays pass directly; cache v152) — 2026-08-30
- **Bug fix — Version history after bump** (explicit is_current retire in bumpComponentVersion application code; panel refresh awaits + passes nodeData; cache v151) — 2026-08-30
- **PROP-023 Component Lifecycle Status — Rebuild** (4 operational states: active/inactive/replaced/flagged; migration 0013 migrates all existing rows; replacement_note + flag_reason columns; inline status editor in component detail panel; cache v150) — 2026-08-30
- **PROP-022 BOM List Performance & Search** (lazy tree expansion, `has_children` from single edge query, search + 50-item pagination; cache v149) — 2026-08-30
- **PROP-021 Component Document Lifecycle — Layer 1** (direct upload & link from component detail panel via new `uploadAndLinkComponentDocument` action; two-tab modal replaces single-flow link modal; cache v148) — 2026-08-29
- **PROP-020 BOM List Split by Type** (Components / Assemblies / Dynamic BOMs tabs in BOM Tree view; delete button label "Delete Permanently"; cache v143) — 2026-08-29
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
