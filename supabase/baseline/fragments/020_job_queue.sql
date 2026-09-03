-- Baseline fragment copied from the historical Cerberus schema artifact.

create table if not exists public.job_queue (
  job_id text primary key,
  type text not null,
  status text not null default 'QUEUED',
  priority integer not null default 0,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  next_run_at timestamptz not null default now(),
  lease timestamptz,
  timeout_ms integer not null default 60000,
  idempotency_key text unique,
  created_by text not null,
  cost_estimate jsonb not null default '{}'::jsonb,
  last_error text,
  correlation_id text not null,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_queue_status_check check (status in ('QUEUED','RUNNING','SUCCEEDED','FAILED','RETRYING','DEAD_LETTER','CANCELLED')),
  constraint job_queue_type_check check (type in ('catalog_sync','telegram_send','product_ingest_review','operational_recovery','maintenance')),
  constraint job_queue_priority_check check (priority between -100 and 100),
  constraint job_queue_attempts_check check (attempts >= 0),
  constraint job_queue_max_attempts_check check (max_attempts between 1 and 10),
  constraint job_queue_timeout_ms_check check (timeout_ms between 1000 and 600000),
  constraint job_queue_created_by_check check (created_by in ('system','operator','human','automation','external','agent')),
  constraint job_queue_cost_estimate_check check (jsonb_typeof(cost_estimate) = 'object'),
  constraint job_queue_payload_check check (jsonb_typeof(payload) = 'object'),
  constraint job_queue_result_check check (result is null or jsonb_typeof(result) = 'object')
);
alter table public.job_queue enable row level security;
