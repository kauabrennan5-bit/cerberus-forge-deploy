-- Cerberus Finds Archive — Bloco 17 — Experiment Registry
-- Migration estritamente aditiva: CRIA a tabela public.experiments.
-- NÃO altera, remove ou recria nenhuma tabela, coluna, índice ou policy existente.
-- Padrão: RLS ON, zero policies públicas, CHECKs fechados (catálogos do Bloco 17),
-- idempotência (experiment_id PK + experiment_key UNIQUE), auditável.

create table if not exists public.experiments (
  experiment_id text primary key,
  experiment_key text not null unique,

  -- Identificação e versão
  schema_version text not null default '1.0',
  statistical_rigor_version text not null default 'statistical_rigor_v1',

  -- Hipótese e design (texto livre auditável)
  hypothesis text not null,
  rationale text not null default '',

  -- Variantes: nomes simbólicos (não executam nada por si)
  variant_a_label text not null,
  variant_b_label text not null,

  -- População alvo: produto(s) canônico(s) sob observação
  target_population text not null,
  target_product_ids text[] not null,

  -- Métrica de sucesso declarada ANTES do experimento (proveniência)
  success_metric text not null,
  metric_definition text not null,

  -- Parâmetros de projeto do teste (derivação documentada)
  design_alpha numeric not null default 0.05,
  design_power numeric not null default 0.80,
  design_mde_relative numeric not null default 0.50,
  design_baseline_proportion numeric not null default 0.02,
  fdr numeric not null default 0.10,
  min_sample_size integer not null,
  planned_duration_days integer not null default 7,

  -- Execução (observada)
  start_date timestamptz,
  planned_end_date timestamptz,
  sample_size integer not null default 0,
  sample_size_a integer not null default 0,
  sample_size_b integer not null default 0,
  clicks_a integer not null default 0,
  clicks_b integer not null default 0,

  -- Lifecycle fechado (somente via repository; CHECK espelha o código)
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'RUNNING', 'ENDED', 'CANCELLED')),

  -- Decisão: NUNCA preenche antes do gate estatístico (repository)
  decision text null
    check (decision in ('SCALE', 'MAINTAIN', 'KILL', 'INCONCLUSIVE')),
  decision_basis text null,
  decided_at timestamptz null,
  decided_by text null,

  -- Auditoria
  created_by text not null default 'operator-admin',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.experiments is 'Bloco 17: Experiment Registry — registro formal de experimentos de decisão comercial. Decisão só é permitida após gate estatístico (amostra mínima ou fim do período). NENHUMA execução material ocorre por esta tabela.';

-- Índices (somente aditivos)
create index if not exists idx_experiments_status on public.experiments (status);
create index if not exists idx_experiments_target_population on public.experiments (target_population);
create index if not exists idx_experiments_created_at on public.experiments (created_at desc);

-- Row Level Security: ativo; SEM políticas públicas (somente service role / backend).
alter table public.experiments enable row level security;
-- Garantir que nenhuma policy pública exista (idempotente).
do $$
declare
  _pol record;
begin
  for _pol in (
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'experiments'
  ) loop
    execute format('drop policy if exists %I on public.experiments', _pol.policyname);
  end loop;
end $$;
