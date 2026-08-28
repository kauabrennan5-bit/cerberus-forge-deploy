-- Cerberus Bloco 12: fila de jobs durável (job_queue).
-- Aplicar somente após revisão administrativa no projeto Supabase canônico.
-- Não altera, lê ou escreve public.products.
-- Infraestrutura de agendamento: nenhum job é executado automaticamente até
-- autorização humana explícita de um handler específico.

create function public.set_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.job_queue (
  job_id text primary key,
  type text not null check (type in ('catalog_sync', 'telegram_send', 'product_ingest_review', 'operational_recovery', 'maintenance')),
  status text not null default 'QUEUED' check (status in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'RETRYING', 'DEAD_LETTER', 'CANCELLED')),
  priority integer not null default 0 check (priority between -100 and 100),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  next_run_at timestamptz not null default now(),
  lease timestamptz,
  timeout_ms integer not null default 60000 check (timeout_ms between 1000 and 600000),
  idempotency_key text unique,
  created_by text not null check (created_by in ('system', 'operator', 'human', 'automation', 'external', 'agent')),
  cost_estimate jsonb not null default '{}'::jsonb check (jsonb_typeof(cost_estimate) = 'object'),
  last_error text,
  correlation_id text not null,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  result jsonb check (result is null or jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger job_queue_set_updated_at
  before update on public.job_queue
  for each row execute function public.set_updated_at();

create index if not exists job_queue_claim_idx on public.job_queue(status, next_run_at asc);
create index if not exists job_queue_lease_idx on public.job_queue(status, lease asc) where lease is not null;
create index if not exists job_queue_idempotency_idx on public.job_queue(idempotency_key);
create index if not exists job_queue_type_status_idx on public.job_queue(type, status);
create index if not exists job_queue_correlation_idx on public.job_queue(correlation_id);

alter table public.job_queue enable row level security;
