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

create or replace function public.cerberus_preserve_human_rejected_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.source = 'human_rejected' and old.product_id is null then
    return null;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_suppress_rejected_source_identity on public.telegram_pending_reviews;
create trigger trg_suppress_rejected_source_identity
after insert or update of status on public.telegram_pending_reviews
for each row
execute function public.cerberus_suppress_rejected_source_identity();

drop trigger if exists trg_preserve_human_rejected_identity on public.product_source_identities;
create trigger trg_preserve_human_rejected_identity
before delete on public.product_source_identities
for each row
execute function public.cerberus_preserve_human_rejected_identity();