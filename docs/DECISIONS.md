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
