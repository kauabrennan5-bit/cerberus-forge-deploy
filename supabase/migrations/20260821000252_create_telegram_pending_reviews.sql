CREATE TABLE IF NOT EXISTS public.telegram_pending_reviews (
  id text PRIMARY KEY,
  chat_id text NOT NULL,
  sender_id text NOT NULL,
  first_name text,
  username text,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  data jsonb,
  inserted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tpr_status ON public.telegram_pending_reviews (status);
CREATE INDEX IF NOT EXISTS idx_tpr_expires ON public.telegram_pending_reviews (expires_at);
