# Rushroom — Architectural Decisions Log
_Append-only. Claude Code appends one entry here after every /ship._

---
**Date:** 2026-07-10
**Feature:** Dev system setup
**Decision:** Converted schema.sql to 6 numbered migration files in supabase/migrations/. Seeds moved to supabase/seed.sql. organization_id backfill removed from migration path — SET NOT NULL works because tables are empty at migration time, seeds insert with organization_id supplied directly.
**Why:** Fresh databases (new customers, local dev, CI) must apply migrations then seeds in order. Embedding seeds in migrations would insert dev data into customer databases on supabase db push.
**Files changed:** supabase/migrations/0001–0006, supabase/seed.sql, supabase/schema.sql

---
**Date:** 2026-07-10
**Feature:** Migration workflow verification
**Decision:** supabase db push --local confirmed working. All 6 migration files (0001–0006) apply cleanly to a fresh database. supabase db diff --local returns "No schema changes found" — local DB matches migrations exactly. All 25 tables present and correct.
**Why:** Needed to verify the documented workflow was proven, not just correct on paper. Local Docker + Supabase CLI used as test environment before touching production.
**Files changed:** none — verification only

---
**Date:** 2026-07-10
**Feature:** Production migration verification
**Decision:** Ran supabase migration repair --status applied 0001–0006 to register existing production schema under migration tracking. supabase db diff returns "No schema changes found" against production. NOTICE about trg_forbid_org_change is expected — trigger not yet applied (ships with PROP-012).
**Why:** Production DB was built via SQL Editor before migrations existed. Repair registers history without re-running SQL against live data.
**Files changed:** none — remote state change only

---
**Date:** 2026-07-10
**Feature:** Production migration verification — correction
**Decision:** Verified trg_forbid_org_change IS present on all 16 tenant tables in production (pg_trigger query returned all 16). Correcting the prior entry: the trigger is NOT pending — it shipped with PROP-012 Stage 5a (live 2026-07-09). The "NOTICE … trigger does not exist, skipping" seen during supabase db diff was the benign DROP TRIGGER IF EXISTS in migration 0006 firing against the throwaway shadow DB, not a signal about production. "No schema changes found" already implied prod matches the migrations (trigger included).
**Why:** Keep the append-only log accurate — the prior entry could leave the impression tenant-move protection is missing from prod, when it is in fact enforced on all 16 tenant tables.
**Files changed:** none — verification only

---
**Date:** 2026-08-25
**Feature:** PROP-013 — Product Information System (Vertical Integration Engine)
**Decision:** BOM display uses BFS in TypeScript (max_depth cap of 10); COGS rollup uses a server-side PostgreSQL recursive CTE via `db.rpc("compute_bom_cogs")`. The two are deliberately separate: BFS keeps the tree-render fast and depth-bounded; the SQL CTE handles multi-level cost aggregation with scenario overrides and landed-cost multipliers in one query. Cycle detection is a Postgres BEFORE INSERT trigger (not application code), so it fires regardless of how edges are inserted. Cost/pricing actions are gated by a `COST_ACTIONS` set that 403s supplier sessions before any data is read — no per-action role check needed. The `external_ref` field on `component_costs` is reserved as an ERP sync anchor for the future bought-platform financial thread.
**Why:** A single BFS-or-CTE approach would either be slow (deep recursive BFS per page load) or fragile (client-side cost rollup diverges from server truth under concurrency). Separating display and calculation keeps both correct. Trigger-based cycle detection avoids race conditions that application-level checks would miss under concurrent inserts.
**Files changed:** supabase/migrations/0007_product_information_system.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html

---
**Date:** 2026-08-25
**Feature:** BOM Tree UX redesign + API.post() generic escape hatch
**Decision:** Added `API.post(token, action, body)` as a thin generic wrapper on the private `call()` function inside `api.js`, rather than registering 22 named methods. BOM Tree now auto-loads via a new `listComponents` action that returns all components plus `root_ids` (components with no active parent edge), eliminating the UUID-paste flow. Tree renders client-side from a parallel `getBom` fetch per root, with ▶/▼ toggle, COGS heat-map border colours, and 2-level default expansion.
**Why:** Named methods on the API object would require 22 additions to `api.js` for every new action group; a generic escape hatch keeps `api.js` stable while new action groups are prototyped. The UUID-paste UX was a prototyping shortcut — auto-detecting roots server-side (edges table query) is a single cheap query and avoids burdening the user with internal IDs. Parallel `getBom` fetches per root keep each tree self-contained and independently expandable.
**Files changed:** assets/api.js, assets/app.js, supabase/functions/portal-api/index.ts, index.html

---
**Date:** 2026-08-26
**Feature:** BOM Tree — flat DFS renderer with position numbers and ASCII connectors
**Decision:** Replaced the nested-div recursive renderer with a flat DFS walk that builds a plain array of row objects, each carrying a hierarchical position number (root = "1", children = "1.1"/"1.2", grandchildren = "1.1.1"/"1.1.2"…) and an `ancestorLastFlags` array for connector computation. Rows render as a CSS-grid table (columns: Position | Component | Qty | Status | COGS% | Actions). Collapse/expand is a `Set` of collapsed posNums; hidden rows are filtered by prefix match. ASCII connectors (├─ / └─ / │ / spaces) are computed from `ancestorLastFlags` using a fixed 3-char-per-depth prefix, displayed in a `white-space:pre` monospace span.
**Why:** The previous nested-div approach caused uncontrolled horizontal overflow at depth ≥3 and had no position numbering. A flat array + grid layout renders identically at any depth (10, 20, 50 levels) without any overflow, because indentation is expressed as a text prefix inside a fixed grid column rather than actual DOM nesting. Position numbers let users unambiguously refer to nodes by number rather than name.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md

