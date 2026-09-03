-- Current outbox table required to replay the surviving newsletter history.
-- The original persistence migrations are recorded in the LIVE ledger but their
-- full SQL artifacts are no longer present in this repository.

create table if not exists public.newsletter_outbox (
  id text primary key,
  subscriber_email text not null references public.newsletter_subscribers(email) on delete restrict,
  event_type text not null,
  operation_type text not null,
  status text not null default 'pending',
  correlation_id text not null,
  causation_id text,
  idempotency_key text not null unique,
  payload_version text not null default '1.0',
  payload jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  lease_token text,
  last_error_code text,
  last_error_message text,
  provider_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processing_started_at timestamptz,
  succeeded_at timestamptz,
  failed_at timestamptz,
  constraint newsletter_outbox_attempt_count_check check (attempt_count >= 0),
  constraint newsletter_outbox_max_attempts_check check (max_attempts between 1 and 10),
  constraint newsletter_outbox_event_type_check check (event_type = 'newsletter_subscribed'),
  constraint newsletter_outbox_operation_type_check check (operation_type = 'project_to_provider'),
  constraint newsletter_outbox_payload_check check (jsonb_typeof(payload) = 'object'),
  constraint newsletter_outbox_status_check check (status in ('pending','processing','succeeded','retryable','dead_letter','cancelled')),
  constraint newsletter_outbox_processing_lease_check check (status <> 'processing' or (lease_until is not null and lease_token is not null)),
  constraint newsletter_outbox_terminal_timestamp_check check ((status <> 'succeeded' or succeeded_at is not null) and (status <> 'dead_letter' or failed_at is not null))
);
alter table public.newsletter_outbox enable row level security;
