-- TASK Q7 — RPC transacional newsletter + outbox
-- PROPOSTA/APLICAÇÃO CONTROLADA: cria somente a function e sua segurança.
-- Não altera RLS, policies, grants ou schema das tabelas existentes.
BEGIN;

CREATE FUNCTION public.confirm_newsletter_consent_with_outbox(
  p_email text,
  p_marketing_consent boolean,
  p_correlation_id text,
  p_causation_id text,
  p_idempotency_key text,
  p_payload_version text,
  p_payload jsonb
)
RETURNS TABLE (
  result text,
  subscriber_status text,
  outbox_id text,
  idempotency_key text,
  correlation_id text,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_email text;
  v_correlation_id text;
  v_causation_id text;
  v_idempotency_key text;
  v_payload_version text;
  v_payload jsonb;
  v_status text;
  v_marketing_consent boolean;
  v_existing_outbox_id text;
  v_existing_subscriber_email text;
  v_existing_event_type text;
  v_existing_operation_type text;
  v_existing_correlation_id text;
  v_existing_payload_version text;
  v_existing_payload jsonb;
  v_outbox_id text;
BEGIN
  v_email := lower(btrim(coalesce(p_email, '')));
  IF v_email = '' OR v_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EMAIL';
  END IF;

  IF p_marketing_consent IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CONSENT_REQUIRED';
  END IF;

  v_correlation_id := btrim(coalesce(p_correlation_id, ''));
  IF v_correlation_id = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CORRELATION_ID_REQUIRED';
  END IF;

  v_causation_id := NULLIF(btrim(coalesce(p_causation_id, '')), '');
  v_idempotency_key := btrim(coalesce(p_idempotency_key, ''));
  IF v_idempotency_key = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;

  v_payload_version := btrim(coalesce(p_payload_version, ''));
  IF v_payload_version <> '1.0' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'UNSUPPORTED_PAYLOAD_VERSION';
  END IF;

  v_payload := coalesce(p_payload, '{}'::jsonb);
  IF jsonb_typeof(v_payload) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'PAYLOAD_OBJECT_REQUIRED';
  END IF;
  IF length(v_payload::text) > 4096 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'PAYLOAD_TOO_LARGE';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(v_payload) AS allowed_key(key)
    WHERE key NOT IN ('template_key', 'locale', 'campaign_id', 'content_variant')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'PAYLOAD_KEY_NOT_ALLOWED';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_each(v_payload) AS field(key, value)
    WHERE key NOT IN ('template_key', 'locale', 'campaign_id', 'content_variant')
       OR jsonb_typeof(value) IN ('object', 'array')
       OR lower(key) IN (
         'secret', 'api_key', 'apikey', 'service_role_key', 'password',
         'authorization', 'credential', 'unsubscribe_token', 'unsubscribe_token_hash'
       )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'PAYLOAD_KEY_OR_VALUE_FORBIDDEN';
  END IF;

  -- INSERT ... ON CONFLICT serializa novos e-mails concorrentes pela PK email.
  INSERT INTO public.newsletter_subscribers (
    email,
    status,
    marketing_consent,
    consent_at,
    consent_source,
    consent_purpose,
    consent_policy_version,
    unsubscribe_at,
    unsubscribe_source,
    suppression_reason,
    unsubscribe_token_hash,
    unsubscribe_token_expires_at,
    updated_at
  ) VALUES (
    v_email,
    'subscribed',
    TRUE,
    clock_timestamp(),
    'site_newsletter_form',
    'new_selections_recommendations_promotional_offers',
    'newsletter-consent-v1',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    clock_timestamp()
  )
  ON CONFLICT (email) DO NOTHING;

  -- O lock de linha serializa requests para o mesmo assinante após o INSERT.
  SELECT ns.status, ns.marketing_consent
    INTO v_status, v_marketing_consent
  FROM public.newsletter_subscribers AS ns
  WHERE ns.email = v_email
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SUBSCRIBER_LOCK_FAILED';
  END IF;

  IF v_status IN ('suppressed', 'unsubscribed') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NEWSLETTER_RECONSENT_REQUIRED';
  END IF;
  IF v_status <> 'subscribed' OR v_marketing_consent IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NEWSLETTER_NOT_ELIGIBLE';
  END IF;

  -- Replays são resolvidos sob o lock do assinante e sem sobrescrever evidência histórica.
  SELECT
    o.id,
    o.subscriber_email,
    o.event_type,
    o.operation_type,
    o.correlation_id,
    o.payload_version,
    o.payload
    INTO
      v_existing_outbox_id,
      v_existing_subscriber_email,
      v_existing_event_type,
      v_existing_operation_type,
      v_existing_correlation_id,
      v_existing_payload_version,
      v_existing_payload
  FROM public.newsletter_outbox AS o
  WHERE o.idempotency_key = v_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing_subscriber_email <> v_email
       OR v_existing_event_type <> 'newsletter_subscribed'
       OR v_existing_operation_type <> 'project_to_provider'
       OR v_existing_correlation_id <> v_correlation_id
       OR v_existing_payload_version <> v_payload_version
       OR v_existing_payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OUTBOX_IDEMPOTENCY_COLLISION';
    END IF;

    RETURN QUERY SELECT
      'replayed'::text,
      'subscribed'::text,
      v_existing_outbox_id,
      v_idempotency_key,
      v_correlation_id,
      TRUE;
    RETURN;
  END IF;

  v_outbox_id := 'nout-' || md5(v_idempotency_key || '|newsletter_subscribed|project_to_provider');

  INSERT INTO public.newsletter_outbox (
    id,
    subscriber_email,
    event_type,
    operation_type,
    status,
    correlation_id,
    causation_id,
    idempotency_key,
    payload_version,
    payload,
    attempt_count,
    max_attempts,
    next_attempt_at,
    lease_until,
    lease_token,
    last_error_code,
    last_error_message,
    provider_reference,
    created_at,
    updated_at,
    processing_started_at,
    succeeded_at,
    failed_at
  ) VALUES (
    v_outbox_id,
    v_email,
    'newsletter_subscribed',
    'project_to_provider',
    'pending',
    v_correlation_id,
    v_causation_id,
    v_idempotency_key,
    v_payload_version,
    v_payload,
    0,
    3,
    clock_timestamp(),
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    clock_timestamp(),
    clock_timestamp(),
    NULL,
    NULL,
    NULL
  )
  ON CONFLICT ON CONSTRAINT newsletter_outbox_idempotency_key_key DO NOTHING
  RETURNING id INTO v_outbox_id;

  IF v_outbox_id IS NULL THEN
    SELECT
      o.id,
      o.subscriber_email,
      o.event_type,
      o.operation_type,
      o.correlation_id,
      o.payload_version,
      o.payload
      INTO
        v_existing_outbox_id,
        v_existing_subscriber_email,
        v_existing_event_type,
        v_existing_operation_type,
        v_existing_correlation_id,
        v_existing_payload_version,
        v_existing_payload
    FROM public.newsletter_outbox AS o
    WHERE o.idempotency_key = v_idempotency_key
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OUTBOX_INSERT_RACE_UNRESOLVED';
    END IF;
    IF v_existing_subscriber_email <> v_email
       OR v_existing_event_type <> 'newsletter_subscribed'
       OR v_existing_operation_type <> 'project_to_provider'
       OR v_existing_correlation_id <> v_correlation_id
       OR v_existing_payload_version <> v_payload_version
       OR v_existing_payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OUTBOX_IDEMPOTENCY_COLLISION';
    END IF;

    RETURN QUERY SELECT
      'replayed'::text,
      'subscribed'::text,
      v_existing_outbox_id,
      v_idempotency_key,
      v_correlation_id,
      TRUE;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    'created'::text,
    'subscribed'::text,
    v_outbox_id,
    v_idempotency_key,
    v_correlation_id,
    FALSE;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.confirm_newsletter_consent_with_outbox(text, boolean, text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.confirm_newsletter_consent_with_outbox(text, boolean, text, text, text, text, jsonb)
  TO service_role;

COMMIT;
