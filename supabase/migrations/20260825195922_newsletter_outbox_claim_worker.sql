-- Newsletter outbox worker claim helper.
-- This is separate from Q7: it only atomically claims an existing outbox row.
CREATE OR REPLACE FUNCTION public.claim_newsletter_outbox(
  p_lease_token text,
  p_lease_ms integer DEFAULT 60000
)
RETURNS SETOF public.newsletter_outbox
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF coalesce(btrim(p_lease_token), '') = '' THEN
    RAISE EXCEPTION 'NEWSLETTER_OUTBOX_LEASE_TOKEN_REQUIRED';
  END IF;

  IF p_lease_ms < 1000 OR p_lease_ms > 600000 THEN
    RAISE EXCEPTION 'NEWSLETTER_OUTBOX_LEASE_INVALID';
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT o.id
    FROM public.newsletter_outbox AS o
    WHERE o.status IN ('pending', 'retryable', 'processing')
      AND o.next_attempt_at <= now()
      AND (o.lease_until IS NULL OR o.lease_until <= now())
    ORDER BY o.next_attempt_at ASC, o.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.newsletter_outbox AS o
  SET status = 'processing',
      attempt_count = o.attempt_count + 1,
      lease_until = now() + (p_lease_ms || ' milliseconds')::interval,
      lease_token = btrim(p_lease_token),
      processing_started_at = coalesce(o.processing_started_at, now()),
      updated_at = now()
  FROM candidate
  WHERE o.id = candidate.id
  RETURNING o.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_newsletter_outbox(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_newsletter_outbox(text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_newsletter_outbox(text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_newsletter_outbox(text, integer) TO service_role;
