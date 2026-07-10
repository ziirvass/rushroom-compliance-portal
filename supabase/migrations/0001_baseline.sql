-- ============================================================================
-- 0001_baseline.sql — Rushroom Compliance Portal
-- Core tables: steps, documents, document_versions, uploads, standards,
-- standard_versions, users, deviation_scans, deviation_findings.
-- Plus RLS deny-all. STRUCTURE ONLY — seed data + storage buckets live in
-- supabase/seed.sql.
--
-- Security model: the browser NEVER touches these tables directly. Row-Level
-- Security is enabled with no public policies, so anon/authenticated clients are
-- denied. All reads/writes go through the `portal-api` Edge Function, which uses
-- the service-role key and enforces the role rules (Rushroom vs supplier).
-- Idempotent: safe to re-run.
-- ============================================================================

-- ---- Tables ----------------------------------------------------------------
create table if not exists public.steps (
  step        integer primary key,
  phase       text not null default 'Unphased',
  action      text not null default '',
  owner       text default '',
  where_how   text default '',
  evidence    text default '',
  folder      text default '',
  priority    text default '',
  status      text default 'Open',
  audience    text[] not null default array['internal']::text[],
  updated_at  timestamptz not null default now(),
  updated_by  text default ''
);

create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  category      text not null default '',
  name          text not null default '',
  url           text default '',          -- external link (e.g. legacy Google Drive)
  storage_path  text default '',          -- path in the 'documents' bucket when the file is hosted here
  kind          text not null default 'template', -- 'template' (Templates & Requirements) | 'operational' (Company as Operates)
  audience      text[] not null default array['internal']::text[],
  sort          integer default 0
);
-- For projects created before these columns existed:
alter table public.documents add column if not exists storage_path text default '';
alter table public.documents add column if not exists kind text not null default 'template';

-- Version history for operational ("Company as Operates") documents. These are
-- never deleted — a new version is uploaded and the previous ones stay accessible.
create table if not exists public.document_versions (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references public.documents(id) on delete cascade,
  version      text default '',
  file_name    text not null,
  storage_path text not null,
  notes        text default '',
  uploaded_by  text default '',
  created_at   timestamptz not null default now()
);
create index if not exists document_versions_doc_idx on public.document_versions (document_id);

alter table if exists public.document_versions add column if not exists source_document_version_id uuid references public.document_versions(id) on delete set null;
alter table if exists public.document_versions add column if not exists source_standard_version_ids jsonb not null default '[]'::jsonb;

create table if not exists public.uploads (
  id             uuid primary key default gen_random_uuid(),
  step           integer references public.steps(step) on delete set null,
  uploaded_role  text not null,           -- 'rushroom' | 'supplier'
  supplier_label text default '',          -- free-text "who" (suppliers share one login)
  file_path      text not null,            -- path within the storage bucket
  file_name      text not null,
  note           text default '',
  created_at     timestamptz not null default now()
);

create index if not exists uploads_step_idx on public.uploads (step);

-- Standards & Regulations register, with per-standard version history.
create table if not exists public.standards (
  id           uuid primary key default gen_random_uuid(),
  code         text not null default '',   -- e.g. "EN 60598-1"
  title        text not null default '',
  category     text default '',            -- DOMAIN tag: "LVD", "EMC", "Materials"
  reg_type     text default '',            -- TYPE/level: EU Directive | EU Regulation | Harmonised Standard (EN) | National Standard | International (IEC/ISO) | Other
  jurisdiction text default '',            -- EU | International | a member-state country (e.g. Germany)
  audience     text[] not null default array['internal']::text[],
  created_at   timestamptz not null default now()
);
-- For projects created before the type/jurisdiction columns existed:
alter table public.standards add column if not exists reg_type text default '';
alter table public.standards add column if not exists jurisdiction text default '';
create table if not exists public.standard_versions (
  id             uuid primary key default gen_random_uuid(),
  standard_id    uuid not null references public.standards(id) on delete cascade,
  version        text not null default '',   -- e.g. "2015+A1:2022"
  effective_date text default '',
  notes          text default '',            -- what changed
  storage_path   text not null,              -- file in the 'standards' bucket
  file_name      text not null,
  uploaded_by    text default '',
  created_at     timestamptz not null default now()
);
create index if not exists standard_versions_standard_idx on public.standard_versions (standard_id);

-- AI deviation-monitoring scans: each scan compares the document library against
-- the standards register (via the Claude API) and stores findings by severity.
create table if not exists public.deviation_scans (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  model             text default '',
  status            text not null default 'ok',
  summary           text default '',
  counts            jsonb default '{}'::jsonb,
  docs_scanned      integer default 0,
  standards_scanned integer default 0,
  error             text default ''
);
create table if not exists public.deviation_findings (
  id             uuid primary key default gen_random_uuid(),
  scan_id        uuid not null references public.deviation_scans(id) on delete cascade,
  severity       text not null default 'Info',   -- Critical | High | Medium | Low | Info
  title          text not null default '',
  description    text default '',
  document       text default '',
  standard       text default '',
  recommendation text default '',
  source         text default 'ai_inference',    -- 'structured' (from as_operates_interpretations) | 'ai_inference'
  created_at     timestamptz not null default now()
);
create index if not exists deviation_findings_scan_idx on public.deviation_findings (scan_id);
-- Optional: persist AI token usage per scan so the cost shows in scan history.
-- (The edge function self-heals if this column is missing.)
alter table public.deviation_scans add column if not exists usage jsonb default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- User accounts: self-registration + email verification + admin management.
-- Access is via the portal-api Edge Function (service role); RLS denies direct.
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  email          text not null unique,
  phone          text,
  whatsapp       text,
  requested_role text not null default 'supplier',
  role           text,                                   -- assigned by an admin: admin|internal|reviewer|supplier|installer
  status         text not null default 'pending',        -- pending|verified|approved|rejected|disabled
  email_verified boolean not null default false,
  password       text,                                   -- PBKDF2 hash (pbkdf2$iter$salt$hash); never plaintext
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists users_status_idx on public.users (status);
-- If the table already exists from an earlier version, add the password column:
alter table public.users add column if not exists password text;

-- ---- Row-Level Security: lock everything; only the service role (Edge
--      Function) may read/write. No policies = no access for anon/authenticated.
alter table public.steps             enable row level security;
alter table public.documents          enable row level security;
alter table public.document_versions  enable row level security;
alter table public.uploads            enable row level security;
alter table public.standards          enable row level security;
alter table public.standard_versions  enable row level security;
alter table public.deviation_scans    enable row level security;
alter table public.deviation_findings enable row level security;
alter table public.users              enable row level security;      -- deny-all; edge function uses service role

-- Private storage buckets and their signed-URL access model are provisioned in
-- supabase/seed.sql (they are INSERTs into storage.buckets, not schema DDL).
