-- ============================================================================
-- 0005_links.sql — REQUIREMENT LINKS: cross-document clause & text linking
-- ("Requirement Threads"). Tables: requirement_links, document_statements.
--
-- A typed, evidenced, reviewable edge between two addressable text units — today
-- a standard clause (standard_clauses) or a document version (document_versions);
-- an As-Operated "statement" endpoint can be added later without changing shape.
-- Generalises the directive_relations pattern (type / confidence / source /
-- status). Manual links are created 'accepted'; AI/imported links start 'proposed'.
-- Endpoints are stored as (type, id) rather than FKs so both kinds share one row;
-- referential cleanup is handled in the Edge Function. RLS denies direct access.
-- Depends on 0001 (document_versions). Idempotent.
-- ============================================================================
create table if not exists public.requirement_links (
  id             uuid primary key default gen_random_uuid(),
  from_type      text not null,                    -- 'clause' | 'document_version'
  from_id        uuid not null,
  to_type        text not null,                    -- 'clause' | 'document_version'
  to_id          uuid not null,
  link_type      text not null default 'same_clause',
  -- 'same_clause' | 'citation' | 'implements' | 'similar_intent' |
  -- 'defines_terms_for' | 'supersedes' | 'conflicts_with'
  confidence     double precision default 1.0,     -- 1.0 manual/exact, 0.0-1.0 for AI
  source         text default 'manual',            -- 'manual' | 'cited' | 'imported' | 'ai_assisted' | 'derived'
  status         text default 'accepted',          -- 'proposed' | 'accepted' | 'rejected' | 'flagged' | 'archived'
  rationale      text,
  evidence_from  text,                             -- matched snippet on the from side
  evidence_to    text,                             -- matched snippet on the to side
  created_by     text,
  reviewed_by    text,
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique(from_type, from_id, to_type, to_id, link_type)
);
create index if not exists requirement_links_from_idx on public.requirement_links (from_type, from_id);
create index if not exists requirement_links_to_idx   on public.requirement_links (to_type, to_id);

alter table public.requirement_links enable row level security;

-- As-Operated "statements": a document version broken into addressable paragraphs,
-- so a requirement_link can point at a specific paragraph (endpoint type
-- 'statement') rather than the whole document. Segmented client-side from the
-- stored file text; re-segmenting replaces the set for that version.
create table if not exists public.document_statements (
  id                  uuid primary key default gen_random_uuid(),
  document_version_id uuid not null references public.document_versions(id) on delete cascade,
  seq                 integer not null default 0,        -- 0-based paragraph order
  text                text not null default '',
  anchor              text,                              -- optional heading/label
  created_at          timestamptz not null default now(),
  unique(document_version_id, seq)
);
create index if not exists document_statements_docver_idx on public.document_statements (document_version_id);

alter table public.document_statements enable row level security;