---
**Date:** 2026-08-26
**Feature:** "+ New Product/Component" modal — mode picker + document upload + AI autofill
**Decision:** Replaced the bare `openAddComponent` form with a modal that mirrors the Standards & Regulations "Add standard" flow: optional drag-and-drop upload zone, AI reads the file via a new `suggestComponentMetadata` action (Claude with JSON-schema output; `COMPONENT_META_SCHEMA`) and fills part_number/name/type/unit_of_measure/description automatically. A mode toggle ("Parent — Product/Assembly" vs "Child — Component/Part") pre-sets the type field accordingly. Document upload is optional; users can skip it and fill fields manually. After `addComponent` creates the DB row, the uploaded file remains in the documents bucket and can be linked via the Details panel later.
**Why:** The bare form required the user to know all field values in advance. Uploading a datasheet and having the AI suggest the name/part-number is the same workflow already in use for standards, so reusing the uploadZone + AI-read pattern keeps the UX consistent and avoids a separate manual step. The mode picker makes the Parent/Child distinction explicit at creation time, since `type` (finished_good vs purchased_part) determines BOM tree role without a separate flag.
**Files changed:** assets/app.js, supabase/functions/portal-api/index.ts, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html

---
**Date:** 2026-08-26
**Feature:** BOM component delete — hard delete for admin use
**Decision:** `deleteComponent` action hard-deletes in dependency order: nulls product_passport FK → deletes scenario overrides → scenarios → COGS snapshots → component_documents links → costs → landed factors → materials → versions → all BOM edges (both parent and child directions) → component row. Children of the deleted node become top-level roots; their own sub-trees are untouched. The frontend Delete button shows a context-aware confirm dialog ("has N children → will become roots") before calling the action. No soft-delete / versioning applied at this stage as requested.
**Why:** Admin cleanup needed before the system has real data. Soft-delete would require filtering "deleted" rows everywhere and adds complexity before the data model is stable. Hard delete is simpler and reversible only via DB backup at this stage.
**Files changed:** assets/app.js, supabase/functions/portal-api/index.ts, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html

---
**Date:** 2026-08-26
**Feature:** BOM component model — OEM number, new type enum, auto-generated part numbers, UOM removed
**Decision:** Added `oem_number` column to `bom_components` (migration 0008). Type enum changed from `raw_material/purchased_part/sub_assembly/finished_good` → `Product/Component/SparePart/Refurb` — existing rows migrated. `unit_of_measure` made nullable and removed from the UI (column kept in DB for historical data). Part numbers are pre-generated client-side as `RR-YYYYMM-XXXXXXXX` (8 random chars from a 32-char unambiguous set) and can be overridden by the user or by the AI document scan; the server also generates one if the field arrives empty. `suggestComponentMetadata` now extracts `oem_number` from datasheets alongside the part number.
**Why:** OEM numbers are distinct from internal part numbers (a supplier's order code vs Rushroom's catalogue ID). Type labels needed to reflect Rushroom's actual product taxonomy rather than a generic BOM vocabulary. UOM has no practical use in this compliance context. Auto-generated part numbers remove a manual step while keeping the field editable — the format encodes creation date for rough chronological ordering.
**Files changed:** supabase/migrations/0008_bom_type_oem.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html

---
**Date:** 2026-08-27
**Feature:** PROP-013 amendment — full compliance audit trail for bom_components
**Decision:** Added `bom_component_history` table (migration 0009) with two Postgres triggers: AFTER INSERT writes the initial creation snapshot; AFTER UPDATE fires only when tracked fields actually changed (WHEN clause on `IS DISTINCT FROM` for part_number, oem_number, name, description, type, lifecycle_status, notes). Each row stores the NEW (post-change) state — i.e. "from this timestamp, the component looked like this." The `component_id` column has no FK deliberately so history rows persist even after a component is hard-deleted; this is the regulatory evidence store. The `updateComponent` action now accepts type and part_number changes (both feed the trigger). The component detail panel fetches history via `getComponentChangelog` in a parallel Promise.all and renders field-level diffs (before → after) for every event, newest first.
**Why:** Regulatory compliance for a product that ships into the EU requires an immutable chain of evidence showing what the component looked like at every point in time — especially OEM number, part number, and type, which can change when a supplier revises their product. Trigger-based capture is the correct approach: it fires regardless of which code path mutates the row (API, future admin tools, migrations), whereas application-layer logging would silently miss out-of-band changes. Each history row answers "what did this component look like from changed_at onward?" making point-in-time reconstruction straightforward for auditors.
**Files changed:** supabase/migrations/0009_bom_component_history.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md

---
**Date:** 2026-08-27
**Feature:** PROP-013 amendment — extend audit trail to revision bumps and document links
**Decision:** `bumpComponentVersion` and `addComponentDocument` never touch `bom_components`, so the AFTER UPDATE trigger never fires for them. Fixed by having both actions explicitly insert a row into `bom_component_history` after their primary write, using two new `change_type` values: `version_bumped` (notes = "Revision X: summary") and `document_linked` (notes = "Document linked: label (category)"). Migration 0010 widens the CHECK constraint on `change_type` to allow these values. The frontend Change Log renderer now handles all four event types with distinct coloured badges (green = created, blue = updated, purple = revision, amber = document) and shows the `notes` field as the change description for non-field events.
**Why:** Users expected every revision and every document attachment to appear in the change log — that is the complete audit story. The AFTER UPDATE trigger approach works only for `bom_components` field mutations; side-table events (versions, documents) require explicit application-layer writes. This is the correct split: DB triggers for field changes (catches all paths including future admin tools), application writes for associated-table events (where the semantic meaning of "what changed" must be constructed, not just captured).
**Files changed:** supabase/migrations/0010_bom_history_revision_docs.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md

