-- Hard database guard: no publication path may create a 31st active product
-- in the same public category, including concurrent/manual approvals.

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

drop trigger if exists products_category_ceiling_30 on public.products;
create trigger products_category_ceiling_30
before insert or update of ativo, categoria on public.products
for each row
execute function public.enforce_product_category_ceiling_30();
