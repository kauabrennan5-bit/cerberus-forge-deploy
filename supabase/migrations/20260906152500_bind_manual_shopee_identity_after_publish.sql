-- Bind the review-owned Shopee identity to the canonical product in the same
-- transaction that successfully transitions a manual Telegram product to
-- published. This closes the manual /shopee identity lifecycle without
-- weakening the publication authorization guard.

create or replace function public.bind_manual_shopee_identity_after_publish()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_url text;
  v_bound_count integer := 0;
begin
  if not (
    new.status = 'published'
    and coalesce(new.ativo, false) = true
    and new.created_by = 'telegram_manual'
    and not (coalesce(old.ativo, false) = true and old.status = 'published')
  ) then
    return new;
  end if;

  select nullif(btrim(ppa.evidence ->> 'sourceProductUrl'), '')
    into v_source_url
  from public.product_publication_authorizations ppa
  where ppa.product_id = new.id
    and ppa.source = 'admin'
    and ppa.consumed_at is not null
    and coalesce((ppa.evidence ->> 'humanManualApproval')::boolean, false) = true
  order by ppa.consumed_at desc
  limit 1;

  if v_source_url is null then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:MANUAL_SOURCE_IDENTITY_AUTHORIZATION_MISSING';
  end if;

  update public.product_source_identities psi
  set product_id = new.id,
      review_id = null,
      reserved_run_id = null,
      reserved_until = null,
      updated_at = now()
  where lower(psi.marketplace) = 'shopee'
    and psi.product_id is null
    and psi.review_id is not null
    and psi.source_product_url = v_source_url;

  get diagnostics v_bound_count = row_count;
  if v_bound_count <> 1 then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:MANUAL_SOURCE_IDENTITY_BIND_FAILED';
  end if;

  return new;
end;
$$;

drop trigger if exists products_manual_shopee_identity_bind on public.products;
create trigger products_manual_shopee_identity_bind
after update on public.products
for each row
execute function public.bind_manual_shopee_identity_after_publish();
