begin;

alter table public.email_campaigns
  drop constraint if exists email_campaigns_campaign_type_check;

alter table public.email_campaigns
  drop constraint if exists email_campaigns_product_reference_check;

alter table public.email_campaigns
  add constraint email_campaigns_campaign_type_check
  check (campaign_type in ('product', 'welcome', 'collection'));

alter table public.email_campaigns
  add constraint email_campaigns_product_reference_check
  check (
    (campaign_type = 'product' and product_id is not null)
    or (campaign_type in ('welcome', 'collection') and product_id is null)
  );

create table public.email_campaign_products (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.email_campaigns(id) on delete cascade,
  product_id text not null references public.products(id) on delete restrict,
  position integer not null check (position between 1 and 50),
  layout text not null default 'grid' check (layout in ('feature', 'grid')),
  created_at timestamptz not null default now(),
  constraint email_campaign_products_campaign_position_key unique (campaign_id, position),
  constraint email_campaign_products_campaign_product_key unique (campaign_id, product_id)
);

create index email_campaign_products_campaign_position_idx
  on public.email_campaign_products (campaign_id, position);

create index email_campaign_products_product_idx
  on public.email_campaign_products (product_id, created_at desc);

alter table public.email_campaign_products enable row level security;
revoke all on table public.email_campaign_products from public;
revoke all on table public.email_campaign_products from anon;
revoke all on table public.email_campaign_products from authenticated;
grant all on table public.email_campaign_products to service_role;

commit;
