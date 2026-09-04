BEGIN;

CREATE TABLE public.newsletter_outbox (
  id text PRIMARY KEY,
  subscriber_email text NOT NULL
    REFERENCES public.newsletter_subscribers(email) ON DELETE RESTRICT,
  event_type text NOT NULL
    CHECK (event_type = 'newsletter_subscribed'),
  operation_type text NOT NULL
    CHECK (operation_type = 'project_to_provider'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'retryable', 'dead_letter', 'cancelled')),
  correlation_id text NOT NULL,
  causation_id text,
  idempotency_key text NOT NULL UNIQUE,
  payload_version text NOT NULL DEFAULT '1.0',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object'),
  attempt_count integer NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3
    CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token text,
  last_error_code text,
  last_error_message text,
  provider_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  processing_started_at timestamptz,
  succeeded_at timestamptz,
  failed_at timestamptz,
  CONSTRAINT newsletter_outbox_processing_lease_check CHECK (
    status <> 'processing' OR (lease_until IS NOT NULL AND lease_token IS NOT NULL)
  ),
  CONSTRAINT newsletter_outbox_terminal_timestamp_check CHECK (
    (status <> 'succeeded' OR succeeded_at IS NOT NULL)
    AND (status <> 'dead_letter' OR failed_at IS NOT NULL)
  )
);

CREATE INDEX newsletter_outbox_claim_idx
  ON public.newsletter_outbox(status, next_attempt_at ASC);

CREATE INDEX newsletter_outbox_lease_idx
  ON public.newsletter_outbox(status, lease_until ASC)
  WHERE lease_until IS NOT NULL;

CREATE INDEX newsletter_outbox_subscriber_idx
  ON public.newsletter_outbox(subscriber_email, created_at DESC);

COMMIT;
