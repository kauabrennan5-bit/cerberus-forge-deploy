BEGIN;

ALTER TABLE public.newsletter_outbox
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.newsletter_outbox
  FROM PUBLIC, anon, authenticated;

COMMIT;
