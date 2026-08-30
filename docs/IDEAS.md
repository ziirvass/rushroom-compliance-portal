# Rushroom — Feature Ideas
_Raw ideas not yet turned into proposals. Add new ideas with /ideate._

---
### Product Information System — Vertical Integration Engine — 2026-08-25
_Revised 2026-08-25 (iteration 3): added cost simulation layer, component lifecycle statuses, cost maturity levels, and visual costing canvas._

**One sentence:** An unbounded-depth Bill of Materials with lifecycle statuses at every node, a named scenario/simulation layer for early NPD cost modelling, and a live visual canvas that lets anyone with access drag inputs and instantly see how COGS changes — all sitting on top of a BI cost-intelligence layer that feeds into but never replaces the procured financial ERP.

**Problem it solves:**  
*Compliance side:* REACH/RoHS and technical documentation today live at the product level (`product_passports`). Regulators increasingly expect substance data per article/component. A supplier changing one LED component can invalidate test reports or breach SVHC thresholds — but today there is no way to know which product version is affected or what share of COGS that component represents.

*Vertical integration side:* Without cost visibility at every assembly level, make-vs-buy decisions are gut feel. The system should answer "if we built this sub-assembly ourselves instead of buying it, what would the cost delta be?" at any node in the tree.

*NPD simulation side:* In early product development, most cost figures are estimates or rough quotes. Engineers and product managers need to explore "what if" questions — what if we swap the LED strip supplier? what if we bring the PSU in-house? — before any firm quote exists. Today this lives in a spreadsheet that no one keeps current. The simulation layer makes this an interactive, shared, version-tracked workspace with live visual feedback. The status model tells you exactly how confident each number is and how mature each component decision is.

*Landed cost:* Freight, duty, and currency effects are invisible. They live in the ERP-to-be or in someone's head. The BI layer captures these as explicit factors so they can be included in simulations and flagged clearly as estimates.

**Architecture intent:**  
Three layers, each with a clear role:

1. **PLM core** — system of record for physical product structure, component specs, versions, compliance data, and raw prices. Lives in Supabase. Append-only versioning throughout.

2. **BI / simulation layer** — derives landed costs, COGS rollups, and buy-vs-make deltas from the PLM core data. Named scenarios (`cost_scenarios`) let users fork the cost model, override any dimension, and compare results. The outputs are labelled directional intelligence, not accounting truth.

3. **ERP (procured, future)** — owns invoices, payments, P&L. This platform feeds it via `external_ref` fields on cost rows. When the ERP is live, it becomes authoritative for `actual` cost maturity rows; this system remains the home for estimates, simulations, and compliance data.

Financial accounting does not live here. Visual decision support does.

