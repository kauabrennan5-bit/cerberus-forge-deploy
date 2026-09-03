-- Persiste o cartão Telegram atual de uma campanha para reconciliação idempotente.
-- Esta migration é somente local nesta tarefa e não deve ser aplicada automaticamente.

begin;

create table if not exists public.email_campaign_telegram_cards (
  campaign_id uuid primary key references public.email_campaigns(id) on delete cascade,
  chat_id text not null check (char_length(btrim(chat_id)) > 0),
  message_id bigint not null check (message_id > 0),
  updated_at timestamptz not null default now()
);

create index if not exists email_campaign_telegram_cards_updated_idx
  on public.email_campaign_telegram_cards (updated_at desc);

alter table public.email_campaign_telegram_cards enable row level security;
revoke all on table public.email_campaign_telegram_cards from public;
revoke all on table public.email_campaign_telegram_cards from anon;
revoke all on table public.email_campaign_telegram_cards from authenticated;
grant all on table public.email_campaign_telegram_cards to service_role;

commit;
