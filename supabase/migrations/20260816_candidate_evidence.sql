-- Cerberus Finds Archive — Bloco N3 — Pipeline de Pesquisa + Evidência
-- Migration estritamente aditiva: CRIA a tabela public.candidate_evidence.
-- NÃO altera, remove ou recria nenhuma tabela, coluna, índice ou policy existente.
-- Padrão: RLS ON, zero policies públicas, CHECKs fechados (catálogos),
-- idempotência (evidence_id PK + field_hash UNIQUE), auditável.
--
-- EVIDENCE != FACT CANÔNICO · OBSERVATION != FACT CANÔNICO:
-- Uma evidência é um registro auditável de algo observado (ou não observado,
-- ou derivado, ou contradito) durante uma pesquisa de um candidato.
-- NUNCA é um fato, produto, decisão ou publicação. Nenhuma coluna desta
-- tabela referencia public.products. O vínculo com public.candidates é por
-- texto (sem FK): o candidato pode ser removido pela curadoria sem apagar a
-- evidência (preservação de histórico).

create table if not exists public.candidate_evidence (
  evidence_id text primary key,
  -- Associação (sem FK por texto — histórico preservado mesmo sem candidato)
  candidate_id text not null,
  research_id text not null,
  -- Tipo do registro
  kind text not null check (kind in ('RESEARCH_SESSION', 'FIELD')),
  -- Campo observado (somente kind = 'FIELD')
  field_name text null
    check (kind = 'RESEARCH_SESSION' or field_name in ('title', 'price', 'images', 'seller', 'rating', 'review_count', 'availability', 'category')),
  field_value jsonb null,
  -- Estado do dado (proveniência obrigatória)
  field_state text not null
    check (field_state in ('KNOWN', 'UNKNOWN', 'DERIVED', 'COLLECTION_FAILED', 'CONTRADICTED')),
  -- Fonte
  source_url text not null,
  source_type text not null
    check (source_type in ('marketplace_page', 'url_slug', 'manual', 'api', 'scrape', 'other')),
  collection_method text not null
    check (collection_method in ('MANUAL', 'SCRAPE', 'API', 'OTHER')),
  observed_at timestamptz not null,
  -- Reprodutibilidade e idempotência
  evidence_hash text not null default '',
  field_hash text unique,
  -- Qualidade heurística (declarativa, NUNCA probabilidade)
  quality text not null default 'UNKNOWN'
    check (quality in ('HIGH', 'MEDIUM', 'LOW', 'UNKNOWN')),
  unit text null,
  -- Diagnóstico legível (inclui motivo de falha e descrição de contradição)
  evidence_note text not null default '',
  -- Auditoria
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

comment on table public.candidate_evidence is 'Bloco N3: Pipeline de Pesquisa + Evidência — EVIDENCE != FACT CANÔNICO. Registro auditável de sessões de pesquisa e evidências de campo de candidatos. Nunca tratar evidência como fato, produto ou decisão. RESEARCH != PUBLICATION · RESEARCH != PROMOTION.';

-- CHECK: URL original não pode ser vazia ou homepage genérica (mesma regra do N1)
alter table public.candidate_evidence add constraint candidate_evidence_source_url_not_empty
  check (char_length(source_url) > 8);

-- Índices (somente aditivos)
create index if not exists idx_candidate_evidence_candidate on public.candidate_evidence (candidate_id);
create index if not exists idx_candidate_evidence_research on public.candidate_evidence (research_id);
create index if not exists idx_candidate_evidence_field_hash on public.candidate_evidence (field_hash) where field_hash is not null;
create index if not exists idx_candidate_evidence_field_state on public.candidate_evidence (field_state);
create index if not exists idx_candidate_evidence_observed_at on public.candidate_evidence (observed_at desc);

-- Row Level Security: ativo; SEM políticas públicas (somente service role / backend).
alter table public.candidate_evidence enable row level security;

-- Garantir que nenhuma policy pública exista (idempotente).
do $$
declare
  _pol record;
begin
  for _pol in (
    select policyname from pg_policies
    where tablename = 'candidate_evidence' and schemaname = 'public'
  ) loop
    execute format('drop policy if exists %I on public.candidate_evidence', _pol.policyname);
  end loop;
end $$;
