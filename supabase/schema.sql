-- ============================================================================
-- Rushroom Compliance Portal — Supabase schema
-- Run this once in your Supabase project: SQL Editor → New query → paste → Run.
-- Safe to re-run: it uses "if not exists" / "on conflict do nothing".
--
-- Security model: the browser NEVER touches these tables directly. Row-Level
-- Security is enabled with no public policies, so anon/authenticated clients are
-- denied. All reads/writes go through the `portal-api` Edge Function, which uses
-- the service-role key and enforces the role rules (Rushroom vs supplier).
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
  id         uuid primary key default gen_random_uuid(),
  code       text not null default '',   -- e.g. "EN 60598-1"
  title      text not null default '',
  category   text default '',            -- e.g. "LVD", "EMC", "Materials"
  audience   text[] not null default array['internal']::text[],
  created_at timestamptz not null default now()
);
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

-- ---- Private storage buckets ----------------------------------------------
--   supplier-uploads : files suppliers submit
--   documents        : the compliance document library files (Google-free mode)
insert into storage.buckets (id, name, public)
values ('supplier-uploads', 'supplier-uploads', false),
       ('documents', 'documents', false),
       ('standards', 'standards', false)
on conflict (id) do nothing;

-- Storage objects are likewise reached only via the Edge Function (signed URLs),
-- so no public storage policies are created here.