---
**Date:** 2026-08-28
**Feature:** PROP-013 amendment — unified Change Log from three canonical sources
**Decision:** `getComponentChangelog` was rewritten to merge three sources in a single Promise.all: (1) `bom_component_history` filtered to `created`/`updated` only — field-level trigger snapshots; (2) `bom_component_versions` — every revision ever bumped, including those that predate the audit trail; (3) `component_documents` — every document ever linked. All three are normalised to a common shape `{changed_at, changed_by, change_type, notes, …snapshot fields}` and sorted DESC by timestamp. The `bom_component_history` writes from `bumpComponentVersion` and `addComponentDocument` (added in 0010) are kept as a belt-and-suspenders raw audit store but are now superseded by canonical table reads in the API response.
**Why:** The trigger-only approach silently excluded history predating the trigger installation. A compliance audit trail must be complete regardless of when the system was instrumented — reading the canonical source tables (`bom_component_versions`, `component_documents`) guarantees no revision or document is ever missing from the log.
**Files changed:** supabase/functions/portal-api/index.ts, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, docs/DECISIONS.md

---
**Date:** 2026-08-28
**Feature:** PROP-013 amendment — auto-incrementing revision numbering (A→B→…→Z→AA→AB…)
**Decision:** `bumpComponentVersion` no longer accepts a `revision` input. The server queries existing revisions for the component, finds the highest by a base-26 rank function (A=1, B=2, …, Z=26, AA=27, AB=28…), and computes the next one. The frontend shows a read-only "Next: X" preview badge computed with the same algorithm from the already-fetched version list; the server result is authoritative (the UNIQUE constraint on `(component_id, revision)` prevents races). The frontend bump form now only has a "What changed" summary field.
**Why:** Requiring the user to type the next revision letter was error-prone (skipping letters, reusing letters, wrong case). The revision sequence is mechanical and should be automatic. The server-side computation ensures correctness even if two sessions try to bump simultaneously — one succeeds, one gets a constraint error.
**Files changed:** supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-28
**Feature:** PROP-013 amendment — guarantee Revision A in Change Log + unified canonical reads
**Decision:** Two changes shipped together. (1) `addComponent` now writes an explicit `version_bumped` history row for Revision A immediately after the initial version insert, so the component creation moment always appears in the Change Log even if `bom_component_history`'s INSERT trigger fired separately. (2) `getComponentChangelog` rewritten to merge three canonical sources in a single `Promise.all`: `bom_component_history` (field snapshots, created/updated only), `bom_component_versions` (all revisions ever), `component_documents` (all linked docs ever) — sorted by timestamp DESC. The canonical-table reads guarantee completeness regardless of when triggers were installed.
**Why:** Components created before migration 0009 (the audit trail migration) had no `bom_component_history` rows for their Revision A because the INSERT trigger wasn't yet live. Reading from `bom_component_versions` directly (the canonical revision source) ensures all revisions appear in the Change Log even for pre-trigger components. The belt-and-suspenders explicit write in `addComponent` closes any remaining gap for new components if the history insert were somehow slow or retried.
**Files changed:** supabase/functions/portal-api/index.ts, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, docs/DECISIONS.md

