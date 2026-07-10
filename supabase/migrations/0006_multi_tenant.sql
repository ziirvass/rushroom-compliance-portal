-- ============================================================================
-- 0006_multi_tenant.sql — MULTI-TENANT SaaS
-- Tables: organizations, memberships, invitations, platform_audit,
-- ai_usage_events. Plus the organization_id column added to every tenant-scoped
-- table, Stage 5 hardening (NOT NULL + tenant-move trigger) and MFA columns.
--
-- Introduces the tenant model additively. All access flows through portal-api
-- (RLS deny-all). Safe to re-run (idempotent). See PROP-012 in SYSTEM_OVERVIEW.
-- STRUCTURE ONLY — the seed org, the users→memberships backfill, and every
-- org-scoped data seed live in supabase/seed.sql.
-- Depends on 0001-0005 (all tenant-scoped tables must already exist).
--
-- NOTE ON BACKFILL: this migration adds organization_id and immediately enforces
-- NOT NULL. That is valid because tenant tables are empty at migration time
-- (all seed data moved to seed.sql). The org backfill therefore cannot live in
-- seed.sql either: seed.sql runs AFTER the forbid_org_change trigger exists, and
-- a NULL→org UPDATE would trip it. seed.sql instead inserts rows already carrying
-- organization_id (via a column default), which does not fire the UPDATE trigger.
-- ============================================================================

-- Tenants.
create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text unique,                                  -- url-safe handle
  status      text not null default 'active',               -- 'trial'|'active'|'past_due'|'suspended'|'cancelled'
  plan        text not null default 'internal',             -- entitlement tier (Stage 4); 'internal' for the seed org
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- A user's role + status within one organization (the unit seats are counted from).
create table if not exists public.memberships (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  role            text not null default 'collaborator',     -- 'org_admin'|'manager'|'reviewer'|'collaborator'
  status          text not null default 'active',           -- 'active'|'invited'|'suspended'
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique(organization_id, user_id)
);
create index if not exists memberships_user_idx on public.memberships (user_id);
create index if not exists memberships_org_idx  on public.memberships (organization_id);

-- Pending email invitations to join an organization at a role.
create table if not exists public.invitations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email           text not null,
  role            text not null default 'collaborator',
  status          text not null default 'pending',          -- 'pending'|'accepted'|'revoked'|'expired'
  invited_by      uuid,                                     -- users.id of the inviter
  created_at      timestamptz not null default now(),
  expires_at      timestamptz,
  unique(organization_id, email)
);
create index if not exists invitations_email_idx on public.invitations (email);

alter table public.organizations enable row level security;
alter table public.memberships   enable row level security;
alter table public.invitations   enable row level security;

-- Add a NOT NULL organization_id to every tenant-scoped table (additive).
-- Global tables (users, eu_directives, directive_relations, cellar_cache) are
-- intentionally NOT given an org column.
do $$
declare t text;
begin
  foreach t in array array[
    'steps','documents','document_versions','uploads','standards','standard_versions',
    'deviation_scans','deviation_findings','standard_clauses','as_operates_interpretations',
    'product_passports','passport_interpretation_links','product_directive_applicability',
    'classification_log','requirement_links','document_statements'
  ] loop
    execute format('alter table public.%I add column if not exists organization_id uuid references public.organizations(id) on delete cascade', t);
    execute format('create index if not exists %I on public.%I (organization_id)', t || '_org_idx', t);
  end loop;
end $$;

-- ---- Stage 3: platform audit (operator actions) ----------------------------
-- Append-only trail of internal/operator actions — impersonation and tenant
-- status changes especially. Distinct from the per-tenant classification_log.
create table if not exists public.platform_audit (
  id                     uuid primary key default gen_random_uuid(),
  actor_user_id          uuid,
  actor_email            text,
  action                 text not null,               -- 'impersonate_start' | 'tenant_status_change' | …
  target_organization_id uuid references public.organizations(id) on delete set null,
  detail                 jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now()
);
create index if not exists platform_audit_created_idx on public.platform_audit (created_at desc);
alter table public.platform_audit enable row level security;

-- ---- Stage 4: usage metering (append-only AI token ledger) -----------------
-- One row per AI call. Monthly usage = sum(input+output) for (org, period).
-- Append-only avoids read-modify-write races on a counter. Plan/entitlements
-- live in code (portal-api); the plan itself is organizations.plan.
create table if not exists public.ai_usage_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  period          text not null,                    -- 'YYYY-MM'
  action          text,
  input_tokens    integer not null default 0,
  output_tokens   integer not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists ai_usage_events_org_period_idx on public.ai_usage_events (organization_id, period);
alter table public.ai_usage_events enable row level security;

-- ---- Stage 5: DB hardening + MFA -------------------------------------------
-- (1) organization_id becomes NOT NULL on every tenant table, and (2) an
--     immutability trigger blocks a bug from ever moving a row between tenants.
--     The trigger fires even for the service role (unlike RLS, which the service
--     role bypasses). Idempotent.

-- Block changing organization_id on update (tenant-move protection).
create or replace function public.forbid_org_change() returns trigger
language plpgsql as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'organization_id is immutable (tenant boundary)';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'steps','documents','document_versions','uploads','standards','standard_versions',
    'deviation_scans','deviation_findings','standard_clauses','as_operates_interpretations',
    'product_passports','passport_interpretation_links','product_directive_applicability',
    'classification_log','requirement_links','document_statements'
  ] loop
    -- enforce NOT NULL (valid: tenant tables are empty at migration time)
    execute format('alter table public.%I alter column organization_id set not null', t);
    -- tenant-move protection
    execute format('drop trigger if exists trg_forbid_org_change on public.%I', t);
    execute format('create trigger trg_forbid_org_change before update on public.%I for each row execute function public.forbid_org_change()', t);
  end loop;
end $$;

-- Multi-factor auth (TOTP) — opt-in per user; mfa_enabled defaults false so
-- existing accounts are unaffected until they enrol.
alter table public.users add column if not exists mfa_enabled boolean not null default false;
alter table public.users add column if not exists mfa_secret text;
alter table public.users add column if not exists mfa_pending_secret text;