-- ============================================================================
-- SEED DATA (generated from assets/config.js)
-- ============================================================================
-- Seed data — generated from assets/config.js (do not edit by hand).
insert into public.steps (step, phase, action, owner, where_how, evidence, folder, priority, status, audience) values
  (1, '1. Classify & decide', 'Confirm economic-operator role: Rushroom = MANUFACTURER of finished product + IMPORTER of the China LED strip (carries full CE responsibility on the assembled product)', 'Rushroom', 'Internal note', 'Documented role statement', '00 / README', 'Foundation', 'Done (documented)', ARRAY['internal']::text[]),
  (2, '1. Classify & decide', 'Confirm whether the controller is WIRELESS (BT/Zigbee/RF). If yes, Radio Equipment Directive 2014/53/EU replaces the LVD+EMC route', 'Rushroom + SE controller partner', 'Ask partner', 'Written confirmation', '01b', 'Foundation', 'Open', ARRAY['internal']::text[]),
  (3, '1. Classify & decide', 'Confirm whether the LED strip is PERMANENTLY FIXED (glued/potted). If yes, the whole fixture is assessed for ecodesign', 'Rushroom', 'Design review', 'Decision recorded', '2', 'Foundation', 'Open', ARRAY['internal']::text[]),
  (4, '1. Classify & decide', 'Confirm whether any BATTERY ships (controller/remote). If yes, adds battery producer responsibility', 'Rushroom', 'Design review', 'Decision recorded', '4', 'Foundation', 'Open', ARRAY['internal']::text[]),
  (5, '1. Classify & decide', 'Confirm WEEE EEE category (likely Large or Small equipment) and B2C vs B2B sales channel', 'Rushroom + El-Kretsen', 'Call El-Kretsen / Naturvardsverket', 'Category + channel decided', '4', 'Foundation', 'Open', ARRAY['internal']::text[]),
  (6, '1. Classify & decide', 'Confirm whether the LED-to-controller cabling counts as permanently incorporated in the building (CPR / EN 50575 applicability)', 'Rushroom', 'Assess install method', 'Decision recorded', '01e', 'Foundation', 'Open', ARRAY['internal']::text[]),
  (7, '2. Suppliers', 'SEND each supplier the package: Supplier Compliance Spec (standards + harmonised standards list), Declaration of Compliance form, and PCN Commitment', 'Rushroom → suppliers (LED strip CN, controller SE, PSU, cable, connectors)', 'Email', 'Sent, with acknowledgement', '01e', 'High', 'Open', ARRAY['internal','supplier']::text[]),
  (8, '2. Suppliers', 'COLLECT back: signed supplier declarations, test reports, datasheets, RoHS + REACH/SVHC declarations, and the PSU''s own CE DoC', 'Suppliers → Rushroom', 'Email / portal', 'Completed forms + attachments filed', '01e', 'High', 'Open', ARRAY['internal','supplier','reviewer']::text[]),
  (9, '2. Suppliers', 'VERIFY supplier evidence against the spec; chase any gaps before designing the finished product', 'Rushroom', 'Review vs spec sheet', 'Gap log cleared', '01e', 'High', 'Open', ARRAY['internal','supplier']::text[]),
  (10, '3. Testing & evidence', 'ARRANGE LVD safety testing of the ASSEMBLED product at an accredited lab (EN 60598, EN 61347, EN 62471)', 'Rushroom → accredited lab', 'Book test', 'Safety test report', '01d', 'High', 'Open', ARRAY['internal']::text[]),
  (11, '3. Testing & evidence', 'ARRANGE EMC testing of the assembled product (EN 55015, EN 61547, EN 61000-3-2). If RED applies, use EN 300 328 / EN 301 489 instead', 'Rushroom → accredited lab', 'Book test', 'EMC test report(s)', '01d', 'High', 'Open', ARRAY['internal']::text[]),
  (12, '3. Testing & evidence', 'COMPILE RoHS technical documentation (EN IEC 63000) from supplier data', 'Rushroom', 'Assemble file', 'RoHS documentation', '3', 'High', 'Open', ARRAY['internal','supplier']::text[]),
  (13, '3. Testing & evidence', 'CONDUCT risk assessment of the finished product (electrical safety + fire/thermal of 24V high-current wiring)', 'Rushroom', 'Use risk method', 'Risk assessment record', '01f', 'High', 'Open', ARRAY['internal']::text[]),
  (14, '3. Testing & evidence', 'COMPILE the Technical File using the template index (pulls in all of the above)', 'Rushroom', 'Fill template', 'Complete technical file', '01b', 'High — gate', 'Open', ARRAY['internal','reviewer']::text[]),
  (15, '4. Energy / EPREL', 'OBTAIN/verify ecodesign data: efficacy, flicker (PstLM<=1, SVM<=0.4), lumen maintenance, power factor', 'Rushroom (+ lab/supplier)', 'Test/collect data', 'Ecodesign data set', '2', 'High', 'Open', ARRAY['internal']::text[]),
  (16, '4. Energy / EPREL', 'REGISTER the light source in the EPREL database and produce the energy label — BEFORE first sale', 'Rushroom', 'eprel.ec.europa.eu', 'EPREL registration + label', '2', 'BLOCKER', 'Open', ARRAY['internal']::text[]),
  (17, '5. Registrations', 'WEEE: JOIN a PRO (e.g. El-Kretsen) AND register in the EE-registret with Naturvardsverket; set up annual report (by 31 Mar)', 'Rushroom', 'El-Kretsen + eeb.naturvardsverket.se', 'PRO agreement + registration confirmation', '4', 'BLOCKER', 'Open', ARRAY['internal']::text[]),
  (18, '5. Registrations', 'PACKAGING: document the reuse system + NOTIFY Naturvardsverket; register as packaging producer + annual report', 'Rushroom', 'Naturvardsverket', 'Reuse-system notification + registration', '4', 'High — by 2026-08-12', 'Open', ARRAY['internal']::text[]),
  (19, '5. Registrations', 'BATTERY register — only if step 4 = yes', 'Rushroom', 'Naturvardsverket', 'Battery registration', '4', 'Conditional', 'Open', ARRAY['internal']::text[]),
  (20, '6. Chemicals', 'COLLECT REACH/SVHC declarations; if any article > 0.1% w/w SVHC, submit a SCIP notification to ECHA', 'Rushroom', 'ECHA SCIP', 'SVHC declarations (+ SCIP ref if needed)', '3', 'Medium', 'Open', ARRAY['internal','supplier']::text[]),
  (21, '7. Self-declaration', 'DRAW UP and SIGN the EU Declaration of Conformity for the finished product, listing all applicable directives + standards (Rushroom does this itself)', 'Rushroom', 'Fill DoC template', 'Signed EU DoC', '01a', 'BLOCKER', 'Open', ARRAY['internal','reviewer']::text[]),
  (22, '7. Self-declaration', 'AFFIX the CE marking to the product per the marking spec (Rushroom does this itself, after steps 14 + 21)', 'Rushroom', 'Per CE spec', 'CE mark on product', '01c', 'BLOCKER', 'Open', ARRAY['internal','reviewer']::text[]),
  (23, '7. Self-declaration', 'DESIGN the product label combining: CE mark, manufacturer ID + address, type/batch no., ratings, WEEE crossed-out-bin (EN 50419), energy/EPREL', 'Rushroom', 'Artwork', 'Approved label artwork', '01c', 'High', 'Open', ARRAY['internal','reviewer']::text[]),
  (24, '8. Product info & install', 'FINALISE the Swedish user & safety instructions and ship them with every product', 'Rushroom', 'Finalise template', 'Final SV manual', '6', 'High', 'Open', ARRAY['internal','installer']::text[]),
  (25, '8. Product info & install', 'FINALISE the installer SOP and TRAIN installers; lock the plug-connection-only rule (no fixed 230V work)', 'Rushroom', 'Finalise + train', 'Final SOP + training record', '6', 'High', 'Open', ARRAY['internal','installer']::text[]),
  (26, '9. Liability & records', 'OBTAIN product liability insurance before first sale', 'Rushroom → insurer', 'Arrange policy', 'Insurance policy', '7', 'High', 'Open', ARRAY['internal']::text[]),
  (27, '9. Liability & records', 'POPULATE the Records Retention Log; keep DoC + technical file 10 years', 'Rushroom', 'Update log', 'Maintained log', '8', 'Ongoing', 'Open', ARRAY['internal','reviewer']::text[]),
  (28, '10. Ongoing', 'MONITOR standards/regulations monthly (automated watch agent already running)', 'Rushroom / agent', '09 folder', 'Monthly watch reports', '9', 'Ongoing', 'Active', ARRAY['internal']::text[]),
  (29, '10. Ongoing', 'RE-ISSUE the DoC / update the technical file whenever a supplier sends a Product Change Notification or a standard changes', 'Rushroom', 'On change', 'Updated DoC/file', '1', 'Ongoing', 'Open', ARRAY['internal','supplier','reviewer']::text[]),
  (30, '10. Ongoing', 'SUBMIT annual WEEE + packaging reports to Naturvardsverket by 31 March each year', 'Rushroom', 'Naturvardsverket', 'Filed reports', '4', 'Annual', 'Open', ARRAY['internal']::text[])
