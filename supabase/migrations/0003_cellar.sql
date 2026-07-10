-- ============================================================================
-- 0003_cellar.sql — EU DIRECTIVE RELATIONSHIP ANALYSER (CELLAR / EUR-Lex)
-- Tables: eu_directives, directive_relations, product_directive_applicability,
-- cellar_cache. Plus the VALCYRA directive seed.
--
-- Maps how EU directives/regulations relate to each other — both at company
-- level (which apply to Rushroom AB as a business) and at product level (which
-- apply to a specific product passport). Data is drawn from the EU Publications
-- Office CELLAR SPARQL endpoint (public, no auth) and, on demand, AI inference.
-- All access is via the portal-api Edge Function (service role); RLS denies direct.
-- Depends on 0002 (product_passports). Idempotent.
-- ============================================================================

-- Registry of EU directives and regulations tracked by the company.
create table if not exists public.eu_directives (
  id                 uuid primary key default gen_random_uuid(),
  celex_number       text unique not null,             -- e.g. '32014L0035' (LVD)
  short_name         text not null,                    -- e.g. 'LVD', 'EMC', 'ESPR', 'RoHS'
  official_title     text,
  directive_type     text,                             -- 'directive' | 'regulation' | 'decision'
  status             text default 'active',            -- 'active' | 'repealed' | 'amended'
  in_force_date      date,
  scope_description  text,                             -- human-readable scope summary
  eur_lex_url        text,
  applies_to_company boolean default false,
  created_at         timestamptz not null default now()
);
create index if not exists eu_directives_company_idx on public.eu_directives (applies_to_company);

-- Links between directives — explicit (CELLAR / Akoma Ntoso <ref>) and AI-inferred.
create table if not exists public.directive_relations (
  id                  uuid primary key default gen_random_uuid(),
  source_directive_id uuid not null references public.eu_directives(id) on delete cascade,
  target_directive_id uuid references public.eu_directives(id) on delete cascade,
  target_celex        text,                            -- keep the CELEX even when the target isn't in the registry yet (gap)
  source_clause_ref   text default '',                 -- e.g. 'Article 3'
  target_clause_ref   text default '',                 -- e.g. 'Article 5'
  relation_type       text not null,
  -- 'requires' | 'supplements' | 'implements' | 'amends' |
  -- 'supersedes' | 'references' | 'conflicts_with' | 'defines_terms_for'
  relation_description text,
  source              text,                            -- 'cellar_sparql' | 'akn_ref_element' | 'ai_inferred'
  confidence          double precision default 1.0,    -- 1.0 for CELLAR data, 0.0-1.0 for AI
  verified            boolean default false,
  created_at          timestamptz not null default now(),
  unique(source_directive_id, target_celex, relation_type, source_clause_ref)
);
create index if not exists directive_relations_source_idx on public.directive_relations (source_directive_id);
create index if not exists directive_relations_target_idx on public.directive_relations (target_directive_id);

-- Directive applicability per product/component/service (linked to a passport).
create table if not exists public.product_directive_applicability (
  id                  uuid primary key default gen_random_uuid(),
  passport_id         uuid not null references public.product_passports(id) on delete cascade,
  directive_id        uuid not null references public.eu_directives(id) on delete cascade,
  applicability_status text default 'applicable',      -- 'applicable' | 'not_applicable' | 'partial' | 'under_review'
  rationale           text,
  assessed_by         text,
  assessed_at         timestamptz,
  created_at          timestamptz not null default now(),
  unique(passport_id, directive_id)
);
create index if not exists prod_dir_applic_passport_idx on public.product_directive_applicability (passport_id);

-- Raw CELLAR query cache — re-fetch only if older than 7 days (see cellar-service.ts).
create table if not exists public.cellar_cache (
  id            uuid primary key default gen_random_uuid(),
  celex_number  text not null,
  query_type    text not null,                          -- 'metadata' | 'relations' | 'fulltext'
  result_jsonb  jsonb not null default '{}'::jsonb,
  fetched_at    timestamptz not null default now(),
  unique(celex_number, query_type)
);
create index if not exists cellar_cache_lookup_idx on public.cellar_cache (celex_number, query_type);

alter table public.eu_directives                    enable row level security;
alter table public.directive_relations              enable row level security;
alter table public.product_directive_applicability  enable row level security;
alter table public.cellar_cache                     enable row level security;

-- The VALCYRA directive registry (LVD, EMC, RoHS, WEEE, Machinery, Batteries,
-- ESPR) is seeded in supabase/seed.sql.
