-- Manual publication mode: each public category may contain at most 30 active products.
-- Curator discovery/review remains enabled, but automatic publication stays disabled.

alter table public.autonomous_curator_config
  drop constraint if exists autonomous_curator_config_max_daily_per_category_check;

alter table public.autonomous_curator_config
  add constraint autonomous_curator_config_max_daily_per_category_check
  check (max_daily_per_category >= 0 and max_daily_per_category <= 30);

update public.autonomous_curator_config
set max_daily_per_category = 30,
    enabled = true,
    auto_publish_enabled = false,
    updated_at = now()
where id = 'default';

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
