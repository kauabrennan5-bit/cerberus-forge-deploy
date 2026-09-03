begin;

alter table public.email_campaigns
  add column if not exists edition_key text;

create unique index if not exists email_campaigns_edition_key_unique
  on public.email_campaigns (edition_key)
  where campaign_type = 'collection'
    and edition_key is not null
    and status <> 'cancelled';

commit;

-- A chave é preenchida somente para novas campanhas collection pelo serviço.
-- Registros históricos sem edition_key permanecem preservados e não são alterados.
