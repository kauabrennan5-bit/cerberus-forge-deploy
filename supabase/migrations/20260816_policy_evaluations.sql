-- ============================================================
-- Bloco 15 — Fase C — Decision Journal do Policy Engine
-- ============================================================
-- ADITIVA: não altera products, job_queue, commercial_signals,
-- commercial_artifacts, operational_* nem qualquer tabela existente.
-- Fronteiras: POLICY != EXECUTION · DECISION JOURNAL != EXECUTOR
--             ALLOW != EXECUTION · REQUIRES_APPROVAL != APPROVAL
-- NÃO APLICADA EM PRODUÇÃO NESTA FASE — permanece local.
-- A migration será aplicada apenas mediante autorização explícita.
-- ============================================================

create table if not exists public.policy_evaluations (
  -- Identidade determinística da avaliação (única)
  evaluation_id text primary key,
  -- Identidade declarada do agente (preservada exatamente como solicitada)
  agent_id text not null,
  agent_version text not null,
  -- Versões de contrato preservadas (a decisão é reproduzível por elas)
  policy_version text not null,
  policy_engine_version text not null,
  policy_reason_code_version text not null default '1.0',
  -- Decisão e explicação (catálogos fechados via CHECK)
  decision text not null check (decision in ('ALLOW', 'DENY', 'REQUIRES_APPROVAL')),
  reason_code text not null check (reason_code in (
    'AGENT_NOT_FOUND', 'AGENT_DISABLED', 'AGENT_VERSION_MISMATCH',
    'POLICY_VERSION_MISMATCH', 'TOOL_NOT_ALLOWED', 'ACTION_NOT_ALLOWED',
    'TABLE_NOT_ALLOWED', 'RISK_EXCEEDS_MAX', 'MEMORY_SCOPE_NOT_ALLOWED',
    'TOOL_ACTION_MISMATCH', 'ACTION_RISK_MISMATCH', 'APPROVAL_REQUIRED',
    'CONTEXT_INVALID', 'REQUEST_INVALID', 'POLICY_ENGINE_ERROR',
    'TOOL_UNKNOWN', 'ACTION_UNKNOWN', 'TABLE_UNKNOWN',
    'MEMORY_SCOPE_UNKNOWN', 'RISK_UNKNOWN',
    'VERSION_MISMATCH', 'AGENT_UNKNOWN', 'POLICY_ALLOW'
  )),
  reason text not null default '',
  -- Declaração da solicitação (preservada como foi recebida)
  tool text not null,
  action text not null,
  risk text not null check (risk in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  target_table text not null,
  memory_scope text not null,
  context text,
  approval_state text check (approval_state in ('NONE', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  -- Correlação (proveniência): quem/donde originou esta avaliação, opcional
  correlation_id text,
  -- Causação (a ação ou incidente que motivou a avaliação), opcional
  causation_id text,
  -- Digest determinístico do request completo (para idempotência por conteúdo)
  request_fingerprint text not null,
  -- Digest da decisão produzida (verificação de integridade do registro)
  decision_fingerprint text not null,
  -- Resultados individuais de cada verificação da cadeia (JSON estruturado)
  checks jsonb not null default '{}'::jsonb check (jsonb_typeof(checks) = 'object'),
  evaluated_at timestamptz not null,
  -- Metadados mínimos e sanitizados (jamais credenciais, prompts ou conteúdo bruto)
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  -- Versionamento do schema da tabela
  schema_version text not null default '1.0',
  created_at timestamptz not null default now()
);

-- Concorrência: o journal tolera chamadas concorrentes pelo UNIQUE da
-- evaluation_id (PK). Duplicate idêntico → detectado pela comparação de
-- content (request_fingerprint + decision_fingerprint + checks); o
-- repository distingue identical vs conflict explicitamente, sem lock
-- em memória.
create unique index if not exists policy_evaluations_request_fingerprint_idx
  on public.policy_evaluations(request_fingerprint);
create index if not exists policy_evaluations_decision_idx
  on public.policy_evaluations(decision, evaluated_at desc);
create index if not exists policy_evaluations_agent_idx
  on public.policy_evaluations(agent_id, agent_version, evaluated_at desc);
create index if not exists policy_evaluations_correlation_idx
  on public.policy_evaluations(correlation_id)
  where correlation_id is not null;
create index if not exists policy_evaluations_causation_idx
  on public.policy_evaluations(causation_id)
  where causation_id is not null;
create index if not exists policy_evaluations_evaluated_at_idx
  on public.policy_evaluations(evaluated_at desc);

-- RLS: padrão dos Blocos 13/14. Zero policies públicas.
alter table public.policy_evaluations enable row level security;
-- O backend usa a service role. Nenhuma leitura ou escrita pública é permitida.
-- Não criar policies anon/authenticated para esta tabela.

comment on table public.policy_evaluations is 'Journal auditável de decisões do Policy Engine; registra avaliação, nunca executa ação. DECISION JOURNAL != EXECUTOR · ALLOW != EXECUTION.';
comment on column public.policy_evaluations.request_fingerprint is 'Digest determinístico do request completo; identifica a avaliação lógica para idempotência.';
comment on column public.policy_evaluations.decision_fingerprint is 'Digest do contrato da decisão (decision+reasonCode+checks), para verificação de integridade do registro.';
