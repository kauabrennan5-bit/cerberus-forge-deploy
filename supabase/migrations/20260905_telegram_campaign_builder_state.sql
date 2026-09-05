create table if not exists public.telegram_user_states (
  sender_id text primary key,
  action text not null,
  review_id text,
  product_id text,
  data jsonb not null default '{}'::jsonb,
  updated_at bigint not null
);

alter table public.telegram_user_states enable row level security;
revoke all on table public.telegram_user_states from anon, authenticated;
grant select, insert, update, delete on table public.telegram_user_states to service_role;

create index if not exists idx_telegram_user_states_updated_at
  on public.telegram_user_states (updated_at);
