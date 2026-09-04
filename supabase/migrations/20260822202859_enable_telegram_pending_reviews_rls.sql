BEGIN;
ALTER TABLE public.telegram_pending_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.telegram_pending_reviews FROM anon, authenticated;
COMMIT;
