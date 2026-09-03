BEGIN;
ALTER TABLE public.newsletter_subscribers
  ADD CONSTRAINT newsletter_subscribers_subscribed_consent_check
  CHECK (
    status IS DISTINCT FROM 'subscribed'
    OR (
      marketing_consent IS TRUE
      AND consent_at IS NOT NULL
      AND consent_source IS NOT NULL
      AND btrim(consent_source) <> ''
      AND consent_purpose IS NOT NULL
      AND btrim(consent_purpose) <> ''
      AND consent_policy_version IS NOT NULL
      AND btrim(consent_policy_version) <> ''
    )
  );
COMMIT;