on conflict (step) do nothing;

insert into public.documents (category, name, url, audience) values
  ('Declarations & CE', 'EU Declaration of Conformity (template)', 'https://docs.google.com/document/d/1x5Llp1rEulCz_-7LtMBHT8wb6uVGpGhFeB03Q-63CnU/edit', ARRAY['internal','reviewer']::text[]),
  ('Declarations & CE', 'CE marking specification', 'https://docs.google.com/document/d/1ywY9J9Fgfl4_ExBdFA9gQwt3AkqABw8xz48KVbYaH0Y/edit', ARRAY['internal','supplier','reviewer']::text[]),
  ('Declarations & CE', 'PPWR Declaration of Conformity (reusable packaging)', 'https://docs.google.com/document/d/1Px8WdhGTlwEWB0mkYJc_0bTBbZp-PRTniUdXiTBAnzE/edit', ARRAY['internal']::text[]),
  ('Technical file', 'Technical File index (template)', 'https://docs.google.com/document/d/14vnhdLBOU_3gZToVHy_soRX1HqZvmgvmXAadoSGO6TM/edit', ARRAY['internal','reviewer']::text[]),
  ('Technical file', 'Compliance Audit File — README / map', 'https://docs.google.com/document/d/1e_Hvhyp50ST9l4NOG0A07Qy6b6xlDKJ2nLfV4GAzunc/edit', ARRAY['internal']::text[]),
  ('Technical file', 'Compliance Documentation Register', 'https://docs.google.com/spreadsheets/d/1W2BLk_gWH0QVZaN-zNdXnJ31ODC3trK0myIQNdJQAzk/edit', ARRAY['internal','reviewer']::text[]),
  ('Test reports', 'LVD / safety test report (IOS-PRF0032, AA-86878-25)', 'https://drive.google.com/file/d/1pXOt6Ol4MwmjvblUSY03vSpv9naXZ3GW/view', ARRAY['internal','reviewer']::text[]),
  ('Suppliers', 'Supplier Declaration of Compliance (form)', 'https://docs.google.com/document/d/1MNxJ_uByom-XcrnvrzbjyKhYbwEeD7gHmB0Kne9es4U/edit', ARRAY['internal','supplier']::text[]),
  ('Suppliers', 'Supplier Compliance Spec — LED strip & cabling/connectors', 'https://docs.google.com/spreadsheets/d/1Xz67mHsJ31HWQFXYLrn_xqkhhtxXZETun9f6jTk59JA/edit', ARRAY['internal','supplier']::text[]),
  ('Suppliers', 'Product Change Notification commitment (annex)', 'https://docs.google.com/document/d/1eqPeMt8QpsYHEpW9bclvyHA6veaHqKmi0PwGcHetHpU/edit', ARRAY['internal','supplier']::text[]),
  ('Materials & packaging', 'Packaging compliance checklist (reusable transport packaging)', 'https://docs.google.com/spreadsheets/d/1rrWd76T6SvcHF985jWgDrT8tzPa2pZ54uXFoI9fLVP4/edit', ARRAY['internal']::text[]),
  ('Records & monitoring', 'Records Retention Log', 'https://docs.google.com/spreadsheets/d/1mKgXaBHHghEF3l-qR7tdDC5PnS5wpUEAkAWFqJb9kcM/edit', ARRAY['internal']::text[]),
  ('Records & monitoring', 'Regulatory Watch — 2026-06', 'https://docs.google.com/document/d/1MO246WfK9Fnc7Es7-WZwAWwVvJrWkECXpEIJmVnIuS8/edit', ARRAY['internal','reviewer']::text[])
