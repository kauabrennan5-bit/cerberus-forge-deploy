-- Cerberus Finds Archive — Bloco N4 — Filtro e Priorização Cerberus
-- Migration estritamente aditiva: CRIA as tabelas public.filter_definitions
-- e public.candidate_assessment.
-- NÃO altera, remove ou recria nenhuma tabela, coluna, índice ou policy existente.
-- Padrão: RLS ON, zero policies públicas, CHECKs fechados (catálogos),
-- idempotência (idempotency_key UNIQUE), auditável, com versionamento de regras.
--
-- CANDIDATE != FACT CANÔNICO:
-- Estas tabelas NUNCA referenciam public.products. O filtro avalia
-- candidatos; a promoção a produto canônico é outra autoridade.
-- RECOMMENDATION != ACTION:
-- Nenhuma coluna executa ação. is_actionable = false sempre nesta fase.

-- ============================================================================
-- Tabela 1: definições de regras do filtro (versionamento)
-- Persiste a REGRA vigente como entidade imutável (padrão Experiment Registry).
-- v2 aponta para v1 em superseded_by — nunca sobrescreve silenciosamente.
-- ============================================================================
create table if not exists public.filter_definitions (
  filter_id text primary key,
  filter_key text not null unique,
  schema_version text not null default '1.0',
  rules_version text not null
    check (rules_version in ('cerberus_filter_v1')),
  weights jsonb not null default '{}'::jsonb
    check (jsonb_typeof(weights) = 'object'),
  classification_rules jsonb not null default '{}'::jsonb
    check (jsonb_typeof(classification_rules) = 'object'),
  niches jsonb not null default '[]'::jsonb
    check (jsonb_typeof(niches) = 'array'),
  price_context jsonb not null default '{}'::jsonb
    check (jsonb_typeof(price_context) = 'object'),
  rationale text not null default '',
  rationale_by_axis jsonb not null default '{}'::jsonb
    check (jsonb_typeof(rationale_by_axis) = 'object'),
  superseded_by text null,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object')
);

-- ============================================================================
-- Tabela 2: avaliações de candidatos (execução do filtro)
-- Uma nova avaliação NUNCA apaga a anterior: mesmo (candidate_id, rules_version)
-- pode gerar linhas distintas quando as evidências mudam; o histórico é a
-- verdade. idempotency_key (digest determinístico) evita duplicação
-- exata do mesmo material avaliado pela mesma versão de regras.
-- ============================================================================
create table if not exists public.candidate_assessment (
  assessment_id text primary key,
  candidate_id text not null,
  filter_version text not null
    check (filter_version in ('cerberus_filter_v1', 'n13:curator_v1')),
  -- Resultado multidimensional (os 9 eixos, nunca "score mágico" solto)
  dimensions jsonb not null default '{}'::jsonb
    check (jsonb_typeof(dimensions) = 'object'),
  -- Classificação: hipótese formal com critérios versionados
  classification text
    check (classification in ('WINNER', 'HIDDEN_GEM', 'NICHE_DROP', 'INSUFFICIENT', 'NOT_RECOMMENDED')),
  classification_basis text not null default '',
  -- Recomendação NÃO acionável (RECOMMENDATION != ACTION)
  recommendation text
    check (recommendation in ('NONE', 'INVESTIGATE_FURTHER', 'ADD_TO_NICHE', 'PARK', 'REJECT')),
  recommendation_basis text not null default '',
  is_actionable boolean not null default false
    check (is_actionable = false),
  -- Prioridade derivada (explicável; nunca exibida sem dimensions)
  priority jsonb not null default '{}'::jsonb
    check (jsonb_typeof(priority) = 'object'),
  priority_level text
    check (priority_level in ('HIGH', 'MEDIUM', 'LOW', 'NO_ACTION')),
  priority_score numeric(5, 4),
  scoring_version text not null default 'cerberus_priority_v1',
  -- Incerteza exposta (nunca escondida)
  unknowns jsonb not null default '[]'::jsonb
    check (jsonb_typeof(unknowns) = 'array'),
  contradictions jsonb not null default '[]'::jsonb
    check (jsonb_typeof(contradictions) = 'array'),
  collection_failures jsonb not null default '[]'::jsonb
    check (jsonb_typeof(collection_failures) = 'array'),
  -- Proveniência: ponteiros para candidate_evidence (nunca cópia)
  evidence_refs jsonb not null default '[]'::jsonb
    check (jsonb_typeof(evidence_refs) = 'array'),
  -- Reprodutibilidade
  input_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(input_snapshot) = 'object'),
  correlation_id text,
  idempotency_key text unique,
  -- Auditoria
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  schema_version text not null default '1.0'
);

-- Índices de leitura e idempotência
create index if not exists idx_candidate_assessment_candidate on public.candidate_assessment (candidate_id, created_at desc);
create index if not exists idx_candidate_assessment_version on public.candidate_assessment (filter_version, created_at desc);
create index if not exists idx_candidate_assessment_classification on public.candidate_assessment (classification, created_at desc);
create index if not exists idx_candidate_assessment_idempotency on public.candidate_assessment (idempotency_key) where idempotency_key is not null;

-- RLS: padrão do Bloco 13 / N3. Zero policies públicas.
alter table public.filter_definitions enable row level security;
alter table public.candidate_assessment enable row level security;

-- O backend usa a service role. Nenhuma leitura ou escrita pública é permitida.
-- Não criar policies anon/authenticated para estas tabelas.

comment on table public.filter_definitions is 'Regras do filtro Cerberus como entidade versionada e imutável; nova versão aponta a anterior em superseded_by, nunca sobrescreve.';
comment on table public.candidate_assessment is 'Avaliação formal de um candidato pelos 9 eixos do filtro; RECOMMENDATION != ACTION (is_actionable=false), não referencia products e não executa ação.';
