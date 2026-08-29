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