on conflict do nothing;
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
alter table public.users enable row level security;      -- deny-all; edge function uses service role
create index if not exists users_status_idx on public.users (status);
-- If the table already exists from an earlier version, add the password column:
alter table public.users add column if not exists password text;

-- ============================================================================
-- LEVEL 2 DATA ARCHITECTURE: Structured Clause-Level Interpretations
-- ============================================================================
-- Decomposed clauses from a specific version of a standard.
-- Populated either manually or via AI extraction from the standard PDF.
create table if not exists public.standard_clauses (
  id                   uuid primary key default gen_random_uuid(),
  standard_version_id  uuid not null references public.standard_versions(id) on delete cascade,
  clause_ref           text not null,        -- e.g. "4.11", "Annex B.2"
  clause_title         text,                 -- e.g. "Short-circuit protection"
  clause_text          text,                 -- verbatim or summarized requirement
  requirement_type     text default 'mandatory', -- 'mandatory' | 'conditional' | 'informative'
  parent_clause_id     uuid references public.standard_clauses(id) on delete set null,  -- for hierarchy
  sort_order           integer default 0,
  ai_generated         boolean default false,
  created_at           timestamptz not null default now(),
  unique(standard_version_id, clause_ref)
);
create index if not exists standard_clauses_std_version_idx on public.standard_clauses (standard_version_id);
create index if not exists standard_clauses_parent_idx on public.standard_clauses (parent_clause_id);

-- Our interpretation of each clause — this IS the As Operates at atomic level.
-- Stores compliance interpretation per clause, linked to a specific As Operates document version.
create table if not exists public.as_operates_interpretations (
  id                        uuid primary key default gen_random_uuid(),
  clause_id                 uuid not null references public.standard_clauses(id) on delete cascade,
  document_version_id       uuid not null references public.document_versions(id) on delete cascade,
  interpretation_text       text,        -- how we have implemented this requirement
  compliance_status         text default 'pending', -- 'compliant' | 'deviation' | 'not_applicable' | 'pending'
  rationale                 text,        -- why we interpret it this way
  evidence_refs             jsonb default '[]'::jsonb, -- [{type, label, storage_path, url}]
  deviation_description     text,        -- if deviation: what and why
  deviation_accepted_by     text,        -- who approved the deviation
  deviation_accepted_at     timestamptz,
  reviewed_by               text,        -- human reviewer (audit trail)
  reviewed_at               timestamptz,
  ai_generated              boolean default false,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique(clause_id, document_version_id)
);
create index if not exists as_op_interp_clause_idx on public.as_operates_interpretations (clause_id);
create index if not exists as_op_interp_doc_version_idx on public.as_operates_interpretations (document_version_id);
create index if not exists as_op_interp_status_idx on public.as_operates_interpretations (compliance_status);

-- DPP-ready product passport record (Level 3 preparation, ESPR furniture compliance 2027).
create table if not exists public.product_passports (
  id                                uuid primary key default gen_random_uuid(),
  product_name                      text not null,
  product_model                     text,
  manufacturer                      text default 'Rushroom AB',
  gtin                              text,  -- GS1 identifier when assigned
  declaration_of_conformity_ref     text,  -- link to DoC version
  applicable_standards              jsonb default '[]'::jsonb,  -- [{standard_id, version_id, clause_scope}]
  sustainability_data               jsonb default '{}'::jsonb,  -- {co2, materials, recyclability, etc.}
  passport_status                   text default 'draft',  -- 'draft' | 'active' | 'superseded'
  valid_from                        date,
  valid_to                          date,
  created_at                        timestamptz not null default now(),
  updated_at                        timestamptz not null default now()
);
create index if not exists product_passports_status_idx on public.product_passports (passport_status);

-- Link between a passport and specific interpretation records (many-to-many).
create table if not exists public.passport_interpretation_links (
  id                 uuid primary key default gen_random_uuid(),
  passport_id        uuid not null references public.product_passports(id) on delete cascade,
  interpretation_id  uuid not null references public.as_operates_interpretations(id) on delete cascade,
  relevance_note     text,
  created_at         timestamptz not null default now(),
  unique(passport_id, interpretation_id)
);
create index if not exists passport_interp_links_passport_idx on public.passport_interpretation_links (passport_id);

-- ---- RLS for new tables (deny-all; only edge function with service role can access) ----
alter table public.standard_clauses enable row level security;
alter table public.as_operates_interpretations enable row level security;
alter table public.product_passports enable row level security;
alter table public.passport_interpretation_links enable row level security;
