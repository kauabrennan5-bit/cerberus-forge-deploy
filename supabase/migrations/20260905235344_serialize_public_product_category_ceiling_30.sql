-- Serialize publication attempts per category so concurrent manual approvals
-- cannot both observe the same count and create a 31st active product.

create or replace function public.enforce_product_category_ceiling_30()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  active_in_category integer;
begin
  if coalesce(new.ativo, true) is not true then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(new.categoria));

  select count(*)::integer
    into active_in_category
  from public.products p
  where coalesce(p.ativo, true) = true
    and p.categoria = new.categoria
    and (tg_op = 'INSERT' or p.id <> new.id);

  if active_in_category >= 30 then
    raise exception 'CATEGORY_PUBLICATION_CEILING_REACHED: % already has 30 active products', new.categoria
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;
