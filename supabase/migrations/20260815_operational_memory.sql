-- Cerberus Bloco 11: memória operacional durável mínima.
-- Aplicar somente após revisão administrativa no projeto Supabase canônico.
-- Não altera, lê ou escreve public.products.

create table if not exists public.operational_events (
  event_id text primary key,
  event_type text not null,
  event_timestamp timestamptz not null,
  source text not null,
  actor text not null check (actor in ('system', 'operator', 'human', 'automation', 'external', 'agent')),
  correlation_id text not null,
  causation_id text,
  severity text not null check (severity in ('DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL', 'SECURITY')),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  outcome text not null check (outcome in ('PENDING', 'SUCCESS', 'FAILED', 'BLOCKED', 'SKIPPED', 'APPROVAL_REQUIRED')),
  environment text not null check (environment in ('development', 'test', 'production', 'unknown')),
  schema_version text not null,
  created_at timestamptz not null default now()
);

create index if not exists operational_events_correlation_idx on public.operational_events(correlation_id, event_timestamp desc);
create index if not exists operational_events_type_idx on public.operational_events(event_type, event_timestamp desc);
create index if not exists operational_events_created_idx on public.operational_events(created_at desc);

create table if not exists public.operational_operations (
  operation_id text primary key,
  operation_type text not null,
  status text not null check (status in ('REQUESTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED')),
  actor text not null check (actor in ('system', 'operator', 'human', 'automation', 'external', 'agent')),
  correlation_id text not null,
  causation_id text,
  attempt integer not null default 1 check (attempt > 0),
  created_at timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  result_code text,
  error_code text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  schema_version text not null,
  updated_at timestamptz not null default now(),
  check (completed_at is null or completed_at >= created_at)
);

create index if not exists operational_operations_correlation_idx on public.operational_operations(correlation_id, created_at desc);
create index if not exists operational_operations_status_idx on public.operational_operations(status, updated_at desc);
create index if not exists operational_operations_created_idx on public.operational_operations(created_at desc);

create table if not exists public.operational_incidents (
  incident_id text primary key,
  incident_type text not null,
  fingerprint text not null,
  severity text not null check (severity in ('INFO', 'WARNING', 'ERROR', 'CRITICAL')),
  status text not null check (status in ('OPEN', 'ACKNOWLEDGED', 'RECOVERING', 'RESOLVED', 'BLOCKED')),
  created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  source text not null,
  correlation_id text not null,
  operation_id text not null,
  summary text not null,
  error_code text,
  impact text not null,
  recoverability text not null check (recoverability in ('AUTO', 'ADMIN_APPROVAL', 'MANUAL', 'NOT_APPLICABLE')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object')
);

create index if not exists operational_incidents_operation_idx on public.operational_incidents(operation_id, created_at desc);
create index if not exists operational_incidents_correlation_idx on public.operational_incidents(correlation_id, created_at desc);
create index if not exists operational_incidents_status_idx on public.operational_incidents(status, updated_at desc);

create table if not exists public.operational_recovery_attempts (
  attempt_id text primary key,
  incident_id text not null references public.operational_incidents(incident_id) on delete restrict,
  operation_id text not null,
  attempt_number integer not null check (attempt_number > 0),
  strategy text not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  outcome text not null check (outcome in ('PENDING', 'SUCCESS', 'FAILED', 'SKIPPED', 'BLOCKED')),
  error_code text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object')
);

create index if not exists operational_recovery_incident_idx on public.operational_recovery_attempts(incident_id, attempt_number);
create index if not exists operational_recovery_operation_idx on public.operational_recovery_attempts(operation_id, started_at desc);

alter table public.operational_events enable row level security;
alter table public.operational_operations enable row level security;
alter table public.operational_incidents enable row level security;
alter table public.operational_recovery_attempts enable row level security;

-- O backend usa a service role. Nenhuma leitura ou escrita pública é permitida.
-- Não criar policies anon/authenticated para estas tabelas.

comment on table public.operational_events is 'Fatos operacionais sanitizados do Cerberus; não é fonte canônica de produtos nem autoridade.';
comment on table public.operational_operations is 'Journal estruturado de operações do Cerberus; não executa ações nem faz replay.';
comment on table public.operational_incidents is 'Contexto durável de incidentes; não substitui a máquina de estados do Operator.';
comment on table public.operational_recovery_attempts is 'Registro durável de tentativas de recovery; não inicia replay automático.';
