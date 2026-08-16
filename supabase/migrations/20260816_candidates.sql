-- Cerberus Finds Archive — Bloco N1 — Contratos de Descoberta
-- Migration estritamente aditiva: CRIA a tabela public.candidates.
-- NÃO altera, remove ou recria nenhuma tabela, coluna, índice ou policy existente.
-- Padrão: RLS ON, zero policies públicas, CHECKs fechados (catálogos),
-- idempotência (candidate_id PK + listing_key UNIQUE), auditável.
--
-- CANDIDATE != FACT CANÔNICO:
-- Um candidato é uma projeção de um produto descoberto, nunca um fato.
-- Não existe FK para public.products: o vínculo promoted_product_id é
-- registro opcional (quando a curadoria converte o candidato em canônico),
-- nunca migração de identidade.

create table if not exists public.candidates (
  candidate_id text primary key,
  listing_key text not null unique,
  -- Identificação e versão
  schema_version text not null default '1.0',
  discovery_rigor_version text not null default '1.0',
  -- Origem (proveniência obrigatória)
  marketplace text not null check (marketplace in ('Shopee', 'Mercado Livre', 'Outro')),
  merchant text not null default '',
  source_url text not null,
  external_listing_id text not null,
  -- Observações do achado (podem ser nulas quando a evidência não chegou)
  title text not null default '',
  description text not null default '',
  category text not null default '',
  observed_price numeric null,
  observed_rating numeric null check (observed_rating is null or (observed_rating >= 0 and observed_rating <= 5)),
  observed_rating_count integer null check (observed_rating_count is null or observed_rating_count >= 0),
  observed_availability text not null default 'UNKNOWN'
    check (observed_availability in ('IN_STOCK', 'OUT_OF_STOCK', 'UNAVAILABLE', 'UNKNOWN')),
  observed_at timestamptz not null default now(),
  -- Evidência bruta
  evidence_hash text not null default '',
  collection_method text not null default 'MANUAL'
    check (collection_method in ('MANUAL', 'SCRAPE', 'API', 'OTHER')),
  raw_snapshot_url text null,
  -- Funil fechado (somente via candidatesRepository; CHECK espelha o código)
  status text not null default 'DISCOVERED'
    check (status in ('DISCOVERED', 'REVIEWING', 'APPROVED', 'REJECTED', 'INCONCLUSIVE', 'WITHDRAWN')),
  funnel_stage text not null default 'INTAKE'
    check (funnel_stage in ('INTAKE', 'EVIDENCE_OK', 'AWAITING_REVIEW', 'REVIEWED', 'FUNNEL_END')),
  review_notes text not null default '',
  rejection_reason text null,
  reviewed_at timestamptz null,
  reviewed_by text null,
  -- Vínculo futuro (registro, nunca migração de identidade)
  promoted_product_id text null,
  promoted_at timestamptz null,
  -- Auditoria
  idempotency_key text unique,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_by text not null default 'operator-admin',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.candidates is 'Bloco N1: Contratos de Descoberta — produto descoberto ANTES de ser canônico. NUNCA tratar candidato como fato, produto ou decisão. A conversão em produto canônico é outra entidade e outro fluxo (N3/N5).';

-- CHECK: URL original não pode ser homepage genérica (mesma regra do productAutomation)
alter table public.candidates add constraint candidates_source_url_not_empty
  check (char_length(source_url) > 8);

-- Índices (somente aditivos)
create index if not exists idx_candidates_status on public.candidates (status);
create index if not exists idx_candidates_funnel_stage on public.candidates (funnel_stage);
create index if not exists idx_candidates_marketplace on public.candidates (marketplace);
create index if not exists idx_candidates_promoted on public.candidates (promoted_product_id) where promoted_product_id is not null;
create index if not exists idx_candidates_observed_at on public.candidates (observed_at desc);
create index if not exists idx_candidates_listing_key on public.candidates (listing_key);

-- Row Level Security: ativo; SEM políticas públicas (somente service role / backend).
alter table public.candidates enable row level security;

-- Garantir que nenhuma policy pública exista (idempotente).
do $$
declare
  _pol record;
begin
  for _pol in (
    select policyname from pg_policies
    where tablename = 'candidates' and schemaname = 'public'
  ) loop
    execute format('drop policy if exists %I on public.candidates', _pol.policyname);
  end loop;
end $$;
