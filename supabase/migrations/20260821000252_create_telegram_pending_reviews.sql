create table if not exists public.telegram_pending_reviews (
  id text primary key, chat_id text not null, sender_id text not null, first_name text, username text,
  created_at bigint not null, expires_at bigint not null, status text not null default 'pending', data jsonb,
  inserted_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
