-- N16 — Publicação Automática Governada, Fase 1 local.
-- NÃO aplicar em produção sem autorização explícita da Fase 2.
-- N15 permanece a única autoridade; esta tabela registra execução e resultado.

create table if not exists public.publication_executions (
  execution_id text primary key,
  execution_key text unique,
  candidate_id text not null,
  n15_authorization_digest text,
  publication_payload_digest text,
  destination text not null,
  action text not null check (action = 'PUBLISH'),
  status text not null check (status in ('PENDING','VALIDATING','AUTHORIZED','EXECUTING','PUBLISHED','FAILED','AMBIGUOUS','BLOCKED','CANCELLED')),
  reason_codes text[] not null default '{}',
  provider_reference text,
  result jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object'),
  error_code text,
  error_message text,
  request_id text not null,
  correlation_id text,
  proof_run_id text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object')
);

create index if not exists publication_executions_candidate_idx on public.publication_executions (candidate_id, created_at desc);
create index if not exists publication_executions_status_idx on public.publication_executions (status, created_at desc);
create index if not exists publication_executions_request_idx on public.publication_executions (request_id);
create index if not exists publication_executions_proof_run_idx on public.publication_executions (proof_run_id, created_at desc);

alter table public.publication_executions enable row level security;
-- Zero policies públicas. O backend usa a service role.

comment on table public.publication_executions is 'N16 execution ledger; consumes only N15 APPROVED PUBLISH authorizations and never creates canonical products.';
comment on column public.publication_executions.execution_key is 'SHA256(candidate_id + n15_authorization_digest + publication_payload_digest + destination + action).';
