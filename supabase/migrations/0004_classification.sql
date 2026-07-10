-- ============================================================================
-- 0004_classification.sql — COMPLIANCE STATUS DIMENSION: Lifecycle phase × Scope
-- Enums: lifecycle_phase, compliance_scope. Table: classification_log.
-- Plus classification columns added to documents, as_operates_interpretations,
-- and steps.
--
-- Positions every compliance item (documents + clause interpretations) in a 2×2
-- matrix: lifecycle phase (pre_launch | monitoring) × scope (company |
-- product_services). All columns are NULLABLE — NULL = unclassified, so an
-- existing Level 1/Level 2 database keeps working unchanged (progressive
-- enrichment). Additive migration only; no existing columns are altered.
-- Depends on 0001 (documents, steps) and 0002 (as_operates_interpretations).
-- Idempotent.
--
-- NOTE: PostgreSQL has no CREATE TYPE IF NOT EXISTS. The guarded DO block below
-- is the idempotent equivalent (creates the enum only if it does not yet exist).
-- ============================================================================

-- Enums (guarded so the script stays safe to re-run).
do $$ begin
  create type public.lifecycle_phase as enum ('pre_launch', 'monitoring');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.compliance_scope as enum ('company', 'product_services');
exception when duplicate_object then null; end $$;

-- Classification + monitoring-recurrence columns on documents and interpretations.
-- Monitoring fields are SCHEMA ONLY in this phase (no due-date/notification logic);
-- they are only meaningful when lifecycle_phase = 'monitoring'.
alter table public.documents add column if not exists lifecycle_phase public.lifecycle_phase;
alter table public.documents add column if not exists scope public.compliance_scope;
alter table public.documents add column if not exists classification_ai_generated boolean not null default false;
alter table public.documents add column if not exists classified_by uuid;
alter table public.documents add column if not exists classified_at timestamptz;
alter table public.documents add column if not exists monitoring_frequency interval;
alter table public.documents add column if not exists next_due_at timestamptz;
alter table public.documents add column if not exists last_verified_at timestamptz;

alter table public.as_operates_interpretations add column if not exists lifecycle_phase public.lifecycle_phase;
alter table public.as_operates_interpretations add column if not exists scope public.compliance_scope;
alter table public.as_operates_interpretations add column if not exists classification_ai_generated boolean not null default false;
alter table public.as_operates_interpretations add column if not exists classified_by uuid;
alter table public.as_operates_interpretations add column if not exists classified_at timestamptz;
alter table public.as_operates_interpretations add column if not exists monitoring_frequency interval;
alter table public.as_operates_interpretations add column if not exists next_due_at timestamptz;
alter table public.as_operates_interpretations add column if not exists last_verified_at timestamptz;

-- Monitoring fields must be NULL for pre_launch items (only meaningful for monitoring).
do $$ begin
  alter table public.documents add constraint documents_monitoring_null_chk
    check (lifecycle_phase is distinct from 'pre_launch'
      or (monitoring_frequency is null and next_due_at is null and last_verified_at is null));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.as_operates_interpretations add constraint interp_monitoring_null_chk
    check (lifecycle_phase is distinct from 'pre_launch'
      or (monitoring_frequency is null and next_due_at is null and last_verified_at is null));
exception when duplicate_object then null; end $$;

-- Append-only audit trail of every classification change (no updates/deletes).
create table if not exists public.classification_log (
  id                  uuid primary key default gen_random_uuid(),
  entity_type         text not null,                    -- 'document' | 'interpretation'
  entity_id           uuid not null,
  old_lifecycle_phase public.lifecycle_phase,
  new_lifecycle_phase public.lifecycle_phase,
  old_scope           public.compliance_scope,
  new_scope           public.compliance_scope,
  changed_by          uuid,
  changed_at          timestamptz not null default now(),
  ai_generated        boolean not null default false
);
create index if not exists classification_log_entity_idx on public.classification_log (entity_type, entity_id);

alter table public.classification_log enable row level security;

-- ---- Classification on STEPS (same lifecycle_phase × scope 2×2 as documents) ----
-- Lets action-plan steps be designed/edited per quadrant. Enums are reused from
-- the classification section above. classification_log gains an integer entity_step
-- (steps have an integer PK) and entity_id becomes nullable for step entries.
alter table public.steps add column if not exists lifecycle_phase public.lifecycle_phase;
alter table public.steps add column if not exists scope public.compliance_scope;
alter table public.steps add column if not exists classification_ai_generated boolean not null default false;
alter table public.classification_log alter column entity_id drop not null;
alter table public.classification_log add column if not exists entity_step integer;