**Component lifecycle status** (mirrors the compliance portal's step statuses):  
`bom_components.lifecycle_status`: `concept` → `specified` → `sourcing` → `approved` → `released` → `obsolete`  
These are the engineering gates. A component moves right as decisions are made and evidence collected.

**Cost maturity** (the confidence dimension on every price):  
`component_costs.cost_maturity`: `estimate` | `budgetary_quote` | `firm_quote` | `contracted` | `actual`  
The visual layer always shows cost maturity alongside every number — a COGS built from estimates looks different (amber, uncertainty band shown) than one built from contracted prices (green, no band).

**MVP scope:**  
1. **`bom_components`** — node table: `id`, `organization_id`, `part_number` (unique per org), `name`, `description`, `type` (raw_material | purchased_part | sub_assembly | finished_good), `unit_of_measure`, `revision`, `lifecycle_status` (concept | specified | sourcing | approved | released | obsolete), `created_at`.  
2. **`bom_edges`** — tree structure: `parent_id → bom_components`, `child_id → bom_components`, `quantity NUMERIC`, `reference_designator`, `effective_from`, `effective_to`. Unique on `(parent_id, child_id, effective_from)`. Unlimited depth; reuse of the same component in multiple assemblies is supported.  
3. **`bom_component_versions`** — immutable spec history (same pattern as `document_versions`).  
4. **`component_materials`** — substance rows per component: substance name, CAS, % w/w, REACH/RoHS status, SVHC flag.  
5. **`component_documents`** — documents per component with `category` enum (datasheet | drawing | test_report | declaration | quality_cert), FK → `document_versions`.  
6. **`component_costs`** — pricing rows: `component_id`, `supplier_name`, `unit_price NUMERIC`, `currency CHAR(3)`, `moq`, `effective_date`, `quote_reference`, `cost_maturity` (estimate | budgetary_quote | firm_quote | contracted | actual), `external_ref` (ERP line-item ref, populated when ERP goes live). Multiple rows per component for multi-supplier comparison. **Internal only.**  
7. **`landed_cost_factors`** — BI inputs per component: `factor_type` (freight | duty | currency_adjustment | overhead), `value NUMERIC`, `unit` (percent | fixed_amount), `currency`, `effective_date`, `notes`.  
8. **`cogs_snapshots`** — append-only COGS rollup: `root_component_id`, `scenario_id` (null = production BOM), `snapshot_date`, `total_cogs NUMERIC`, `currency`, `confidence_label` (computed from worst cost_maturity in the tree), `detail JSONB` (full tree breakdown with per-node contribution and maturity).  
9. **`cost_scenarios`** — named simulation workspaces: `id`, `organization_id`, `name`, `description`, `base_component_id` (BOM root), `status` (draft | published | archived), `created_by`, `created_at`. Scenarios are never the production BOM — they are what-if explorations.  
10. **`scenario_overrides`** — per-scenario, per-component overrides: `scenario_id`, `component_id`, `override_type` (unit_price | quantity | lifecycle_status | sourcing_mode | landed_factor), `value JSONB`. A scenario is the production BOM + this diff. Multiple overrides per component per scenario are allowed.  
11. **API actions:** `getBom`, `addComponent`, `updateComponent`, `setComponentStatus`, `getComponentHistory`, `addBomEdge`, `removeBomEdge`, `addComponentDocument`, `getComponentMaterials`, `upsertComponentMaterial`, `getComponentCosts`, `upsertComponentCost`, `upsertLandedCostFactor`, `computeCogs`, `compareCogs`, `createScenario`, `updateScenario`, `applyScenarioOverride`, `getScenarioResult` (returns full costed tree for the scenario), `listScenarios`, `archiveScenario`.  
12. **Supplier-facing:** can upload to `component_documents`; cannot read `component_costs`, `landed_cost_factors`, `cogs_snapshots`, `cost_scenarios`, or `scenario_overrides`.  
13. **Visual layer — "Product" tab, three sub-tabs:**  
    - **BOM tree view:** collapsible unlimited-depth tree. Each node shows lifecycle status badge (same colour system as compliance portal step statuses) and cost maturity badge. Nodes coloured by cost contribution as % of root COGS (heat-map: cool = small share, warm = large share). Click a node → component detail slide-in.  
    - **Cost canvas (simulation):** select a scenario or start from production. Controls: swap supplier, override unit price, change quantity, toggle sourcing mode (buy ↔ build-from-sub-BOM). Charts update live on every keystroke (client-side computation on the fetched tree — no round-trip for interactive edits; snapshot saved on explicit "Save").  
      - *Sorted cost bar:* all leaf components sorted by landed cost contribution, bars segmented by cost factor type (unit price, freight, duty, currency). Amber fill = estimate maturity; green = contracted.  
      - *Treemap:* hierarchical COGS breakdown by BOM level and type.  
      - *Scenario comparison:* side-by-side total COGS bars for up to 4 scenarios simultaneously.  
      - *Confidence band:* when any component in the tree is at `estimate` or `budgetary_quote` maturity, the total COGS figure shows a ±% uncertainty band derived from the proportion of estimated cost in the tree.  
    - **Status overview:** dashboard of lifecycle status distribution across the BOM (how many components are still at concept? how much of COGS is estimate vs firm quote?) — mirrors the compliance portal's action-plan progress view.

**Tables involved:**  
New: `bom_components`, `bom_edges`, `bom_component_versions`, `component_materials`, `component_documents`, `component_costs`, `landed_cost_factors`, `cogs_snapshots`, `cost_scenarios`, `scenario_overrides`  
Extended: `product_passports` (add FK `root_component_id → bom_components`)  
All new tables: `organization_id NOT NULL FK → organizations` (PROP-012 contract)

**Effort estimate:** 80–100 hours  
- Schema + migrations (10 new tables): 10 h  
- Recursive BOM CTE + core API actions (~20 actions): 20 h  
- Scenario system (create, override, resolve, snapshot): 12 h  
- Landed cost + COGS compute + confidence band logic: 10 h  
- Access-control (cost/scenario hiding, supplier gate): 6 h  
- UI — BOM tree with status badges + heat-map: 14 h  
- UI — Cost canvas (live simulation, 4 chart types): 20 h  
- UI — Status overview dashboard: 6 h  
- Tests: 10 h

**Risks:**  
- **Recursive query performance:** Materialise COGS into `cogs_snapshots` — never compute the full tree live. Load tree view 3 levels deep eagerly, expand on demand. Index `bom_edges` on `(parent_id, effective_to)`.  
- **Cycle prevention in `bom_edges`:** Enforce via a Postgres trigger that walks ancestors before insert. Without this, a recursive CTE on a cyclic graph is infinite.  
- **Simulation accuracy vs. false confidence:** The confidence band on estimates helps, but users must understand this is directional. Every simulation result must carry a `confidence_label` and a disclaimer. Do not label any simulation output "actual cost."  
- **Client-side simulation state:** Live chart updates happen on the client (no round-trip per keystroke). This requires the full costed tree to be held in memory on the client side. For large BOMs this may be expensive — lazy-load deep nodes, pre-compute sub-tree COGS server-side.  
- **Supplier visibility rules:** Every action handler returning component data must explicitly strip cost/scenario fields for supplier sessions at the edge function level — not in the UI.  
- **ERP sync boundary:** `component_costs.external_ref` is the future sync anchor. When the ERP goes live, decide whether ERP is authoritative (it pushes `actual` rows here) or this system is (it exports here to ERP). Design for the former.  
- **Chart library choice:** Vanilla JS + Chart.js handles bars and lines well. The treemap and BOM heat-map need custom SVG — do not reach for a heavy framework. Keep charting lightweight and self-contained.  
- **Status model discipline:** Lifecycle statuses only move forward (concept → released) by explicit user action, not automatically. Reversions (e.g. released → sourcing after a component re-qualification) must be tracked in `bom_component_versions` with a reason. This mirrors how the compliance portal handles step status changes.

**Related PROPs:**  
- PROP-001 (Level 2 / Passports — `product_passports` anchors to the BOM root; DPP can draw substance data from `component_materials`)  
- PROP-011 (Requirement Links — component documents link to standard clauses; full component→clause traceability for the Technical File)  
- PROP-012 (Multi-tenancy — all new tables carry `organization_id`; cost and scenario data are the most sensitive per-tenant data)

**Status:** Implemented as PROP-013 (2026-08-25)

---
### Compliance–BOM Integration: Component Evidence Bridge — 2026-08-25
**One sentence:** A typed evidence layer that links specific BOM component versions to the standard clauses they satisfy — with lab test report version management — so that a component revision automatically surfaces which compliance requirements need re-evidencing.

**Problem it solves:**  
The compliance portal today knows *which documents* interpret *which clauses* (`as_operates_interpretations`: `clause_id × document_version_id`). The BOM system will know *which components* exist and what their specs are. But neither system knows the critical link between them: **which component version is the physical thing that a test report was run on, and which standard clause does that test cover?**

Without this bridge:
- A lab test report uploaded as evidence for step 10 ("arrange LVD testing") is just a file. There is no machine-readable record of what component it tested or which clause it covers.
- When the LED strip assembly is revised (new `bom_component_versions` row), no system signals "your LVD test for EN 60598 clause 8.3 was on the old component — you may need to retest."
- A product manager cannot ask "which requirements does changing this component put at risk?" without manually reading all test reports.
- The Technical File audit trail (CE marking) cannot be automatically generated — the component→test report→clause chain is in someone's head.

This is the traceability layer that turns the BOM and the compliance portal into one coherent product record.

**Architecture intent:**  
A new `component_clause_evidence` table is the bridge:
```
bom_component_versions ──┐
                          ├── component_clause_evidence ── document_versions (test report)
standard_clauses ─────────┘
```
This is distinct from `as_operates_interpretations` (which links *documents* to *clauses* — a document-level interpretation) and from PROP-011's `requirement_links` (which links *text units* to *text units*). Component evidence links a *physical object at a specific revision* to a *requirement*, with an evidence document.

A Postgres trigger on `bom_component_versions` INSERT copies all `component_clause_evidence` rows for the previous version of that component to the new version with `status = pending_retest`. This is the automated re-test signal — no manual triage needed.

Lab test reports are a specific subtype of `component_documents` (planned in PIS). They carry additional structured fields: test lab name, accreditation number, test date, and test scope. These fields live as nullable columns on `component_documents` gated by `category = 'test_report'` — no separate table needed.

**MVP scope:**  
1. **Extend `component_documents`** (from PIS) with nullable test-report fields: `test_lab VARCHAR`, `accreditation_number VARCHAR`, `test_date DATE`, `test_scope TEXT`. Only populated when `category = 'test_report'`. No new table — these extend the existing row.  
2. **`component_clause_evidence`** — the bridge table:  
   - `id`, `organization_id NOT NULL`  
   - `component_version_id FK → bom_component_versions`  
   - `clause_id FK → standard_clauses`  
   - `document_version_id FK → document_versions` (the test report or declaration — must already exist in the document library)  
   - `evidence_type` ENUM: `lab_test_report | supplier_declaration | self_assessment | cert_of_conformity | type_approval`  
   - `coverage_scope TEXT` — what this evidence specifically demonstrates (e.g. "insulation resistance at 500V DC per clause 8.3.1")  
   - `status` ENUM: `valid | pending_retest | superseded | withdrawn`  
   - `reviewed_by UUID FK → users`, `reviewed_at TIMESTAMPTZ`  
   - `created_at`, `created_by`  
   - Unique on `(component_version_id, clause_id, document_version_id)`  
3. **Postgres trigger on `bom_component_versions` INSERT** — when a new version row is created for a component, SELECT all `valid` evidence rows with `evidence_type = 'lab_test_report'` for the previous version of that component and INSERT copies for the new version with `status = pending_retest`. Other evidence types (supplier_declaration, self_assessment, cert_of_conformity, type_approval) are NOT copied — they remain on the previous version only and must be explicitly re-linked if still applicable. Lab test reports are revision-specific; the others are evaluated case by case.  
4. **API actions:** `addComponentEvidence`, `updateEvidenceStatus`, `getComponentEvidence` (all evidence for a component version), `getClauseEvidence` (all component versions covering a clause), `listPendingRetest` (all `pending_retest` rows for the org — the re-test work queue), `dismissPendingRetest` (marks a specific evidence as `valid` again with a reason — for when the component change was irrelevant to that test).  
5. **Compliance portal integration — clauses view:** new "Component evidence" column on the standard clauses table. Shows a green tick (all linked component versions have `valid` evidence), amber warning (`pending_retest` exists), or blank (no component evidence — clause is covered at the document/product level only). Click the badge → evidence chain modal: component version → evidence type → test lab → test date → document.  
6. **BOM integration — component detail panel:** "Requirements covered" section lists every clause this component version has evidence for, with status badge and link to the evidence document. The lifecycle status transition `approved → released` surfaces a warning if any linked clause has `pending_retest` evidence (but does not block — engineer decides).  
7. **Re-test work queue view** — a dedicated panel (accessible from both the compliance tab and the BOM tab) listing all `pending_retest` evidence rows, grouped by component, with inline action to upload a new test report, link it, and mark as resolved.

**Tables involved:**  
New: `component_clause_evidence`  
Extended: `component_documents` (add test-report fields), `bom_component_versions` (trigger added)  
Read: `standard_clauses`, `document_versions`, `bom_component_versions`, `as_operates_interpretations` (for side-by-side display)  
All new tables: `organization_id NOT NULL FK → organizations` (PROP-012 contract)

**Effort estimate:** 28–36 hours  
- Schema + migration (`component_clause_evidence`, extend `component_documents`): 4 h  
- Postgres trigger (retest copy on new version): 3 h  
- API actions (6 new actions): 10 h  
- Compliance portal UI — clause evidence column + modal: 8 h  
- BOM UI — "requirements covered" section on component detail: 5 h  
- Re-test work queue view: 6 h  
- Tests: 4 h

**Risks:**  
- **Evidence explosion / noise:** A product may have 30 standards × 100+ clauses. Most clauses are not tested at the component level — they are evidenced by a product-level document (the DoC, the Technical File). Adding the component column to every clause would be mostly blank and confusing. Mitigate: only show the "Component evidence" column when at least one evidence row exists for clauses in that standard. Alternatively, let clauses be tagged `component_linked` (boolean) to opt in.  
- **Scope confusion with `as_operates_interpretations`:** An `as_operates_interpretations` row says "document version D interprets clause C as compliant." A `component_clause_evidence` row says "component version V is the physical thing tested to satisfy clause C, as evidenced by document D." These are different but both end up pointing at a clause. The UI must present them as complementary, not competing.  
- **Retest dismissal accountability:** `dismissPendingRetest` requires a written reason and is logged in `platform_audit` — this is the CE liability paper trail. MVP: single reviewer can dismiss (the person doing the assessment). Design for multi-reviewer later: the `component_clause_evidence` table should include a nullable `second_reviewer_id FK → users` and `second_reviewed_at` from day one, left null in the MVP. When the second-reviewer gate is activated, `dismissPendingRetest` sets status to `pending_second_review` (not directly to `valid`), and a second action `confirmRetest` finalises it. The enum status set must include `pending_second_review` in the schema even if the MVP never enters it.  
- **Test report traceability to storage:** A test report in `component_clause_evidence` references a `document_versions` row, which has a `storage_path` in the `documents` bucket. The upload flow for a test report (via the PIS component detail panel) must ensure the file ends up in the right bucket with a signed URL, same as the existing document upload flow.  
- **Cross-compliance scope:** A single test report (e.g. a combined LVD + EMC test report from a lab) may cover multiple clauses across multiple standards for the same component. `component_clause_evidence` supports this naturally — one `document_version_id` can appear in multiple rows with different `clause_id` values. The UI must make this easy to batch-link (select a test report, then tick all clauses it covers).

**Related PROPs:**  
- PIS / Vertical Integration Engine idea (above) — depends on `bom_component_versions` existing  
- PROP-001 (Level 2 / Passports — the `product_passports` DPP will eventually pull the full component evidence chain for ESPR Article 7 technical documentation)  
- PROP-011 (Requirement Links — `requirement_links` links text units to text units; `component_clause_evidence` links physical objects to requirements; complementary, not overlapping)  
- PROP-012 (Multi-tenancy — `organization_id` on all new tables; test reports are highly confidential per-tenant data)

**Status:** Raw idea

---
### Configure-to-Order Variant BOM (Product Families) — 2026-08-28
**One sentence:** Replaces the single-product BOM root with a Product Family node that defines configuration attributes (Size, Power, Color…), then uses conditional edges in the BOM tree to express which components are included for which combination — so one tree serves thousands of configurations without duplication.

**Problem it solves:**  
Rushroom sells configurable LED furniture: the same family ships in multiple sizes, power ratings, colors, and mounting options. With the current BOM model, every distinct configuration would need its own complete tree — hundreds or thousands of trees, all nearly identical. A single component change (e.g., new LED strip for 50 W variants) would require updating each affected tree separately, with no mechanism to check that all variants were covered. There is also no machine-readable record of which configurations share a given component, making REACH/RoHS impact analysis impossible.

The configure-to-order model solves this by storing ONE tree per product family and marking edges as either unconditional (present in all configurations) or conditional (only included when a specific attribute value is selected). The resolved BOM for any specific configuration is computed on demand — no duplication.

**Architecture: Super BOM with conditional edges**  
An edge in `bom_edges` with `variant_condition = NULL` is always included. An edge with `variant_condition = '{"Power": "50W", "Size": "L"}'` is included only when the selected configuration matches all listed conditions. `resolveVariant(family_id, selections)` runs the normal BFS but filters edges by condition match.

This means: N attributes × M values each = potentially M^N configurations, but only ONE BOM tree to maintain. Engineers author and version the family BOM; sales or compliance teams "configure" it to get a specific product BOM for a specific order or DoC.

**MVP scope:**  
1. **`bom_components.type` extension** — add `product_family` to the type enum (migration). A family node is always a root (no parent edge). UI treats it differently from `Product` (shows attribute panel instead of cost canvas).  
2. **`family_attributes`** — one row per configurable dimension per family: `{id, organization_id, family_id FK→bom_components, name, display_name, is_required BOOLEAN, sort_order}`. Example: `{name: "Power", display_name: "Power rating", is_required: true}`.  
3. **`family_attribute_values`** — valid options per attribute: `{id, organization_id, attribute_id FK→family_attributes, value, label, sort_order}`. Example: `{value: "30W", label: "30 W"}`, `{value: "50W", label: "50 W"}`.  
4. **`bom_edges.variant_condition JSONB` column** (nullable, migration, backward-compatible) — `NULL` = always included; `{"Power": "50W"}` = only when Power=50W is selected; multiple keys = all conditions must match (AND logic).  
5. **`saved_configurations`** — named resolved configurations: `{id, organization_id, family_id FK→bom_components, name, selections JSONB, description, created_by, created_at}`. Example: `{name: "Standard EU 50W White L", selections: {"Power": "50W", "Color": "White", "Size": "L"}}`. These are the units that get their own part number, DoC, and compliance record.  
6. **API actions:**  
   - `addFamilyAttribute(family_id, name, display_name, is_required)` / `listFamilyAttributes(family_id)`  
   - `addFamilyAttributeValue(attribute_id, value, label)` / `listFamilyAttributeValues(attribute_id)`  
   - `resolveVariant(family_id, selections JSONB)` — runs BFS on the family BOM, filters edges where `variant_condition IS NULL OR variant_condition <@ selections`, returns the effective component tree for that configuration  
   - `saveConfiguration(family_id, name, selections)` / `listConfigurations(family_id)` / `deleteConfiguration(id)`  
   - `addBomEdge` — extended to accept optional `variant_condition JSONB`  
7. **UI changes (Product tab):**  
   - A `product_family` root shows a "Configuration" sub-tab (attributes + valid values, editable).  
   - The `+ child` modal gets an optional "Only for configurations…" section (attribute value picker, multi-select, generates `variant_condition`).  
   - A "Configure" button on the family row opens an attribute selector; on submit, calls `resolveVariant` and renders the resulting filtered BOM tree in a read-only preview pane. An option to save this as a named configuration.  
   - The BOM tree visually distinguishes conditional edges (dashed line / grey badge showing the condition) from unconditional edges.

**Tables involved:**  
New: `family_attributes`, `family_attribute_values`, `saved_configurations`  
Extended: `bom_components.type` enum (add `product_family`), `bom_edges` (add `variant_condition JSONB` column)  
All new tables: `organization_id NOT NULL FK → organizations`

**Effort estimate:** 28–36 hours  
- Migration (enum + column + 3 new tables): 4 h  
- API actions (6 new + extend addBomEdge): 8 h  
- `resolveVariant` BFS filter logic: 4 h  
- UI — attribute definition panel on family node: 5 h  
- UI — conditional edge picker in `+ child` modal: 4 h  
- UI — Configure button + resolved BOM preview: 7 h  
- UI — saved configurations list + part-number generation per config: 4 h  
- Tests: 4 h

**Risks:**  
- **Condition logic complexity:** AND-only conditions (all keys must match) cover most real cases. OR logic (this edge is active for 30W OR 50W) requires a different schema (array of condition objects or a conditions_any_of array). Design the schema to allow this extension: `variant_condition = [{"Power": "30W"}, {"Power": "50W"}]` as an array means OR; a plain object means AND. MVP: only implement plain object (AND); leave array (OR) for later.  
- **Compliance implication per configuration:** Each `saved_configuration` is a distinct CE product (distinct DoC, distinct Technical File, distinct test scope). The system must eventually generate a per-configuration DoC and propagate compliance evidence from the family's shared components. This connects directly to PROP-014 (Component Evidence Bridge) — `component_clause_evidence` must be resolvable per configuration, not just per component.  
- **COGS per configuration:** `computeCogs` currently takes a `root_component_id`. It must be extended to accept optional `selections` so it rolls up cost only for components in the resolved variant BOM. Without this, cost simulation is meaningless for families.  
- **Part numbers on configurations:** A saved configuration needs its own part number or sales code (e.g., `RR-2026-L50W-WH`). This is separate from the family's part number and from the component part numbers inside the BOM. Design: `saved_configurations` gets an optional `part_number` column (unique per org), auto-suggested by the UI, overridable.  
- **Migration of existing BOM roots to Product vs. product_family:** Existing `Product` type roots stay as-is — they are single fixed configurations. Only explicitly created `product_family` nodes get the attribute/variant behavior. The distinction is opt-in.  
- **Variant condition validation:** When a user adds a `variant_condition` to an edge, the system should validate that all keys in the condition correspond to known `family_attributes.name` values for the ancestor family. The MVP can do this client-side; a DB constraint can be added later.

**Related PROPs:**  
- PROP-013 (Product Information System — provides the BOM foundation; this extends it without breaking existing single-product BOM trees)  
- PROP-014 (Compliance–BOM Integration — each resolved configuration is the unit that needs component clause evidence and a DoC; the evidence bridge must be variant-aware)  
- PROP-012 (Multi-tenancy — all new tables carry `organization_id`; configuration data is per-tenant and should never be cross-org visible)

**Status:** Raw idea

---
### BOM Tree — Add Sibling shortcut button — 2026-08-29

**One sentence:** Add a "+ sibling" button next to each non-root BOM row so users can add a peer node without having to locate and click the parent's "+ child" button.

**Problem it solves:** Multiple children per parent is already fully supported in the data model and API — but users don't discover it. The natural expectation is a button at the same visual level as the node you want to peer with. Currently the only way is to scroll back up, find the parent row, and click its "+ child" button.

**MVP scope:** On every non-root row, render a small "+ sibling" button alongside the existing row actions. Clicking it calls `openAddChildModal` with the **parent** of the current node as the target. No new API actions, no schema changes — pure frontend, reusing the existing `addBomEdge` flow. The parent ID is already available in the edge data loaded by `getBom`.

**Tables involved:** bom_edges, bom_components — existing, no changes needed.

**Effort estimate:** 1–2 hours (frontend only).

**Risks:** The row action area already has up to four buttons (+ child, ⚙ Configure, Details, Delete). A fifth button may crowd narrow viewports — may need icon-only style or an overflow menu for small screens.

**Related PROPs:** PROP-013 (BOM tree foundation).

**Status:** Raw idea

---
### BOM Tree UX Polish — column alignment, expand/collapse, action cleanup — 2026-08-29

**One sentence:** Fix column misalignment, add Expand All / Collapse All toolbar buttons, always show QTY, and compact the per-row action buttons so the tree is immediately readable.

**Problem it solves:** Looking at the current tree (see screenshot 2026-08-29):
- QTY shows nothing when qty=1, so the column looks broken — users don't know if quantity data is missing or just defaulted.
- STATUS badges drift slightly out of alignment because the grid column widths don't account for the tree connector varying in width at depth.
- There is no single-click way to collapse or expand the whole tree — users have to click each ▼ toggle individually on large BOMs.
- Four action buttons per row (+ sibling, + child, Details, Delete) make rows wide and visually noisy. On a 10-level BOM with 50 nodes this is overwhelming.
- The column headers (POS. / COMPONENT / QTY / STATUS / COGS) are not sticky, so they scroll off on long trees.

**MVP scope (4 specific changes):**
1. **Always show QTY** — display "1" instead of empty when qty = 1.
2. **Expand All / Collapse All** — two small buttons in the BOM Tree toolbar, next to Refresh. "Expand All" clears the collapsed Set; "Collapse All" adds every posNum with children to it.
3. **Sticky column header row** — make the POS / COMPONENT / QTY / STATUS / COGS header row `position: sticky; top: 0` so it stays visible while scrolling.
4. **Compact action buttons** — replace text labels with short symbols or a tighter layout: "⊕" (sibling), "↳" (child), "≡" (details), "✕" (delete) with tooltip titles. Or keep labels but reduce font size and padding further.

**Tables involved:** None — frontend only.

**Effort estimate:** 2–3 hours.

**Risks:** Compact icon-only buttons must still be accessible (aria-label). Sticky header requires knowing the offset from the subtab bar — use the existing `--header-h` CSS variable pattern already in the codebase.

**Related PROPs:** PROP-013 (BOM tree), PROP-016 (sibling button — already built, its button is one of the ones to compact).

**Status:** Raw idea

---
### Dynamic BOM — Order-Driven Configuration Import — 2026-08-29

**One sentence:** Rename "product_family" to "Dynamic BOM", deprecate in-portal configuration pre-building, and instead import a specific customer order's resolved BOM from the external storefront configurator — so compliance is tracked per concrete, ordered configuration rather than per hypothetical variant.

**Problem it solves:** PROP-015 assumes configurations are built and stored in the compliance portal ahead of time. In reality, Rushroom's 5m wardrobe system has 5,000+ possible configurations — the vast majority of which will never be ordered. Pre-building them in the portal wastes effort and creates phantom compliance records for products that don't exist. More importantly, compliance management must anchor to real orders: a specific customer received a specific configuration, and that configuration's components must be traceable to CE declarations, test reports, and regulatory requirements. The current model cannot do this — it tracks abstract families, not real shipped products.

**Real workflow:**
1. Customer configures a wardrobe on the storefront → order is created in the order system
2. The order system resolves the Dynamic BOM for that order (same logic as the bulk render pipeline already in Rushroom's stack)
3. The compliance portal imports that resolved BOM as a concrete configuration — linking to the component records already registered here
4. Compliance evidence (DoC, test scope, REACH declarations) is tracked against that concrete configuration

**MVP scope:**
- Rename the `product_family` type concept to "Dynamic BOM" in the UI (label change only, keep `product_family` in the DB as the type key until the full rework)
- Add a read-only "Imported Configurations" sub-view under a Dynamic BOM root that shows concretely ordered configurations (imported, not manually created)
- Build a `POST /importConfiguration` API action that accepts a minimal payload: `{ family_id, external_order_id, selections: { attr: value, … }, resolved_component_ids: [uuid, …] }` and creates a `saved_configuration` record linked to those component IDs
- Display the imported configuration as a flattened BOM with all component links resolved from the portal's own `bom_components` table

**What must be learned first (blocker):**
The exact shape of the external order system's Dynamic BOM payload is unknown. Before building the import endpoint, Rushroom must extract one real order from the order system and document: which fields identify a component, what the configuration selection looks like as a data structure, and whether the component IDs match the portal's part numbers or OEM numbers. This is the master data / ID alignment problem — the portal uses `part_number` and `oem_number`; the order system may use something entirely different.

**Tables involved:** `bom_components` (existing — the component registry), `bom_edges` (existing — tree structure), `saved_configurations` (existing — stores named configs), potentially a new `configuration_imports` table to track the external order ID, import timestamp, and raw payload for audit purposes.

**Effort estimate:** 2–4 hours for the import endpoint + UI, once the payload shape is known. Investigation/alignment of IDs with the external system: unknown — could be 0.5 hours or several days depending on data quality.

**Risks:**
- Component IDs / part numbers may not match between the order system and the compliance portal — requires a mapping layer or enforced shared master data
- The external Dynamic BOM may include components not yet registered in the compliance portal — the import must either fail gracefully or auto-register stubs for unknown parts
- The concept of "specific configuration" may not map cleanly to the portal's tree structure if the external BOM uses a flat list rather than a hierarchy
- Deprecating in-portal configuration building means PROP-015's configure modal and attribute/value tables become secondary tools (useful for exploration only, not for compliance records)

**Related PROPs:** PROP-015 (the in-portal variant BOM that this partially supersedes), PROP-013 (BOM tree foundation — components already registered here), PROP-014 (Compliance–BOM Integration — evidence must eventually be per concrete configuration, not per abstract family)

**Status:** Raw idea — blocked on learning the external order system's Dynamic BOM payload format

---
### Platform Architecture Map — BOM as Shared Backbone — 2026-08-29
**One sentence:** Define which domain belongs in which system before building further, so the BOM component registry in the compliance portal becomes the deliberate single source of truth for component master data — rather than each system growing its own copy.
**Problem it solves:** The BOM is already being used by three separate contexts: (1) compliance portal for regulatory tracing, (2) storefront configurator (colleagues) for customer-facing product configuration, (3) future operational systems (goods received, QC, order planning, picking, delivery, installation sequencing). Without a platform boundary decision, each team will build its own component registry, the IDs will diverge, and retroactive integration will be painful. COGS/financial analysis in the compliance portal is already an early symptom — it was built here because the BOM was here, not because compliance is the right home for financial data.
**MVP scope:** A written platform boundary decision (not code) that answers: which system owns which domain, what is the interface between them (API contract vs shared DB vs import), and what data lives where. The smallest deliverable is a decision record in DECISIONS.md and a platform map diagram in SYSTEM_OVERVIEW.html Section 1 (or a new Section 0.5). No code changes — this is architecture-first.
**Proposed domain map:**
- **Compliance portal (this system):** component registry (bom_components as shared master), BOM structure (bom_edges), regulatory compliance evidence, standards, declarations, REACH/RoHS at component level, document management, DPP. Acts as the parts library that other systems reference.
- **Storefront / order system (colleagues):** customer-facing product configurator, Dynamic BOM resolution per order, pricing, order management. Consumes component IDs from the compliance portal but does not own the component records.
- **Future operational system:** goods received, QC checks, order planning, picking, delivery planning, installation sequencing. Will be built on the BOM from the compliance portal — reads component and edge data, adds operational state (stock, location, sequence).
- **Engineering PLM (future, separate):** tolerances, dimensional specs, test routines, drawings, ECO (engineering change orders). Likely a dedicated tool (OpenBOM, Arena, or custom). Links to compliance portal via component part number as the shared key.
- **Financial analysis / ERP (future, separate):** product-level P&L, COGS simulation, landed cost, margin analysis. NOT in the compliance portal — the portal's COGS tables (component_costs, landed_cost_factors, cost_scenarios, cogs_snapshots) are candidates for removal or migration to an ERP once that system exists.
**Tables involved:** No new tables. Existing tables under review for potential removal/migration: component_costs, landed_cost_factors, cost_scenarios, scenario_overrides, cogs_snapshots (all PROP-013 financial tables). The Cost Canvas subtab is the UI surface of these.
**Effort estimate:** 2–4 hours for the platform map document + decision record. Code cleanup (removing COGS tables) is a separate decision and effort.
**Risks:** Removing COGS tables breaks the Cost Canvas UI and any data already entered — migration path needed. Keeping them creates ongoing maintenance cost and source-of-truth confusion. The component registry becoming the shared parts library requires that the order system and future operational systems agree to use compliance portal part_numbers/oem_numbers as the canonical ID — this is a master data governance decision that requires alignment across all teams.
**Related PROPs:** PROP-013 (built the cost/financial layer now in question), PROP-018 (Dynamic BOM import from order system — assumes ID alignment). This idea is a prerequisite to PROP-018 going well.
**Status:** Raw idea — needs cross-team discussion before any code decision

---
### Product List — Split by Type (Components / Assemblies / Dynamic BOMs) — 2026-08-29
**One sentence:** Replace the flat product list with three client-side tabs — Components, Assemblies, Dynamic BOMs — so each type has its own sorted group and newly created items surface in the right place immediately.

**Problem it solves:** The product list currently mixes isolated components (type: Component / SparePart / Refurb), product assemblies (type: Product, has BOM children), and Dynamic BOM families (type: product_family) in one unsorted flat list. When a user creates a new component via "+sib" in an embedded BOM, it lands at the bottom of this mixed list — invisible without scrolling. As the registry grows, finding any specific item becomes a scan. Splitting by type group removes the ambiguity, puts new items in a predictable place, and makes the intent of each entry immediately clear (part vs. product vs. family).

**MVP scope:** Client-side tab filter on the product list — same `getBom` / list API call, rendered into three tabs:
1. **Components** — `type IN (Component, SparePart, Refurb)` — the parts library; newly created nodes from "+sib" land here
2. **Assemblies** — `type = Product` — products with BOM trees; the compliance-relevant structured products
3. **Dynamic BOMs** — `type = product_family` — configure-to-order family templates
Each tab sorts alphabetically by name. The tab with newly created items is auto-selected after creation so the user lands on it. No schema changes, no new API actions — pure frontend.

**Tables involved:** `bom_components` — existing, no changes needed.

**Effort estimate:** 2–3 hours (frontend only).

**Risks:**
- A `Component` type node CAN be the root of a sub-assembly (it has children in `bom_edges`). The split is by `type` field, not by whether it has children — this may surprise users who expect "Assemblies" to mean any node with children. Mitigation: keep the label as "Components" (not "Parts") and document that moving a node to "Product" type signals it is a top-level finished product.
- Users accustomed to searching one flat list may miss the tab split on first use. Mitigation: show a badge count per tab, and default to the most-used tab (likely Components).
- The create-new-node flow (both from the modal and from "+sib") must know which tab to switch to after creation, based on the type selected in the form.

**Related PROPs:** PROP-013 (BOM tree foundation), PROP-015 (Dynamic BOM / product_family type — lands in its own tab), PROP-016 ("+sib" button — the trigger for this idea).

**Status:** Raw idea

---
### Component Document Lifecycle — Upload, Versioned Linking, AI Diff, Data Extraction — 2026-08-29
**One sentence:** Make component documents first-class objects with direct upload from the component panel, explicit revision tracking, AI-powered diff when a document is updated, and structured data extraction so test specs and substance declarations live in the database — not just as PDF attachments.

**Problem it solves:**
The current flow has four gaps:

1. **Friction to upload:** You must go to the As Operated tab, upload the file there, then come back to the BOM Node and link it. When you have a test report for a specific component, the natural place to upload it is the component panel.

2. **No revision signal:** `component_documents` links a document version to a component by `component_id` only — not to a specific component revision. When the component bumps from Rev B → Rev C, the old test reports stay linked with no flag that they may no longer apply to the new revision.

3. **No AI diff on document update:** When a new version of a linked document is uploaded, there is no summary of what changed — the user must read both PDFs manually. The As Operated tab already does this via AI (deviation scan / interpretation diff) — the same pattern should apply here.

4. **Data stays locked in PDFs:** In other parts of the portal, documents are "read in" — clauses into `standard_clauses`, interpretations into `as_operates_interpretations`, statements into `document_statements`. Component documents are not. A test report with a pass/fail result, lab accreditation, and test scope is just an opaque attachment.

**MVP scope — four layers, each independently shippable:**

**Layer 1 (2–3 h) — Direct upload from component panel:**
Add a "+ Upload & link" tab to the "Link document" modal. Calls existing `uploadDocument` + `addDocumentVersion` actions, then immediately links via `addComponentDocument`. No new DB tables. Document also appears in As Operated — nothing siloed.

**Layer 2 (3–4 h) — Revision-aware document validity:**
Add `component_revision TEXT` (populated at link time) and `needs_review BOOLEAN DEFAULT FALSE` to `component_documents`. When `addBomVersion` creates a new component revision, the edge function sets `needs_review = TRUE` on all prior-revision documents. UI shows amber "⚠ Review for Rev C" badge. User dismisses per-document with a reason logged to `bom_component_history`.

**Layer 3 (4–6 h) — AI diff when updating a document link:**
When the selected document version is a newer version of a document already linked to the component, the modal shows an AI-generated "What changed?" bullet list — calls `diffComponentDocumentVersions` using Haiku comparing two PDF texts. Reuses the same two-PDF comparison pattern already in the deviation scan.

**Layer 4 (8–12 h) — Structured data extraction:**
Per category, AI extracts key fields from the PDF and populates structured tables:
- `test_report` → test lab, accreditation number, test scope, test date, pass/fail → nullable columns on `component_documents` (aligns with PROP-014)
- `declaration` (REACH/RoHS) → substance list → upserts into `component_materials` with `source = 'declaration'`
- `datasheet` → key specs (voltage, current, power, temp range) → new `component_specs` table
All extractions shown for user review before saving — never auto-commit.

**Tables involved:**
Existing (extended): `component_documents` (add `component_revision`, `needs_review`, test-report fields), `component_materials` (declaration extraction)
New (Layer 4 only): `component_specs`: `{id, organization_id NOT NULL FK→organizations, component_id FK→bom_components, spec_name, spec_value, spec_unit, source_document_version_id FK→document_versions, created_at}`

**Effort estimate:** 17–25 h total (Layer 1: 2–3 h, Layer 2: 3–4 h, Layer 3: 4–6 h, Layer 4: 8–12 h). Each layer ships independently.

**Risks:**
- PDF extraction quality: Layer 4 depends on text-readable PDFs — scanned images will fail. Surface extraction failures clearly; raw PDF stays authoritative.
- needs_review noise: Frequent component revisions create constant amber warnings. Mitigate by only flagging `test_report` and `declaration` categories, not datasheets.
- Two revision axes: `component_revision` (which component rev the doc covers) vs. document version number. Must be clearly labelled in the UI to avoid confusion.
- Layer 4 accuracy: all AI-extracted data shown for user review before saving — never auto-commit.
- PROP-012: all new tables carry `organization_id NOT NULL`; extractions run server-side only.

**Related PROPs:**
- PROP-014 (Compliance–BOM Integration — Layer 2's revision validity is a lighter version of the `component_clause_evidence` pending_retest pattern)
- PROP-013 (PIS foundation — `component_documents` and `component_materials` defined here)
- PROP-011 (Requirement Links — `document_statements` is the established "read into DB" pattern this extends to component docs)
- PROP-012 (Multi-tenancy — `organization_id` required on `component_specs`)

**Status:** Raw idea — Layer 1 ready to build; Layers 2–4 depend on PROP-014 decisions

---
### Component Lifecycle Status — Rebuild as Active / Inactive / Replaced / Flagged — 2026-08-30
**One sentence:** Replace the six-stage engineering lifecycle (concept → specified → sourcing → approved → released → obsolete) with four operational states that reflect how Rushroom actually thinks about component health.

**Problem it solves:** The current statuses (`concept`, `specified`, `sourcing`, `approved`, `released`, `obsolete`) are engineering-phase markers borrowed from PLM software. They answer "where is this in the development pipeline?" Rushroom needs statuses that answer "what is this component's operational standing right now?" — and the new four-state model maps directly to decisions users actually make.

**The four states and their meaning:**
- **Active** — in production, currently sold/used. The default healthy state.
- **Inactive** — registered but not yet active: under development, under regulatory assessment, in procurement hold, not yet approved for production, or simply parked for future use. This is the "anything that isn't active yet" catch-all.
- **Replaced** — retired or superseded. Critically: replacement is NOT 1:1. A single component may be replaced by a completely re-engineered 3-part sub-assembly, or merged into a larger unit. A free-text `replacement_note` field captures the "what replaced it and why" narrative. Optionally: a `replacement_component_ids UUID[]` for when the successors are also in the registry.
- **Flagged** — needs attention NOW: a compliance concern, supplier quality issue, regulation change, pending re-assessment, or any user-defined alert. A `flag_reason` text field captures the specific concern. Flagged components should be visually prominent (red) and ideally surface in the Status Overview as a separate call-out.

**Migration from existing values:**
- `concept` → `inactive`
- `specified` → `inactive`
- `sourcing` → `inactive`
- `approved` → `active`
- `released` → `active`
- `obsolete` → `replaced` (best-guess default; user can correct)

**MVP scope:**
1. DB migration: add `replacement_note TEXT` + `flag_reason TEXT` columns to `bom_components`; UPDATE rows to map old values; update the CHECK constraint (if one exists) to new four values.
2. Backend `setComponentStatus`: new valid set `["active","inactive","replaced","flagged"]`; accept `replacement_note` and `flag_reason` in the same call.
3. Frontend `LIFECYCLE_COLORS`: 4 colors — `active=#2fa564`, `inactive=#8b93a1`, `replaced=#f59e0b`, `flagged=#e05454`; `STATUS_COLOR` in `bomTreeView` updated to match.
4. Component detail panel: status dropdown with 4 options; `replacement_note` text input appears when "Replaced" selected; `flag_reason` text input appears when "Flagged" selected.
5. Status Overview: update the `lcOrder` counter list to the 4 new statuses; "Flagged" bar shown first (or as a highlighted call-out) since it signals action required.

**Tables involved:** `bom_components`, `bom_component_history` (audit trail captures the transition — no schema change there)

**Effort estimate:** ~2 hours (migration + backend + frontend, no new tables)

**Risks:**
- If a CHECK constraint exists on `lifecycle_status` in Postgres, it must be dropped and re-added in the migration — otherwise the `UPDATE` to new values will fail.
- Old `bom_component_history` rows will contain legacy status values (`concept`, `released`, etc.) — these are historical snapshots and should be left as-is; the UI changelog reads them verbatim.
- The `updateComponent` action (which patches many fields) does NOT currently update `lifecycle_status` — this is intentional (`setComponentStatus` is the dedicated path). Keep this separation.
- Migration must be applied BEFORE deploying the backend, or the validation will reject the new status values in the window between deploy and migration.

**Related PROPs:** PROP-013 (introduced lifecycle_status), PROP-022 (BOM list — STATUS_COLOR must be updated there too)

**Status:** Raw idea

---
### Component Version History — Full State Access Per Revision — 2026-08-30
**One sentence:** Make each component revision a complete, inspectable historical record — documents, materials, spec summary, and description — not just a timestamp and a note.

**Problem it solves:**
Right now, bumping a version produces a row in the Versions table that says "Revision B — something changed — 2026-08-30." That's all. You cannot click into Rev B and see what documents were attached, what REACH/RoHS materials were declared, or what the description said. If Rev C is current, the Rev B state is effectively gone from the UI.

This matters for compliance: a test report linked to a component at Rev A may no longer apply at Rev C. A regulator or auditor asking "what was the component specification when you submitted the CE declaration in June?" should get a complete answer — not "it was Rev B, good luck."

The data to reconstruct history exists in the DB (documents and materials are linked to `component_id`), but there is no version-scoped query and no snapshot is taken at bump time. The timestamps on `component_documents` could theoretically be used to reconstruct what existed "before the bump" but this is brittle and not exposed in the UI.

**What already exists that could be extended:**
- `bom_component_versions` — the revision record, currently just `revision, spec_summary, is_current, created_at`
- `bom_component_history` — field-level snapshots of component metadata fields (part_number, name, description, lifecycle_status, etc.) written by Postgres triggers — but does NOT include documents or materials
- `component_documents` — links documents to `component_id`, no `component_version_id`
- `component_materials` — links substances to `component_id`, no `component_version_id`
- The Versions table UI renders all revisions — rows just aren't expandable yet

**MVP scope:**
1. **Migration:** Add `version_snapshot JSONB` column to `bom_component_versions`. Default NULL (backward compat — existing rows stay null, UI handles gracefully).
2. **Backend — `bumpComponentVersion`:** Before inserting the new version row, fetch the current component state and store it as the snapshot on the NEW row being inserted: `{ spec_summary, description, notes, lifecycle_status, documents: [{doc_name, version, category, label}], materials: [{substance_name, cas_number, percentage_w_w, reach_svhc, rohs_restricted}] }`. This captures "what existed when this revision was created" — i.e. the incoming state, not the outgoing.
   - Alternative (simpler read): fetch and store snapshot on the PREVIOUS version row (update its `version_snapshot` to capture what it held before being retired). Either approach works; storing on the new row is more consistent with immutability.
3. **Backend — `getComponentHistory`:** Include `version_snapshot` in the SELECT.
4. **Frontend — Versions table:** Clicking a revision row expands it inline (accordion) to show: spec summary, description/notes (from snapshot or from current `bom_component_history`), linked documents at that revision, materials at that revision. For rows with `version_snapshot = null` (created before this feature), show "Snapshot not available for this revision."
5. **No new tables.** No change to `component_documents` or `component_materials` schema.

**Tables involved:**
- `bom_component_versions` (add `version_snapshot JSONB` column — migration required)
- `bom_component_history`, `component_documents`, `component_materials` — read-only at bump time to build the snapshot

**Effort estimate:** 6–10 hours
- Migration (1 column): 0.5 h
- Backend snapshot fetch + store in `bumpComponentVersion`: 2 h
- Backend `getComponentHistory` update: 0.5 h
- Frontend expandable version rows + snapshot renderer: 3–6 h

**Risks:**
- **Snapshot timing:** Storing the snapshot on the NEW version row captures "what exists when this revision started" — documents and materials added AFTER the bump but before the next bump will not be in any snapshot. This is acceptable for the MVP; a more accurate approach (snapshot the outgoing state on the OLD row) requires an UPDATE to a row that was just retired, which conflicts with immutability conventions. Document this limitation clearly in the UI.
- **Snapshot size:** A component with 20 documents and 50 substance rows could produce a large JSONB blob. In practice Rushroom's components are small; for future-proofing, limit snapshot to name/version/category per document (not the full doc content) and key fields per material.
- **Backward compatibility:** Rows created before this feature have `version_snapshot = null`. The UI must handle this gracefully with a "snapshot not available" placeholder — not an error.
- **PROP-021 Layer 2 interaction:** PROP-021 Layer 2 proposes `needs_review BOOLEAN` on `component_documents` to flag documents after a bump. That is a live-state flag; this idea is a historical record. They are complementary and do not conflict.

**Related PROPs:**
- PROP-013 (PIS — `bom_component_versions`, `component_documents`, `component_materials` defined here)
- PROP-021 Layer 2 (revision-aware document validity — a lighter live-state flag; this idea adds the historical record layer)
- PROP-014 (Compliance–BOM Integration — test report evidence must be traceable to a specific component revision; this snapshot is the foundation for that traceability)

**Status:** Raw idea

---
### Component Images — Paste, Drop, or Pick from Disk — 2026-08-30
**One sentence:** Add a photo gallery to each component's detail panel, with Ctrl/Cmd+V clipboard paste as the primary upload method alongside file drop and file picker.

**Problem it solves:**
A part number and a name tell you what something is called. A photo tells you what it actually looks like — which connector type, which side the mounting holes are on, whether it is the version with or without the blue stripe. Right now there is no way to attach any visual reference to a component. Engineers working on compliance or assembly verification have to search part numbers in separate tabs or open spec PDFs just to confirm they are looking at the right part.

Clipboard paste is the killer feature here: take a screenshot of a component in a datasheet (Cmd+Shift+4 on Mac), switch to the portal, and Cmd+V drops it straight into the component. No export, no file picker, no rename. This is how Notion, Linear, and Figma handle it — it should work here too.

**What already exists that could be extended:**
- Supabase Storage is already live (`documents` bucket used by PROP-021)
- `uploadZone` widget already handles file-drop and file-picker UX
- Edge function already handles binary uploads to Storage with org-scoped paths
- `component_documents` table exists but is wrong for photos — it requires versioned document records (`document_versions`), which is unnecessary overhead for a visual reference image

**MVP scope:**
1. **New table `component_images`**: `id, organization_id, component_id, storage_path, file_name, content_type, uploaded_at, uploaded_by`. No versioning — images are add/delete only.
2. **Storage bucket**: use a new `component-images` bucket (or a `component-images/` prefix in the existing bucket) with org-scoped paths: `{org_id}/{component_id}/{uuid}.{ext}`.
3. **New API actions**: `uploadComponentImage` (accepts base64 data + filename + MIME type, uploads to Storage, inserts row), `listComponentImages` (returns signed URLs for all images on a component), `deleteComponentImage` (deletes from Storage and removes row).
4. **Frontend — component detail panel**: Image gallery section below the existing fields. Shows thumbnails in a 3-column grid. Click thumbnail → lightbox full-size view. Below the grid: paste zone with instruction "Paste (Ctrl+V / Cmd+V) or drop an image here", plus a "Choose file" button as fallback.
5. **Paste handler**: listen for `paste` event on the detail panel container. Check `event.clipboardData.items` for `image/*` MIME types. Convert the `DataTransferItem` to a Blob, read as base64, upload via `uploadComponentImage`. Show upload progress inline.
6. **Client-side size limit**: warn and reject if image exceeds 8 MB before upload. No server-side resize needed for MVP.

**Tables involved:**
- `component_images` (new — migration 0016)
- Supabase Storage: `component-images` bucket (new)

**Effort estimate:** 6–8 hours
- Migration + storage bucket: 0.5 h
- Backend (3 actions): 2 h
- Frontend gallery + paste handler + lightbox: 3.5–5 h

**Risks:**
- **Paste scope conflict:** A `paste` event listener on the panel could fire when the user pastes text into one of the panel's text inputs (name, description, notes). Must check that the paste event target is NOT an input/textarea before treating it as an image paste.
- **Clipboard image format:** Screenshots from macOS are PNG blobs. Images copied from a browser are sometimes `image/png`, sometimes `image/webp`. Both work fine with base64 upload. The filename should default to `screenshot-{timestamp}.png` when no filename is available.
- **Large files:** A retina screenshot can be 3–5 MB. 8 MB limit is generous enough for real use. If the user pastes a raw camera photo (20 MB+), the rejection message must be clear.
- **Signed URL expiry:** Supabase signed URLs expire. Use a generous TTL (1 hour) for the gallery view, or make the bucket policy public-read (simpler for internal tooling where all authenticated users are trusted).
- **PROP-012 multi-tenancy:** `organization_id` on `component_images`, path includes `{org_id}/` prefix in Storage. `tdb()` enforces org isolation on DB reads automatically.

**Related PROPs:**
- PROP-013 (PIS — `component_documents`, `component_materials` defined here; `component_images` follows the same tenant pattern)
- PROP-021 (Component Document Lifecycle — the upload infrastructure and `uploadZone` widget is reused; images are distinct from compliance documents)
- PROP-024 (Version History — version snapshots currently capture documents and materials; a future extension could include image references per revision)

**Status:** Raw idea
