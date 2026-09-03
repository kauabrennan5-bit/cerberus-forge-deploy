-- ============================================================
-- Bloco 16 — Fase D — Execution Journal do Agent Runtime
-- ============================================================
-- ADITIVA: não altera products, job_queue, commercial_signals,
-- commercial_artifacts, operational_*, operator_state nem qualquer
-- tabela existente. Cria APENAS public.agent_executions.
-- Fronteiras: POLICY != EXECUTION · DECISION != EXECUTION
--             ALLOW != EXECUTION · REQUIRES_APPROVAL != APPROVAL
--             EXECUTOR != AUTHORITY
--
-- Propósito: persistir o registro auditável de cada execução governada
-- (execution_id determinístico, intention_key idempotente, decisão de
-- política, estado de aprovação e resultado sanitizado), fechando o loop
-- REQUEST → POLICY DECISION → APPROVAL → EXECUTION → RESULT.
--
-- NÃO APLICADA EM PRODUÇÃO NESTA FASE — permanece local até autorização
-- explícita. RLS ON com ZERO policies públicas: somente o backend
-- (service role) lê/escreve.
-- ============================================================

create table if not exists public.agent_executions (
  -- Identidade determinística da execução (única, gerada a partir do
  -- intention_key + contexto de identidade; fail-closed se ambíguo)
  execution_id text primary key,
  -- Chave de intenção: mesma intenção = mesma identidade de execução.
  intention_key text not null,
  -- Identidade declarada do agente (preservada exatamente como solicitada)
  agent_id text not null,
  agent_version text not null,
  -- Versões de contrato preservadas (a execução é reproduzível por elas)
  policy_version text not null,
  runtime_version text not null,
  -- Tool/action permitidas pelo catálogo fechado do Agent Registry
  tool text not null check (tool in (
    'catalog.read', 'observations.read', 'commercial.analyze',
    'commercial.recommend', 'commercial.signals.read',
    'job_queue.read', 'job_queue.enqueue', 'telegram.send',
    'telegram.status', 'products.read', 'products.write',
    'operational.read', 'operator.approve', 'operator.mode.read',
    'lifecycle.read'
  )),
  action text not null check (action in (
    'READ_PRODUCT', 'READ_OBSERVATION', 'ANALYZE_PRODUCT',
    'READ_COMMERCIAL_SIGNAL', 'READ_COMMERCIAL_ARTIFACT',
    'READ_JOB_QUEUE', 'READ_OPERATIONAL_EVENT',
    'CREATE_RECOMMENDATION', 'CREATE_SIGNAL', 'PUBLISH_PRODUCT',
    'UPDATE_PRODUCT', 'DELETE_PRODUCT', 'UPDATE_PRICE',
    'SEND_TELEGRAM', 'ENQUEUE_JOB', 'RUN_RECOVERY'
  )),
  risk text not null check (risk in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  -- Alvo da execução (tabela canônica derivada/declarada; nunca wildcard)
  target_table text not null check (target_table in (
    'products', 'catalog_categories', 'product_clicks',
    'product_price_observed', 'product_availability_observed',
    'product_source_observed', 'product_image_observed',
    'commercial_signals', 'commercial_artifacts', 'job_queue',
    'operational_events', 'operational_incidents',
    'operational_recovery_attempts', 'operator_state'
  )),
  target_type text not null check (target_type in (
    'PRODUCT', 'OBSERVATION', 'SIGNAL', 'JOB', 'EVENT', 'NONE'
  )),
  target_id text,
  -- Decisão do Policy Engine que autorizou (ou negou) a execução
  decision text not null check (decision in ('ALLOW', 'DENY', 'REQUIRES_APPROVAL')),
  reason_code text not null,
  -- Estado de aprovação vinculado ao plan (PENDING/REJECTED/EXPIRED não
  -- autorizam; APPROVED exige re-avaliação de política)
  approval_state text check (approval_state in (
    'NONE', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'NOT_REQUIRED'
  )),
  -- Approval id oficial (NULL quando aprovação não é exigida; jamais o
  -- approvalId declarado pelo próprio agente)
  approval_id text,
  -- Estado de lifecycle na máquina fechada da Fase A (13 estados)
  lifecycle_state text not null check (lifecycle_state in (
    'REQUESTED', 'POLICY_EVALUATED', 'DENIED', 'WAITING_APPROVAL',
    'APPROVED', 'PLANNED', 'RUNNING', 'SUCCEEDED', 'FAILED',
    'TIMED_OUT', 'CANCELLED', 'REJECTED', 'EXPIRED'
  )),
  -- Resultado estruturado (ExecutionResult): referência, erro sanitizado
  result_reference text,
  error_code text,
  error_message text,
  -- Digest determinístico do input (nunca o input bruto)
  input_fingerprint text not null,
  input_reference text not null,
  -- Digest do contexto de identidade (idempotência por conteúdo)
  identity_context_digest text not null,
  -- Status do executor na fronteira (EXECUTED somente via adapter;
  -- NOT_CONNECTED é resultado, não sucesso)
  executor_status text not null check (executor_status in (
    'NOT_CONNECTED', 'SKIPPED', 'EXECUTED'
  )),
  executor_adapter_version text,
  -- Correlação e causação (proveniência)
  correlation_id text,
  request_id text not null,
  requested_by text check (requested_by in (
    'operator', 'operator-admin', 'system'
  )),
  evaluation_id text,
  -- Timestamps
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  -- Metadados mínimos e sanitizados (jamais credenciais, prompts ou
  -- conteúdo bruto; jsonb object)
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object')
);

-- Idempotência: a mesma intention_key aparece no máximo uma vez com um
-- dado contexto de identidade. Duplicate idêntico → identical_duplicate;
-- mesmo intention_key com contexto diferente → INTENTION_CONFLICT
-- (rejeitado pelo repository). Índices parciais evitam hash de NULL.
create unique index if not exists agent_executions_intention_key_idx
  on public.agent_executions (intention_key, identity_context_digest);
create unique index if not exists agent_executions_request_id_idx
  on public.agent_executions (request_id);

-- Consultas de auditoria e journal read-only
create index if not exists agent_executions_decision_idx
  on public.agent_executions (decision, created_at desc);
create index if not exists agent_executions_agent_idx
  on public.agent_executions (agent_id, agent_version, created_at desc);
create index if not exists agent_executions_lifecycle_idx
  on public.agent_executions (lifecycle_state, created_at desc);
create index if not exists agent_executions_correlation_idx
  on public.agent_executions (correlation_id)
  where correlation_id is not null;
create index if not exists agent_executions_evaluation_idx
  on public.agent_executions (evaluation_id)
  where evaluation_id is not null;
create index if not exists agent_executions_tool_action_idx
  on public.agent_executions (tool, action, created_at desc);
create index if not exists agent_executions_created_at_idx
  on public.agent_executions (created_at desc);

-- RLS: padrão dos Blocos 13/14/15. Zero policies públicas.
alter table public.agent_executions enable row level security;
-- O backend usa a service role. Nenhuma leitura ou escrita pública é permitida.
-- Não criar policies anon/authenticated para esta tabela.

comment on table public.agent_executions is 'Journal auditável de execuções governadas do Agent Runtime; registra intenção autorizada, decisão, aprovação e resultado sanitizado. DECISION != EXECUTION · ALLOW != EXECUTION · EXECUTOR != AUTHORITY.';
comment on column public.agent_executions.execution_id is 'Identidade determinística da execução (intention_key + contexto de identidade).';
comment on column public.agent_executions.intention_key is 'Chave de intenção determinística: mesma intenção = mesma identidade de execução (idempotência).';
comment on column public.agent_executions.input_fingerprint is 'Digest determinístico do input; nunca o conteúdo bruto.';
comment on column public.agent_executions.identity_context_digest is 'Digest do contexto relevante (tool, action, inputReference, target, risk, memory scope, decisão, policy_version) usado para detecção de colisão de intenção.';
comment on column public.agent_executions.executor_status is 'Status na fronteira do executor: EXECUTED somente via adapter conectado; NOT_CONNECTED é resultado explícito, nunca sucesso.';
