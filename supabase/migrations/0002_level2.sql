-- ============================================================================
-- 0002_level2.sql — LEVEL 2 DATA ARCHITECTURE: Structured Clause-Level Interpretations
-- Tables: standard_clauses, as_operates_interpretations, product_passports,
-- passport_interpretation_links.
-- Depends on 0001 (standard_versions, document_versions). Idempotent.
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
-- Optional: keep the prior interpretation text so the UI can show a version diff.
alter table public.as_operates_interpretations add column if not exists previous_interpretation_text text;
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
