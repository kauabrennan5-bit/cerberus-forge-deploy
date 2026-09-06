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

drop trigger if exists trg_preserve_human_rejected_identity on public.product_source_identities;
create trigger trg_preserve_human_rejected_identity
before delete on public.product_source_identities
for each row
execute function public.cerberus_preserve_human_rejected_identity();

create or replace function public.cerberus_block_rejected_identity_pending_review()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shop_id text;
  v_item_id text;
  v_category text;
  v_candidate_text text;
  v_rejected_review_id text;
begin
  if coalesce(new.status, '') <> 'pending' then
    return new;
  end if;
  if tg_op = 'UPDATE' and coalesce(old.status, '') = 'pending' then
    return new;
  end if;

  v_shop_id := nullif(btrim(coalesce(new.data #>> '{existingProduct,shopId}', '')), '');
  v_item_id := nullif(btrim(coalesce(new.data #>> '{existingProduct,itemId}', '')), '');
  v_category := nullif(btrim(coalesce(new.data ->> 'categoria', '')), '');
  v_candidate_text := concat_ws(' ', new.data ->> 'rawTitle', new.data ->> 'displayTitle', new.data ->> 'produto');

  if v_shop_id is not null and v_item_id is not null and exists (
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

  if v_category is not null and nullif(btrim(v_candidate_text), '') is not null then
    select rejected.id
      into v_rejected_review_id
    from public.telegram_pending_reviews rejected
    where rejected.status = 'rejected'
      and rejected.id <> new.id
      and nullif(btrim(rejected.data ->> 'categoria'), '') = v_category
      and public.cerberus_is_semantic_catalog_duplicate(
        v_candidate_text,
        concat_ws(' ', rejected.data ->> 'rawTitle', rejected.data ->> 'displayTitle', rejected.data ->> 'produto')
      )
    order by rejected.updated_at desc
    limit 1;

    if v_rejected_review_id is not null then
      raise exception using
        errcode = '23514',
        message = 'TELEGRAM_REVIEW_HUMAN_REJECTED_SEMANTIC:' || v_rejected_review_id;
    end if;
  end if;

  return new;
end;
$$;
