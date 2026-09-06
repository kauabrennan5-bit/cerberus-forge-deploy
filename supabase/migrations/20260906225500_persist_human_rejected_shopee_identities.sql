create or replace function public.cerberus_suppress_rejected_source_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shop_id text;
  v_item_id text;
  v_source_url text;
begin
  if coalesce(new.status, '') <> 'rejected' then
    return new;
  end if;
  if tg_op = 'UPDATE' and coalesce(old.status, '') = 'rejected' then
    return new;
  end if;

  v_shop_id := nullif(btrim(coalesce(new.data #>> '{existingProduct,shopId}', '')), '');
  v_item_id := nullif(btrim(coalesce(new.data #>> '{existingProduct,itemId}', '')), '');
  if v_shop_id is null or v_item_id is null then return new; end if;

  v_source_url := coalesce(
    nullif(btrim(new.data ->> 'normalizedUrl'), ''),
    nullif(btrim(new.data #>> '{lifecycle,candidate,normalizedUrl}'), ''),
    'https://shopee.com.br/product/' || v_shop_id || '/' || v_item_id
  );

  insert into public.product_source_identities (
    marketplace, shop_id, item_id, source_product_url,
    product_id, review_id, source, reserved_run_id, reserved_until, updated_at
  ) values (
    'Shopee', v_shop_id, v_item_id, v_source_url,
    null, new.id, 'human_rejected', null, '9999-12-31 23:59:59+00'::timestamptz, now()
  )
  on conflict (marketplace, shop_id, item_id) do update
  set source_product_url = excluded.source_product_url,
      review_id = excluded.review_id,
      source = 'human_rejected',
      reserved_run_id = null,
      reserved_until = '9999-12-31 23:59:59+00'::timestamptz,
      updated_at = now()
  where public.product_source_identities.product_id is null;

  return new;
end;
$$;

drop trigger if exists trg_suppress_rejected_source_identity on public.telegram_pending_reviews;
create trigger trg_suppress_rejected_source_identity
after insert or update of status on public.telegram_pending_reviews
for each row
execute function public.cerberus_suppress_rejected_source_identity();

create or replace function public.cerberus_block_rejected_identity_pending_review()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shop_id text;
  v_item_id text;
begin
  if coalesce(new.status, '') <> 'pending' then
    return new;
  end if;
  if tg_op = 'UPDATE' and coalesce(old.status, '') = 'pending' then
    return new;
  end if;

  v_shop_id := nullif(btrim(coalesce(new.data #>> '{existingProduct,shopId}', '')), '');
  v_item_id := nullif(btrim(coalesce(new.data #>> '{existingProduct,itemId}', '')), '');
  if v_shop_id is null or v_item_id is null then
    return new;
  end if;

  if exists (
    select 1
    from public.product_source_identities psi
    where psi.marketplace = 'Shopee'
      and psi.shop_id = v_shop_id
      and psi.item_id = v_item_id
      and psi.product_id is null
      and psi.source = 'human_rejected'
  ) then
    raise exception using
      errcode = '23514',
      message = 'TELEGRAM_REVIEW_HUMAN_REJECTED_IDENTITY:' || v_shop_id || ':' || v_item_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_block_rejected_identity_pending_review on public.telegram_pending_reviews;
create trigger trg_block_rejected_identity_pending_review
before insert or update of status, data on public.telegram_pending_reviews
for each row
execute function public.cerberus_block_rejected_identity_pending_review();

with latest_decision as (
  select distinct on (shop_id, item_id)
    review_id,
    shop_id,
    item_id,
    status,
    source_url,
    updated_at
  from (
    select
      t.id as review_id,
      nullif(btrim(t.data #>> '{existingProduct,shopId}'), '') as shop_id,
      nullif(btrim(t.data #>> '{existingProduct,itemId}'), '') as item_id,
      t.status,
      coalesce(
        nullif(btrim(t.data ->> 'normalizedUrl'), ''),
        nullif(btrim(t.data #>> '{lifecycle,candidate,normalizedUrl}'), '')
      ) as source_url,
      t.updated_at
    from public.telegram_pending_reviews t
    where t.status in ('published', 'rejected')
  ) decisions
  where shop_id is not null
    and item_id is not null
  order by shop_id, item_id, updated_at desc
)
insert into public.product_source_identities (
  marketplace,
  shop_id,
  item_id,
  source_product_url,
  product_id,
  review_id,
  source,
  reserved_run_id,
  reserved_until,
  updated_at
)
select
  'Shopee',
  latest.shop_id,
  latest.item_id,
  coalesce(
    latest.source_url,
    'https://shopee.com.br/product/' || latest.shop_id || '/' || latest.item_id
  ),
  null,
  latest.review_id,
  'human_rejected',
  null,
  '9999-12-31 23:59:59+00'::timestamptz,
  now()
from latest_decision latest
where latest.status = 'rejected'
on conflict (marketplace, shop_id, item_id) do update
set source_product_url = excluded.source_product_url,
    review_id = excluded.review_id,
    source = 'human_rejected',
    reserved_run_id = null,
    reserved_until = '9999-12-31 23:59:59+00'::timestamptz,
    updated_at = now()
where public.product_source_identities.product_id is null;

update public.autonomous_curator_config
set max_enrich_per_category = greatest(max_enrich_per_category, 10),
    updated_at = now()
where id = 'default';
