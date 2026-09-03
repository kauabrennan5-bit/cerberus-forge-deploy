-- Central publication authority for Cerberus public products.
-- Existing public editorial violations are made non-public without inventing review proof.

create table if not exists public.product_publication_authorizations (
  authorization_id uuid primary key,
  product_id text not null references public.products(id) on delete cascade,
  source text not null check (source in ('autonomous_curator','product_rotation','admin','queue','recovery')),
  gate_version text not null,
  score numeric not null check (score >= 0 and score <= 100),
  threshold numeric not null check (threshold > 0 and threshold <= 100),
  maximum_catalog_similarity numeric not null check (maximum_catalog_similarity >= 0 and maximum_catalog_similarity <= 1),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz null
);

create index if not exists product_publication_authorizations_pending_idx
  on public.product_publication_authorizations(product_id, expires_at desc)
  where consumed_at is null;

-- Fail closed on records that were already public without the editorial proof the
-- new publication authority requires. This never converts unreviewed -> reviewed.
update public.products
set ativo = false,
    status = 'paused'
where coalesce(ativo, true) = true
  and status = 'published'
  and (
    display_title_status <> 'reviewed'
    or image_editorial_status <> 'clean'
    or image_curation is null
    or image_curation ->> 'status' <> 'ready'
    or nullif(btrim(image_curation ->> 'primaryImageUrl'), '') is null
    or image_review_fingerprint is null
    or preco <= 0
  );

create or replace function public.enforce_product_publication_authorization()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_authorization_id uuid;
  v_shop_id text;
  v_item_id text;
  v_source_url text;
begin
  -- Only guard a real transition into the public state. Ordinary edits to an
  -- already-public healthy product do not consume another authorization.
  if not (coalesce(new.ativo, true) = true and new.status = 'published') then
    return new;
  end if;
  if tg_op = 'UPDATE' and coalesce(old.ativo, true) = true and old.status = 'published' then
    return new;
  end if;

  if new.display_title_status <> 'reviewed'
     or nullif(btrim(new.display_title), '') is null then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:DISPLAY_TITLE_NOT_REVIEWED';
  end if;

  if new.image_editorial_status <> 'clean'
     or new.image_curation is null
     or new.image_curation ->> 'status' <> 'ready'
     or nullif(btrim(new.image_curation ->> 'primaryImageUrl'), '') is null
     or new.image_review_fingerprint is null then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:IMAGE_REVIEW_NOT_CLEAN';
  end if;

  if new.preco is null or new.preco <= 0 then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:PRICE_UNVERIFIED';
  end if;

  if new.categoria not in (
    'Iluminação','Decoração','Móveis','Cozinha & Mesa','Organização',
    'Vestuário','Calçados & Acessórios','Tecnologia','Beleza & Bem-estar','Infantil'
  ) then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:CATEGORY_INVALID';
  end if;

  if new.link is null
     or new.link !~* '^https://([^/]+\.)?shopee\.com\.br/' then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:AFFILIATE_LINK_INVALID';
  end if;

  select psi.shop_id, psi.item_id, psi.source_product_url
    into v_shop_id, v_item_id, v_source_url
  from public.product_source_identities psi
  where psi.product_id = new.id
    and lower(psi.marketplace) = 'shopee'
  limit 1;

  if nullif(btrim(v_shop_id), '') is null
     or nullif(btrim(v_item_id), '') is null
     or nullif(btrim(v_source_url), '') is null
     or v_source_url !~* '^https://([^/]+\.)?shopee\.com\.br/' then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:SHOPEE_IDENTITY_INVALID';
  end if;

  select authorization_id
    into v_authorization_id
  from public.product_publication_authorizations
  where product_id = new.id
    and consumed_at is null
    and expires_at > now()
    and score >= threshold
    and maximum_catalog_similarity < 0.82
    and coalesce((evidence ->> 'lifecycleApproved')::boolean, false) = true
    and coalesce((evidence ->> 'categoryMismatch')::boolean, true) = false
    and coalesce((evidence ->> 'offBrand')::boolean, true) = false
    and upper(coalesce(evidence ->> 'reviewState', '')) not like '%REVIEW%'
  order by created_at desc
  limit 1
  for update;

  if v_authorization_id is null then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:AUTHORIZATION_MISSING';
  end if;

  update public.product_publication_authorizations
  set consumed_at = now()
  where authorization_id = v_authorization_id
    and consumed_at is null;

  return new;
end;
$$;

drop trigger if exists products_publication_authorization_guard on public.products;
create trigger products_publication_authorization_guard
before insert or update of ativo, status on public.products
for each row
execute function public.enforce_product_publication_authorization();

comment on table public.product_publication_authorizations is
  'Short-lived, single-use evidence proving a product passed the central publication gate before becoming active+published.';
