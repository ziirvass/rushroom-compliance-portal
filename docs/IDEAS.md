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
