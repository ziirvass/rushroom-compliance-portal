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
