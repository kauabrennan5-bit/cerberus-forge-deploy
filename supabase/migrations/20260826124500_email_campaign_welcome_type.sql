begin;

alter table public.email_campaigns
  alter column product_id drop not null;

alter table public.email_campaigns
  add column campaign_type text not null default 'product';

alter table public.email_campaigns
  add constraint email_campaigns_campaign_type_check
  check (campaign_type in ('product', 'welcome'));

alter table public.email_campaigns
  add constraint email_campaigns_product_reference_check
  check (
    (campaign_type = 'product' and product_id is not null)
    or (campaign_type = 'welcome' and product_id is null)
  );

commit;
