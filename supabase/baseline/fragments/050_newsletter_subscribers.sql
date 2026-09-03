-- Historical newsletter subscriber base table. LIVE contains this object before
-- the first newsletter migration version preserved in the remote history.
begin;
create table if not exists public.newsletter_subscribers (
  email text primary key,
  created_at timestamptz not null default now(),
  constraint newsletter_subscribers_email_normalized_check check (email = lower(btrim(email))),
  constraint newsletter_subscribers_email_format_check check (email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$')
);
create index if not exists newsletter_subscribers_created_at_idx on public.newsletter_subscribers (created_at desc);
alter table public.newsletter_subscribers enable row level security;
revoke all on table public.newsletter_subscribers from anon, authenticated;
commit;
