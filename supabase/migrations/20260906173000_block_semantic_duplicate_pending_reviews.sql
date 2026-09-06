create or replace function public.cerberus_semantic_product_tokens(input_text text)
returns text[]
language sql
immutable
set search_path = public
as $$
  select coalesce(array_agg(distinct token order by token), array[]::text[])
  from regexp_split_to_table(
    regexp_replace(
      translate(
        lower(coalesce(input_text, '')),
        'áàãâäéèêëíìîïóòõôöúùûüç',
        'aaaaaeeeeiiiiooooouuuuc'
      ),
      '[^a-z0-9]+',
      ' ',
      'g'
    ),
    '\s+'
  ) as token
  where length(token) >= 3
    and token <> all(array[
      'para','com','sem','uma','uns','umas','dos','das','que','por',
      'novo','nova','oferta','saldo','fabrica','promocao',
      'estilo','design','vintage','retro','classico','classica',
      'moderno','moderna','elegante'
    ]::text[]);
$$;

create or replace function public.cerberus_is_semantic_catalog_duplicate(candidate_text text, catalog_text text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  left_tokens text[];
  right_tokens text[];
  intersection_count integer;
  left_count integer;
  right_count integer;
  union_count integer;
  jaccard numeric;
begin
  left_tokens := public.cerberus_semantic_product_tokens(candidate_text);
  right_tokens := public.cerberus_semantic_product_tokens(catalog_text);
  left_count := cardinality(left_tokens);
  right_count := cardinality(right_tokens);

  if left_count < 2 or right_count < 2 then
    return false;
  end if;

  if left_tokens = right_tokens then
    return true;
  end if;

  select count(*)::integer
    into intersection_count
  from unnest(left_tokens) as u(token)
  where token = any(right_tokens);

  union_count := left_count + right_count - intersection_count;
  if union_count <= 0 then
    return false;
  end if;

  jaccard := intersection_count::numeric / union_count::numeric;

  return intersection_count >= 5 and jaccard >= 0.78;
end;
$$;

create or replace function public.block_semantic_duplicate_pending_review()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  candidate_category text;
  candidate_text text;
  duplicate_product_id text;
begin
  if coalesce(new.status, '') <> 'pending' then
    return new;
  end if;

  if tg_op = 'UPDATE' and coalesce(old.status, '') = 'pending' then
    return new;
  end if;

  candidate_category := nullif(btrim(coalesce(new.data ->> 'categoria', '')), '');
  candidate_text := concat_ws(
    ' ',
    new.data ->> 'rawTitle',
    new.data ->> 'displayTitle',
    new.data ->> 'produto'
  );

  if candidate_category is null or nullif(btrim(candidate_text), '') is null then
    return new;
  end if;

  select p.id
    into duplicate_product_id
  from public.products p
  where p.ativo = true
    and p.status = 'published'
    and p.categoria = candidate_category
    and public.cerberus_is_semantic_catalog_duplicate(
      candidate_text,
      concat_ws(' ', p.raw_title, p.display_title, p.produto)
    )
  order by p.created_at desc
  limit 1;

  if duplicate_product_id is not null then
    raise exception using
      errcode = '23514',
      message = 'TELEGRAM_REVIEW_DUPLICATE_CATALOG:' || duplicate_product_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_block_semantic_duplicate_pending_review on public.telegram_pending_reviews;
create trigger trg_block_semantic_duplicate_pending_review
before insert or update of status, data on public.telegram_pending_reviews
for each row
execute function public.block_semantic_duplicate_pending_review();
