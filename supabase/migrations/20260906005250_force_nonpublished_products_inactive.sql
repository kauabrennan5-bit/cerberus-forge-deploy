create or replace function public.force_nonpublished_product_inactive()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status is distinct from 'published' then
    new.ativo := false;
  end if;
  return new;
end;
$$;

drop trigger if exists products_00_force_nonpublished_inactive on public.products;
create trigger products_00_force_nonpublished_inactive
before insert or update on public.products
for each row
execute function public.force_nonpublished_product_inactive();

comment on function public.force_nonpublished_product_inactive() is
'Hard invariant: only status=published may be active. Manual staging/rejected/error rows are always inactive.';
