-- ============================================================
-- Bloco 14 — Cérebro Comercial V1 — Fase B
-- Persistência aditiva: 2 tabelas para artefatos analíticos.
--
-- Fronteiras: MEMORY != AUTHORITY · OBSERVATION != FACT CANÔNICO
--             SIGNAL != REVENUE · RECOMMENDATION != ACTION
--
-- Estas tabelas NÃO criam autoridade. Não alteram products,
-- catálogo, lifecycle, job_queue, Telegram ou Operator.
-- NÃO APLICADA EM PRODUÇÃO NESTA FASE — permanece local.
-- ============================================================

-- Tabela 1: sinais + evidências (estágio perceptivo)
create table if not exists public.commercial_signals (
  signal_id text primary key,
  product_id text references public.products(id) on delete restrict,
  signal_type text not null check (signal_type in (
    'PRICE_IMPROVEMENT', 'PRICE_DETERIORATION', 'PRICE_BELOW_CANONICAL',
    'PRICE_OUTLIER', 'AVAILABILITY_RISK', 'AVAILABILITY_IMPROVEMENT',
    'SOURCE_CONVERGENCE', 'SOURCE_DIVERGENCE', 'INTEREST_ABOVE_BASELINE',
    'INTEREST_BELOW_BASELINE', 'INTEREST_NO_BASELINE', 'OBSERVATION_STALE'
  )),
  signal_category text not null check (signal_category in ('price', 'availability', 'source', 'interest', 'freshness')),
  metric text not null,
  current_value text not null,
  baseline_value text not null,
  delta text not null,
  analysis_window text not null check (analysis_window in ('24h', '7d', '30d', 'lifetime')),
  baseline_window text,
  evidence_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_refs) = 'array'),
  confidence text not null check (confidence in ('HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT_EVIDENCE')),
  confidence_basis text not null default '',
  analysis_version text not null default 'commercial_brain_v1',
  input_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(input_snapshot) = 'object'),
  detected_at timestamptz not null,
  correlation_id text,
  idempotency_key text unique,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  schema_version text not null default '1.0',
  created_at timestamptz not null default now()
);

-- Tabela 2: oportunidades + riscos + recomendações (estágio deliberativo)
create table if not exists public.commercial_artifacts (
  artifact_id text primary key,
  product_id text references public.products(id) on delete restrict,
  artifact_type text not null check (artifact_type in ('opportunity', 'risk', 'recommendation')),
  subject text not null,
  subject_ref text not null,
  signal_type text not null,
  signal_id text,
  suggested_action text not null default '',
  confidence text not null check (confidence in ('HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT_EVIDENCE')),
  confidence_basis text not null default '',
  priority jsonb not null default '{}'::jsonb check (jsonb_typeof(priority) = 'object'),
  priority_level text check (priority_level in ('HIGH', 'MEDIUM', 'LOW', 'NO_ACTION')),
  priority_score numeric(5, 4),
  impact text,
  cost text,
  risk text,
  status text not null default 'ACTIVE',
  baseline_statement text,
  review_deadline timestamptz,
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  scoring_version text not null default 'priority_model_v1',
  confidence_version text not null default 'confidence_model_v1',
  analysis_version text not null default 'commercial_brain_v1',
  created_at timestamptz not null default now(),
  correlation_id text,
  idempotency_key text unique,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  schema_version text not null default '1.0'
);

-- Índices: leitura por produto, período, tipo, versão e correlação
create index if not exists commercial_signals_product_idx on public.commercial_signals(product_id, detected_at desc);
create index if not exists commercial_signals_type_idx on public.commercial_signals(signal_type, detected_at desc);
create index if not exists commercial_signals_version_idx on public.commercial_signals(analysis_version, detected_at desc);
create index if not exists commercial_signals_correlation_idx on public.commercial_signals(correlation_id) where correlation_id is not null;
create index if not exists commercial_artifacts_product_idx on public.commercial_artifacts(product_id, created_at desc);
create index if not exists commercial_artifacts_type_idx on public.commercial_artifacts(artifact_type, created_at desc);
create index if not exists commercial_artifacts_version_idx on public.commercial_artifacts(scoring_version, created_at desc);
create index if not exists commercial_artifacts_correlation_idx on public.commercial_artifacts(correlation_id) where correlation_id is not null;

-- RLS: padrão do Bloco 13. Zero policies públicas.
alter table public.commercial_signals enable row level security;
alter table public.commercial_artifacts enable row level security;

-- O backend usa a service role. Nenhuma leitura ou escrita pública é permitida.
-- Não criar policies anon/authenticated para estas tabelas.

comment on table public.commercial_signals is 'Sinal analítico com evidências por ponteiro; não é fato canônico, não altera products e não executa ação.';
comment on table public.commercial_artifacts is 'Oportunidade, risco ou recomendação derivada; memória de decisão, sem autoridade operacional. RECOMMENDATION != ACTION.';