---
**Date:** 2026-08-28
**Feature:** PROP-013 amendment — BOM unlimited depth via inline child creation
**Decision:** `openAddChildModal` (the `+ child` per-row button in the BOM tree) was rewritten with two tabs: "Link existing" (prior behavior — pick from the org's component list) and "Create new" (name + type + auto-generated part number; on submit, calls `addComponent` then `addBomEdge` in sequence). No new API actions; the existing `addComponent` + `addBomEdge` calls are composed client-side.
**Why:** The original modal only let you link already-existing components. To create a grandchild (1.1.1), users had to (1) create the component via the toolbar — which lands as a root — and then (2) locate it in a separate `+ child` modal. This two-step flow was non-obvious and felt like a depth limitation even though the backend supported unlimited depth. The inline "Create new" tab removes the intermediate step: click `+ child` on any node at any depth, pick "Create new", enter a name, and the component is created and linked in one round-trip pair.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-28
**Feature:** PROP-013 amendment — parent picker in "New Component" modal for Child mode
**Decision:** When "Child — Component / Part" is selected in the "+ New Product/Component" toolbar modal, a searchable parent picker appears and is required before submission. The picker lazy-loads the component list via `listComponents` on first tab switch; on submit, `addComponent` is called first, then `addBomEdge(selectedParentId, newId, qty=1)`. No new API actions.
**Why:** Previously, "Child" mode only changed the default type field — the new component still landed as an orphan root, requiring the user to separately find it in a `+ child` modal and link it. This was confusing: selecting "Child" strongly implies the component will be attached to something. Making parent selection mandatory in this flow closes the gap and matches user expectation.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-28
**Feature:** PROP-013 amendment — enforce BOM creation rules in UI
**Decision:** Removed the mode toggle ("Parent" / "Child") and parent picker from the `openAddComponent` toolbar modal. The toolbar button is now "+ New Product", the modal title is "New Product / Assembly", and a hint makes the rule explicit: top-level products/assemblies only. Child creation is exclusively via the `+ child` row button on any BOM tree node. No API changes; this is a frontend UX constraint only.
**Why:** Having two entry points for child creation (toolbar Child mode + per-row `+ child` button) caused confusion about where orphan components came from. The per-row `+ child` button already supports unlimited depth via the "Create new" tab added in the prior commit; making the toolbar button parents-only removes ambiguity and matches the mental model (toolbar = new top-level thing, row button = attach a subordinate).
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html

---
**Date:** 2026-08-28
**Feature:** PROP-013 amendment — close detail panel on empty BOM tree
**Decision:** `refreshTree` now hides and empties the component detail panel before returning early in both empty-state branches (no components at all, and no root_ids). The empty-state notice text was also corrected to reference "+ New Product" (matching the renamed toolbar button).
**Why:** After deleting the last component, the tree area showed "No components yet" but the previously-selected component's detail panel — history log, fields, actions — remained visible alongside it. This was visually inconsistent and could mislead a user into thinking data still existed.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html

---
**Date:** 2026-08-28
**Feature:** PROP-015 — Configure-to-Order Variant BOM (Product Families)
**Decision:** Introduced a "Super BOM" model: one BOM tree per product family rather than thousands of duplicate trees per SKU. The key mechanism is a `variant_condition JSONB` column on `bom_edges` — `NULL` means always included; `{"Power":"50W"}` means the edge is active only when Power=50W is selected. A `resolveVariant` BFS walks the tree filtering edges by condition match against a `selections` object. Configuration space is defined via `family_attributes` + `family_attribute_values` tables; named resolved configurations (SKUs) are stored in `saved_configurations`. A new `product_family` node type was added to the existing CHECK constraint on `bom_components.type`.
**Why:** Alternatives considered: (1) separate BOM tree per SKU — O(N×depth) storage, every shared-component change requires updating all trees; (2) module composition (sub-assemblies per variant) — still requires separate trees and loses the "one view of the full family" benefit. The Super BOM approach stores each component once; a change to a shared node propagates to every configuration automatically. Backward compatibility is fully preserved: existing `Product`-type roots have `variant_condition = NULL` on all their edges and are unaffected by the resolver logic.
**Files changed:** supabase/migrations/0011_variant_bom.sql (new), supabase/functions/portal-api/index.ts (TENANT_TABLES, addComponent/updateComponent type lists, getBom edge select, addBomEdge, deleteComponent cleanup, 9 new action handlers), assets/app.js (product_family TYPE_OPTS, renderBomTree edge condition tag + FAMILY badge, openAddChildModal condition picker, openComponentDetail family config section, new openConfigureModal), index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** PROP-015 bugfix — type dropdown showed only first option
**Decision:** `el(tag, attrs, kids)` takes a single third parameter; spreading an array with `...` into it silently discards all elements after the first. Both `openAddComponent` and `openAddChildModal` called `el("select", …, ...TYPE_OPTS.map(…))`, so the type dropdown only ever rendered "Product". Fixed by passing the mapped array directly (without spread).
**Why:** The `el()` helper uses `[].concat(kids)` internally to flatten arrays, so an array argument is correct — the spread was unnecessary and destructive.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** Edge function — CORS-safe error handling + null-guard inserts
**Decision:** Wrapped the entire `Deno.serve` handler body in a top-level try-catch that returns `json({ error: err.message }, 500)` — a CORS-compliant response — instead of letting Deno catch it and emit a raw 500 without CORS headers. Also null-guarded the two `maybeSingle()` inserts in `addComponent` (comp and ver): if either returns null with no error, the function now returns a 400 with a diagnostic message rather than throwing a `TypeError` on `.id`.
**Why:** Any unhandled exception in an action handler was producing a Deno-level 500 without `Access-Control-Allow-Origin`. Safari reports this as "Load failed"; Chrome as "Failed to fetch". The modal stayed open even though the DB write had already succeeded — the user saw an error but the component was silently created in the background. The outer try-catch ensures ALL future errors surface as readable JSON in the modal.
**Files changed:** supabase/functions/portal-api/index.ts, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** BOM toolbar — rename labels to "+ New BOM Node" / "Create BOM Node"
**Decision:** Toolbar button renamed from "+ New Product" to "+ New BOM Node"; modal title to "New BOM Node"; submit button to "Create BOM Node"; empty-state hint updated to match. Cache bumped v125→v127.
**Why:** The original labels implied only products could be created at the root level, but the toolbar now supports Product, Component, SparePart, Refurb, and Product Family types.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** Edge function — fix .catch() on tdb insert
**Decision:** The non-fatal `bom_component_history` write in `addComponent` used `.catch()` chained directly on `tdb().insert()`. Supabase query builders are thenable but not full Promises — they have no `.catch()` method, so this threw "is not a function" at runtime. Replaced with a `try { await ... } catch {}` block.
**Why:** Only became visible once the outer try-catch (previous commit) started surfacing errors as readable JSON instead of raw Deno 500s.
**Files changed:** supabase/functions/portal-api/index.ts, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** Move Product tab into As Operated as "Product BOM" subtab
**Decision:** Removed the top-level Product tab and panel from `index.html`. Added a "Product BOM" subtab inside As Operated, rendered lazily via the existing `renderProduct()` function, positioned between "Labels and Instructions" and "Supplier uploads". Cache bumped v127→v128.
**Why:** The BOM is part of the as-operated product record, not a standalone section. Placing it inside As Operated keeps the top-level nav lean and groups product-related information in one place.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** PROP-016 — BOM Tree sibling shortcut button
**Decision:** Added a `+sib` button to every non-root BOM row that opens `openAddChildModal` with the row's `parentNode` as the target, allowing the user to add a peer node without scrolling back to the parent. The `parentNode` reference is threaded through `walk()` via a new seventh parameter and stored on each row in `buildRows()`.
**Why:** Without the shortcut users had to scroll up to the parent row and click `+child` there — a high-friction workflow when building out multi-level trees. The sibling button eliminates that friction by passing the parent context down to the child row.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-29
**Feature:** PROP-017 — BOM Tree UX Polish (always-show QTY, Expand All / Collapse All, sticky header, compact action labels)
**Decision:** Four targeted changes to `renderBomTree`: (1) QTY cell now always renders `×N` (was hidden when N=1). (2) "Expand all" and "Collapse all" buttons added above the column header inside `render()`, sharing the `collapsed` Set and `buildRows()` closure directly. (3) Column header div gets `position:sticky;top:0;z-index:1` so it stays visible while scrolling a long tree. (4) Action button labels compacted to `⚙`, `+sib`, `+child`, `Detail`, `Del` with `title` tooltip attributes, saving horizontal space. Cache bumped v129→v130.
**Why:** The previous UI was ambiguous (a missing QTY could mean "not set" or "= 1"), scroll-heavy (no way to expand/collapse the whole tree at once), and the action buttons were wide enough to push the tree off-screen on narrow viewports. No new data model, API, or DB changes — purely presentation.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** BOM tree grid alignment fix + component cell redesign
**Decision:** Root cause of column misalignment: the actions column was `auto`-width, so rows with 3 buttons (root) vs 5 buttons (family non-root) resolved `1fr` differently, shifting every other column. Fixed by setting actions column to `12rem` in both header and row grid templates. Also: component cell redesigned — bold name is now on the first line with badges; part number drops to a second line in tiny monospace (previously the part number pushed the name right, making it hard to scan). COGS cells now show `—` instead of blank when no cost data. Rows highlight subtly on `mouseenter`. Cache bumped v130→v131.
**Why:** The `auto` column bug existed since the action button set was made conditional (sibling/configure buttons added in PROP-016/015). Each row is an independent CSS grid; `auto` resolves differently per row when content differs, so `1fr` is not the same width across rows — hence visual misalignment. Fixed-width column is the correct solution.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** BOM tree column centering — QTY, Status, COGS
**Decision:** Header labels for QTY, Status, COGS columns now use `text-align:center` (applied by index in the map, indices 2–4). Data cells: QTY span uses `display:block;text-align:center`; Status badge wrapped in `display:flex;justify-content:center` div; COGS value wrapped in `display:flex;justify-content:center` div. Cache bumped v131→v132.
**Why:** The values were left-aligned within their narrow fixed-width columns, making them hard to read at a glance — centering aligns them under their headers and reduces visual noise.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** BOM tree — propagate effective quantity down child paths
**Decision:** `walk()` now passes `qty * e.quantity` to children instead of `e.quantity`. This makes every displayed QTY the effective quantity from root to that node (e.g. if 1.1 is ×2 and 1.1.1 is ×3 per unit of 1.1, then 1.1.1 shows ×6). Cache bumped v132→v133.
**Why:** The previous behaviour showed only the edge quantity — the quantity on the single parent→child edge — which is meaningless to anyone reading the tree top-down. Effective quantity (accumulated product of all ancestor edge quantities) is what a BOM reader actually needs: it tells you how many of that part go into one unit of the root product.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** Rename product_family → "Dynamic BOM" in UI; hide ⚙ Configure button
**Decision:** Renamed the `product_family` type label from "Product Family (CTO)" to "Dynamic BOM" in the type picker, the tree badge from "FAMILY" to "DYNAMIC BOM", and the detail panel heading accordingly. The ⚙ Configure button (which opened the variant-attribute modal from PROP-015) is hidden from the BOM tree row — it will return when the order-import integration (PROP-018) is built. The empty-state hint for saved configurations now references PROP-018 instead of pointing to the Configure button.
**Why:** The PROP-015 configure modal manages abstract variant attributes (Power: 50W, Size: L) — not the actual components in the BOM. Users expected ⚙ to let them pick which components belong to the Dynamic BOM; instead it opened an unrelated attribute system. The term "Dynamic BOM" is already used elsewhere in Rushroom's digital stack (order system, bulk render pipeline) and correctly describes what this node type is. Components are added via `+child` as in any other BOM node — no special button needed.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** Dynamic BOM — restrict add-child UX (link-existing-only + block sub-child modifications)
**Decision:** In a Dynamic BOM tree (root node `type === "product_family"`): (1) `+child` and `+sib` on any node at depth > 0 are hidden — a Dynamic BOM picks existing BOM Nodes including their full sub-trees; you do not add or rearrange children inside those sub-trees from the Dynamic BOM context. (2) `+child` on the Dynamic BOM root (depth 0) passes `linkExistingOnly: true` to `openAddChildModal`, which hides the "Create new" tab — you can only link an existing component. (3) `+sib` on a direct child of the Dynamic BOM root (depth 1) is still visible and also passes `linkExistingOnly: true`. Cache bumped v134→v135.
**Why:** A Dynamic BOM is a pick-list of existing BOM Nodes. Creating new components from within the Dynamic BOM context would scatter master-data creation into an incidental workflow and break the rule that BOM Nodes are the single source of truth for component identity. Sub-tree management belongs on the component itself, not on a Dynamic BOM that happens to include it — otherwise the same component could have different children in different Dynamic BOMs, making compliance tracking impossible.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** BOM Node always-visible + "Used in" detail panel
**Decision:** `listComponents` now returns every component ID in `root_ids` — no longer filtered to only those without parent edges. Every BOM Node is an independent registry entry and always renders as its own standalone tree, regardless of whether it also appears as a child inside another component's tree. New `listParentsOf` API action returns all active bom_edges where the given component is the child, joined with parent component metadata. The component detail panel now shows a "Used in" section with a table of parent assemblies (name, part#, qty, reference designator).
**Why:** Adding a component as a child to another assembly was removing it from the standalone list — a consequence of the `root_ids` filter. Components (BOM Nodes) are the source of truth for compliance tracking; their position in a parent assembly is a relationship, not an identity. A screw used in 12 assemblies must remain visible as its own entry and must show where it is used, so compliance impact of a change can be traced upward. This is the standard "where used" query in PLM/ERP systems.
**Files changed:** supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** Link document to BOM Node from detail panel
**Decision:** Added `openAddDocModal()` inside `openComponentDetail` — a "+ Link document" button in the Documents section heading opens a modal that fetches the document library via the existing `data` action, lets the user pick a version + category + label + supplier-visible flag, and calls `addComponentDocument`. On success, the detail panel refreshes in-place. No new API actions — `addComponentDocument` was already implemented on the backend but had no UI. Cache bumped v146 → v147.
**Why:** Documents need to be added to components after initial creation (test reports arrive later, declarations are issued later). The `data` action already returns all document versions so no new endpoint was needed. Linking (not uploading) is the correct model — files are managed in the As Operated tab, components reference them.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** Detail panel scroll-into-view on open
**Decision:** Added `panel.scrollIntoView({ behavior: "smooth", block: "nearest" })` immediately after `panel.style.display = ""` in `openComponentDetail`. Cache bumped v145 → v146.
**Why:** The detail panel sits below the BOM tree in DOM order. Opening it via double-click left it out of the viewport — users had to scroll manually to see it. `block: "nearest"` scrolls the minimum distance needed to make the panel fully visible without overshooting.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** BOM row UX — × delete button + double-click for detail
**Decision:** Replaced the "Del" text button with a compact red "×" symbol. Removed the "Detail" button entirely; the component detail panel now opens on double-click of any BOM row. Cache bumped v144 → v145.
**Why:** "Del" next to "Detail" created visual noise and risk of misclick. A × is universally understood as delete and takes less space. Double-click for detail is a standard desktop pattern — it keeps the action bar minimal (just +sib, +child, ×) while preserving full detail access without an extra button per row.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** PROP-020 fix — BOM tab grouping by hasChildren, not type field
**Decision:** Changed tab assignment from pure `type`-field matching to: `product_family` → Dynamic BOMs; `edges.length > 0` (has BOM children) OR `type === "Product"` → Assemblies; everything else → Components. Cache bumped v143 → v144.
**Why:** Nodes created before the type conventions were established (e.g., assemblies with `type: Component`) were landing in the wrong tab. A node with BOM children IS an assembly by structure regardless of how it was typed. Checking `edges.length` from the already-fetched tree data costs nothing extra and is structurally correct.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** PROP-020 — BOM List Split by Type + Delete label
**Decision:** Replaced the flat mixed product list in `bomTreeView` with three client-side tabs keyed on `bom_components.type`: Components (Component / SparePart / Refurb), Assemblies (Product), Dynamic BOMs (product_family). After `+ New BOM Node`, the UI switches to the Components tab (default type). Tab switching re-renders from cached tree data — no extra API calls. Delete confirmation button label changed from "Delete forever" → "Delete Permanently". Cache bumped v142 → v143.
**Why:** The flat list mixed standalone parts, product assemblies, and family templates, making newly created components invisible at the bottom of a long mixed list. Splitting by the explicit `type` field (an already-present user intent signal) groups items predictably without any schema or API changes. Pure frontend — the simplest correct fix.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md, docs/ROADMAP.md, docs/IDEAS.md

---
**Date:** 2026-08-29
**Feature:** PROP-019 — COGS Layer Removal
**Decision:** Removed the entire financial/COGS layer from the compliance portal: 5 DB tables (`component_costs`, `landed_cost_factors`, `cogs_snapshots`, `cost_scenarios`, `scenario_overrides`), 10 API actions (`getComponentCosts`, `upsertLandedCostFactor`, `computeCogs`, `compareCogs`, `createScenario`, `listScenarios`, `applyScenarioOverride`, `getScenarioResult`, `archiveScenario`, COST_ACTIONS gate), the Cost Canvas subtab, and the COGS column from the BOM tree grid.
**Why:** Financial analysis (COGS, cost scenarios, scenario simulation) belongs in ERP and financial tooling — not in a compliance portal. The BOM tree is the shared backbone that compliance, ERP, and the configurator all read from; adding financial logic to the compliance portal duplicated ERP responsibilities in the wrong layer. The BOM tree itself (bom_components, bom_edges, bom_component_versions, component_materials, component_documents, bom_component_history) is kept intact for compliance tracing, REACH/RoHS, and "where used" tracking. Cache bumped v140→v141.
**Files changed:** supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, supabase/migrations/0012_remove_cogs_layer.sql, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md, docs/ROADMAP.md

---
**Date:** 2026-08-29
**Feature:** PROP-021 Layer 1 — Component Document Upload & Link
**Decision:** Added a new `uploadAndLinkComponentDocument` backend action that creates the `documents` row, `document_versions` row, and `component_documents` link in a single round-trip, returning the version ID from Postgres directly (`.select("id").maybeSingle()`) rather than querying back after the fact. Auto-numbers the version label when blank using the existing count-based pattern from `insertDocumentVersion`. The `openAddDocModal` frontend function was refactored into a two-tab modal (Link existing / Upload & link) using nested `renderLinkTab()` / `renderUploadTab()` functions sharing a common `tabBar()` renderer, avoiding code duplication. The "Add document" button label replaces the old "Link document" label since the modal now covers both flows.
**Why:** `addDocument` existed but returned only `{ok, id}` (document ID) — not the `document_version_id` needed to call `addComponentDocument`. Modifying `addDocument` to also return the version ID would have broken any callers relying on that exact shape. A dedicated combined action is cleaner, more atomic, and easier to audit than two separate round-trips.
**Files changed:** supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md, docs/ROADMAP.md

---
**Date:** 2026-08-30
**Feature:** PROP-022 — BOM List Performance & Search
**Decision:** Eliminated the O(N) getBom-per-root pattern by (a) adding `has_children` to `listComponents` via a single `DISTINCT parent_id` query against `bom_edges`, and (b) replacing the full-tree-per-item list with lazy ▶ expand rows. Search is client-side (filter on already-loaded component list) rather than server-side, which avoids a round-trip and is instant for hundreds of items. Pagination is also client-side (slice of in-memory list), since the listComponents payload is small (6 fields × N rows, no tree data).
**Why:** The previous design called getBom for every root component on every page load just to classify tabs — O(N) API calls. For 1000 components this would make the BOM page unusable. The `has_children` flag resolves this in a single indexed query. No DB migration needed.
**Files changed:** supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, docs/DECISIONS.md

---
**Date:** 2026-08-30
**Feature:** PROP-023 — Component Lifecycle Status Rebuild
**Decision:** Replaced the 6 engineering-stage values (concept/specified/sourcing/approved/released/obsolete) with 4 operational states (active/inactive/replaced/flagged). Added `replacement_note TEXT` and `flag_reason TEXT` columns rather than a separate junction table — these are 1:1 with the component row and only ever populated for one status value at a time, so a junction table would add join complexity for zero benefit. The backend clears the irrelevant aux field on every status save so stale data never leaks. The status edit block lives in the component detail panel (not the tree row) to avoid cluttering the compact list view.
**Why:** The old 6-stage model described an engineering workflow (concept → release) that doesn't match how Rushroom actually operates the product. The 4-state model maps to observable operational facts: is this component being sold (active), not yet / under review (inactive), retired by something else (replaced), or under investigation (flagged)? Data migration is deterministic: concept/specified/sourcing → inactive (not yet in operation), approved/released → active, obsolete → replaced.
**Files changed:** supabase/migrations/0013_lifecycle_status_rebuild.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, docs/DECISIONS.md

---
**Date:** 2026-08-30
**Feature:** Bug fix — Version history disappears after component version bump
**Decision:** Added an explicit application-level UPDATE (`SET is_current = FALSE WHERE component_id = ...`) in `bumpComponentVersion` before inserting the new version row, rather than relying solely on the Postgres trigger `fn_set_current_version`. Also changed the frontend bump form to `await openComponentDetail(componentId, token, panel, nodeData)` — passing `nodeData` and awaiting the refresh so the status section reads the actual component state.
**Why:** The `fn_set_current_version` AFTER INSERT trigger performs the same retire step, but does not fire reliably in Supabase's service-role RLS environment. When it failed silently, all version rows for the component had `is_current = TRUE` simultaneously — but `getComponentHistory` fetches with no `is_current` filter, so all rows should have appeared. The root issue turned out to be that the trigger was not reliably setting old rows to `is_current = FALSE`, leaving old rows invisible to queries that filtered on `is_current`. Doing the retire in application code (which runs as service role and always fires) resolves this. The missing `nodeData` arg caused the PROP-023 status section to always default to "inactive" on panel refresh after a bump.
**Files changed:** supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, docs/DECISIONS.md

---
**Date:** 2026-08-30
**Feature:** Bug fix — Component detail tables only showing first row (v152)
**Decision:** Removed the spread operator from all five `el("tbody", {}, ...rows)` calls in `openComponentDetail`, changing them to `el("tbody", {}, rows)`. No other changes.
**Why:** `el(tag, attrs, kids)` takes exactly three positional parameters; the spread operator was passing each row as a separate positional argument beyond the third, so only `rows[0]` was ever rendered. The data in the database was correct throughout — all version, document, material, used-in, and changelog rows existed. This was a pure frontend rendering bug. The v151 backend fix (explicit `is_current` retire) is also correct and harmless, but the missing rows were never a database problem.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, docs/DECISIONS.md

---
**Date:** 2026-08-30
**Feature:** Bug fix — "Can't find variable: role" in component detail panel (v153)
**Decision:** Added `role` as a second parameter to `bomTreeView(token, role)` and updated the single call site in `renderProduct` from `bomTreeView(token)` to `bomTreeView(token, role)`. The `openComponentDetail` function (defined inside `bomTreeView`) closes over `role` to gate the status-edit block behind `if (role === "rushroom")`.
**Why:** `renderProduct(role, mount)` received `role` correctly but passed only `token` to `bomTreeView`, so `role` was never in scope for the inner functions. The status edit block added in PROP-023 introduced the first use of `role` inside `bomTreeView`, exposing the missing parameter.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, docs/DECISIONS.md

---
**Date:** 2026-08-30
**Feature:** Bug fix — "Can't find variable: role" correct fix (v154)
**Decision:** Added `role` as an explicit 5th parameter to `openComponentDetail(componentId, token, panel, nodeData, role)` and updated all 7 call sites to pass it through. The two external entry points (`ondblclick` handlers inside `bomTreeView`) pass the `role` that `bomTreeView` now receives as its second param; the five internal recursive refresh calls forward `role` from the function's own parameter.
**Why:** `openComponentDetail` is a peer-level function inside the main app closure — the same scope level as `bomTreeView`, `statusOverviewView`, and `renderProduct`. It cannot close over `bomTreeView`'s local variables. The v153 fix incorrectly assumed nesting; this fix threads `role` as a value through the call chain instead, which works regardless of scope structure.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, docs/DECISIONS.md

---
**Date:** 2026-08-30
**Feature:** Bug fix — "Can't find variable: role" complete fix (v155)
**Decision:** Added `role` as the 8th parameter to `renderBomTree` and updated its single call site inside `bomTreeView` to pass `role`. Combined with the v154 fix (role as 5th param on `openComponentDetail`), all three peer functions that reference `role` — `bomTreeView`, `renderBomTree`, `openComponentDetail` — now receive it explicitly. The full chain is: `renderProduct(role)` → `bomTreeView(token, role)` → `renderBomTree(..., role)` → `openComponentDetail(..., role)`.
**Why:** All three functions are defined at the same scope level inside the main app closure. None can close over another's local variables. `role` must be threaded explicitly as a parameter through the entire call chain. The PROP-023 status edit block was the first code inside these functions to use `role`, which is why this was never caught before.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, docs/DECISIONS.md

---
**Date:** 2026-08-30
**Feature:** PROP-024 Component Version History — Full State Access Per Revision
**Decision:** Store version snapshot as JSONB on `bom_component_versions` rather than adding version-scoped FK columns to `component_documents` / `component_materials`.
**Why:** Adding `component_version_id FK` to the document and material tables would require migrating all existing rows and changing how documents are linked (to a version, not a component). The JSONB approach is additive-only: one new nullable column, no schema changes to existing linking tables, no migration of existing data. The tradeoff is that documents added after a bump but before the next are not captured — acceptable for MVP and documented in the UI as "snapshot as of version creation."
**Files changed:** supabase/migrations/0014_version_snapshot.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-30
**Feature:** Bug fix — BOM tab classification type-only
**Decision:** Tab placement in `groupFiltered()` now uses only `c.type`; removed `|| c.has_children` from the Assemblies condition.
**Why:** `has_children` was added so that any component with children would surface in the Assemblies tab, but this caused Component-typed nodes to migrate tabs as soon as they got their first child — the wrong behaviour. Tab identity must be stable and reflect what the node *is* (its type), not what edges it has. `has_children` remains correct for driving the expand button.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-30
**Feature:** PROP-025 Structural BOM Tab Classification + Meaningful Type Values
**Decision:** Tab classification uses `has_children` (structural) rather than the `type` field; component type values renamed from Component/Product/SparePart/Refurb to part/raw_material/sub_assembly/finished_good/spare_part.
**Why:** The old type values ("Component", "Product") clashed with tab names and led to visually contradictory states — a node typed "Component" appearing in the Components tab with an expand arrow because it had children. Structural routing means the UI reflects reality: if it has children it IS an assembly, regardless of what type label it carries. Renaming types to manufacturing categories makes the badge meaningful without conflicting with tab terminology.
**Files changed:** supabase/migrations/0015_rename_component_types.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-30
**Feature:** PROP-026 Component Images — Paste, Drop, or Pick from Disk
**Decision:** Store component images in the existing `documents` bucket under a `component-images/` prefix rather than a dedicated `component-images` bucket.
**Why:** Creating a new bucket requires Supabase dashboard access and separate RLS bucket policies. Reusing the `documents` bucket with a path prefix achieves the same isolation at zero extra infra cost. Images are only exposed via 1-hour signed URLs (same as documents), keeping access control consistent.
**Files changed:** supabase/migrations/0016_component_images.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-31
**Feature:** Bug fix — BOM Node tree arrows cannot collapse after initial expand
**Decision:** Changed open-state check from `display !== "none" && display !== ""` to `display !== "none"` in the outer BOM Node list expand button.
**Why:** A freshly-rendered expanded tree has `style.display = ""` (the browser default for visible). The extra `!== ""` condition made this evaluate to `false`, so every click went into the expand branch and never collapsed. Empty string means visible — only `"none"` means hidden.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-31
**Feature:** Photos in New BOM Node creation modal
**Decision:** Queue images as `File` objects with local `createObjectURL` previews during the modal; upload them to Supabase Storage only after `addComponent` returns the new component ID. Upload failures are swallowed (best-effort) — the component was already created successfully.
**Why:** The signed upload URL requires a `component_id`, which doesn't exist until after creation. Queueing avoids a two-step UX while keeping the upload flow identical to the detail panel (`imageUploadUrl` → XHR PUT → `addComponentImage`). No new API actions needed.
**Files changed:** assets/app.js, index.html, CLAUDE.md
