alter table public.telegram_pending_reviews enable row level security;
revoke all on table public.telegram_pending_reviews from anon, authenticated;
