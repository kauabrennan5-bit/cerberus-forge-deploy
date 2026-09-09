-- Cerberus publication invariant: Curator-origin products can only become public
-- through a durable human Telegram approval. This migration is forward-only.

alter table public.product_publication_authorizations
  add column if not exists review_id text,
  add column if not exists approved_at timestamptz,
  add column if not exists approval_origin text,
  add column if not exists shop_id text,
  add column if not exists item_id text,
  add column if not exists source_product_url text,
  add column if not exists primary_image_url text,
  add column if not exists image_fingerprint text,
  add column if not exists operation_id text,
  add column if not exists human_approval_evidence jsonb;

create index if not exists product_publication_authorizations_review_id_idx
  on public.product_publication_authorizations(review_id)
  where review_id is not null;

create index if not exists product_publication_authorizations_product_review_idx
  on public.product_publication_authorizations(product_id, review_id)
  where review_id is not null;

-- Populate durable human-approval evidence before the authorization can ever be
-- consumed by the products publication guard. The canonical source is the
-- review-owned Shopee identity reservation, not caller-supplied JSON alone.
create or replace function public.hydrate_human_product_publication_authorization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_review_id text;
  v_shop_id text;
  v_item_id text;
  v_source_url text;
  v_review_data jsonb;
  v_review_status text;
  v_approved_at timestamptz;
  v_operation_id text;
  v_primary_image text;
  v_fingerprint text;
begin
  if not (
    new.source = 'admin'
    and coalesce((new.evidence ->> 'humanManualApproval')::boolean, false) = true
  ) then
    return new;
  end if;

  select psi.review_id, psi.shop_id, psi.item_id, psi.source_product_url
    into v_review_id, v_shop_id, v_item_id, v_source_url
  from public.product_source_identities psi
  where lower(psi.marketplace) = 'shopee'
    and psi.review_id is not null
    and (
      psi.review_id = nullif(btrim(new.evidence ->> 'reviewId'), '')
      or psi.source_product_url = nullif(btrim(new.evidence ->> 'sourceProductUrl'), '')
    )
    and (psi.product_id is null or psi.product_id = new.product_id)
  order by
    case when psi.review_id = nullif(btrim(new.evidence ->> 'reviewId'), '') then 0 else 1 end,
    psi.updated_at desc nulls last
  limit 1;

  if v_review_id is null then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:HUMAN_REVIEW_PROOF_MISSING';
  end if;

  select t.data, t.status
    into v_review_data, v_review_status
  from public.telegram_pending_reviews t
  where t.id = v_review_id
  limit 1;

  if v_review_data is null
     or v_review_status not in ('publishing', 'published')
     or coalesce((v_review_data #>> '{lifecycle,humanApproved}')::boolean, false) is not true then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:HUMAN_REVIEW_NOT_APPROVED';
  end if;

  select nullif(elem ->> 'timestamp', '')::timestamptz
    into v_approved_at
  from jsonb_array_elements(coalesce(v_review_data #> '{lifecycle,audit}', '[]'::jsonb)) elem
  where elem ->> 'type' = 'PRODUCT_APPROVED'
  order by nullif(elem ->> 'timestamp', '')::timestamptz desc nulls last
  limit 1;

  if v_approved_at is null then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:HUMAN_APPROVAL_TIMESTAMP_MISSING';
  end if;

  v_operation_id := nullif(btrim(v_review_data #>> '{lifecycle,operationId}'), '');
  v_primary_image := nullif(btrim(new.evidence ->> 'primaryImageUrl'), '');

  select p.image_review_fingerprint
    into v_fingerprint
  from public.products p
  where p.id = new.product_id;

  new.review_id := v_review_id;
  new.approved_at := v_approved_at;
  new.approval_origin := 'telegram';
  new.shop_id := v_shop_id;
  new.item_id := v_item_id;
  new.source_product_url := v_source_url;
  new.primary_image_url := v_primary_image;
  new.image_fingerprint := v_fingerprint;
  new.operation_id := v_operation_id;
  new.human_approval_evidence := jsonb_build_object(
    'reviewId', v_review_id,
    'reviewStatusAtAuthorization', v_review_status,
    'humanApproved', true,
    'approvedAt', v_approved_at,
    'operationId', v_operation_id,
    'source', 'telegram'
  );
  new.evidence := jsonb_set(
    coalesce(new.evidence, '{}'::jsonb),
    '{reviewId}',
    to_jsonb(v_review_id),
    true
  );

  return new;
end;
$$;

drop trigger if exists product_publication_authorizations_human_evidence on public.product_publication_authorizations;
create trigger product_publication_authorizations_human_evidence
before insert on public.product_publication_authorizations
for each row
execute function public.hydrate_human_product_publication_authorization();

-- Backfill only authorizations with exactly one persisted published Telegram
-- review that identifies the same product. Ambiguous/unmatched historical rows
-- intentionally remain unfilled rather than inventing human approval evidence.
with unique_matches as (
  select
    ppa.authorization_id,
    min(t.id) as review_id,
    count(*) as match_count
  from public.product_publication_authorizations ppa
  join public.telegram_pending_reviews t
    on t.status = 'published'
   and (
     t.data #>> '{lifecycle,publishedProductId}' = ppa.product_id
     or t.data #>> '{lifecycle,publishedProduct,id}' = ppa.product_id
   )
  where ppa.source = 'admin'
    and ppa.consumed_at is not null
    and coalesce((ppa.evidence ->> 'humanManualApproval')::boolean, false) = true
    and ppa.review_id is null
  group by ppa.authorization_id
  having count(*) = 1
), evidence as (
  select
    um.authorization_id,
    t.id as review_id,
    t.data,
    coalesce(
      (
        select nullif(elem ->> 'timestamp', '')::timestamptz
        from jsonb_array_elements(coalesce(t.data #> '{lifecycle,audit}', '[]'::jsonb)) elem
        where elem ->> 'type' = 'PRODUCT_APPROVED'
        order by nullif(elem ->> 'timestamp', '')::timestamptz desc nulls last
        limit 1
      ),
      t.updated_at
    ) as approved_at
  from unique_matches um
  join public.telegram_pending_reviews t on t.id = um.review_id
)
update public.product_publication_authorizations ppa
set review_id = e.review_id,
    approved_at = e.approved_at,
    approval_origin = 'telegram',
    shop_id = nullif(btrim(e.data #>> '{existingProduct,shopId}'), ''),
    item_id = nullif(btrim(e.data #>> '{existingProduct,itemId}'), ''),
    source_product_url = nullif(btrim(ppa.evidence ->> 'sourceProductUrl'), ''),
    primary_image_url = nullif(btrim(ppa.evidence ->> 'primaryImageUrl'), ''),
    image_fingerprint = p.image_review_fingerprint,
    operation_id = nullif(btrim(e.data #>> '{lifecycle,operationId}'), ''),
    human_approval_evidence = jsonb_build_object(
      'reviewId', e.review_id,
      'humanApproved', true,
      'approvedAt', e.approved_at,
      'operationId', nullif(btrim(e.data #>> '{lifecycle,operationId}'), ''),
      'source', 'telegram',
      'backfilled', true
    ),
    evidence = jsonb_set(coalesce(ppa.evidence, '{}'::jsonb), '{reviewId}', to_jsonb(e.review_id), true)
from evidence e
left join public.products p on p.id = ppa.product_id
where ppa.authorization_id = e.authorization_id;

-- Preserve the historical review_id when binding a manual Shopee reservation to
-- its canonical product. The reservation claim fields can be cleared; lineage
-- must remain queryable forever.
create or replace function public.bind_manual_shopee_identity_after_publish()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_url text;
  v_review_id text;
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

  select ppa.source_product_url, ppa.review_id
    into v_source_url, v_review_id
  from public.product_publication_authorizations ppa
  where ppa.product_id = new.id
    and ppa.source = 'admin'
    and ppa.consumed_at is not null
    and ppa.approval_origin = 'telegram'
    and ppa.review_id is not null
    and ppa.approved_at is not null
    and coalesce((ppa.evidence ->> 'humanManualApproval')::boolean, false) = true
  order by ppa.consumed_at desc
  limit 1;

  if v_source_url is null or v_review_id is null then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:MANUAL_REVIEW_AUTHORIZATION_MISSING';
  end if;

  update public.product_source_identities psi
  set product_id = new.id,
      review_id = v_review_id,
      reserved_run_id = null,
      reserved_until = null,
      published_at = coalesce(psi.published_at, now()),
      updated_at = now()
  where lower(psi.marketplace) = 'shopee'
    and psi.product_id is null
    and psi.review_id = v_review_id
    and psi.source_product_url = v_source_url;

  get diagnostics v_bound_count = row_count;
  if v_bound_count <> 1 then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:MANUAL_SOURCE_IDENTITY_BIND_FAILED';
  end if;

  return new;
end;
$$;

-- The final publication guard deliberately has no autonomous-score/fallback
-- authorization path. Curator-origin products must arrive through the Telegram
-- admin approval path above. Rotation is retained as a separate explicit human
-- administrative workflow and cannot be used by the Curator.
create or replace function public.enforce_product_publication_authorization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authorization_id uuid;
  v_authorization_source text;
  v_authorization_evidence jsonb;
  v_review_id text;
  v_shop_id text;
  v_item_id text;
  v_source_url text;
  v_primary_image text;
  v_human_manual_approval boolean := false;
begin
  if not (coalesce(new.ativo, true) = true and new.status = 'published') then return new; end if;

  if tg_op = 'INSERT' and exists (
    select 1 from public.products p
    where p.id = new.id
      and coalesce(p.ativo, true) = true
      and p.status = 'published'
      and (to_jsonb(p) - 'created_at') = (to_jsonb(new) - 'created_at')
  ) then
    return new;
  end if;

  if tg_op = 'UPDATE' and coalesce(old.ativo, true) = true and old.status = 'published' then return new; end if;

  if tg_op = 'UPDATE'
     and current_setting('cerberus.rotation_recovery', true) = 'on'
     and coalesce(old.ativo, false) = false
     and old.status = 'archived'
     and new.ativo = true
     and new.status = 'published' then
    if new.display_title_status <> 'reviewed'
       or new.image_editorial_status <> 'clean'
       or new.image_curation is null
       or new.image_curation ->> 'status' <> 'ready'
       or nullif(btrim(new.image_curation ->> 'primaryImageUrl'), '') is null
       or new.image_review_fingerprint is null
       or new.preco is null
       or new.preco <= 0 then
      raise exception 'PRODUCT_PUBLICATION_BLOCKED:ROTATION_RECOVERY_EDITORIAL_PROOF_INVALID';
    end if;
    return new;
  end if;

  if nullif(btrim(new.display_title), '') is null then raise exception 'PRODUCT_PUBLICATION_BLOCKED:DISPLAY_TITLE_NOT_REVIEWED'; end if;
  if new.preco is null or new.preco <= 0 then raise exception 'PRODUCT_PUBLICATION_BLOCKED:PRICE_UNVERIFIED'; end if;
  if new.categoria not in ('Iluminação','Decoração','Móveis','Cozinha & Mesa','Organização','Vestuário','Calçados & Acessórios','Tecnologia','Beleza & Bem-estar','Infantil') then raise exception 'PRODUCT_PUBLICATION_BLOCKED:CATEGORY_INVALID'; end if;
  if new.link is null or new.link !~* '^https://([^/]+\.)?shopee\.com\.br/' then raise exception 'PRODUCT_PUBLICATION_BLOCKED:AFFILIATE_LINK_INVALID'; end if;

  v_primary_image := coalesce(
    nullif(btrim(new.image_curation ->> 'primaryImageUrl'), ''),
    nullif(btrim(new.imagens ->> 0), '')
  );
  if v_primary_image is null or v_primary_image !~* '^https://' then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:PRIMARY_IMAGE_MISSING';
  end if;

  select
    ppa.authorization_id,
    ppa.source,
    ppa.evidence,
    ppa.review_id,
    ppa.shop_id,
    ppa.item_id,
    ppa.source_product_url
  into
    v_authorization_id,
    v_authorization_source,
    v_authorization_evidence,
    v_review_id,
    v_shop_id,
    v_item_id,
    v_source_url
  from public.product_publication_authorizations ppa
  where ppa.product_id = new.id
    and ppa.consumed_at is null
    and ppa.expires_at > now()
    and coalesce((ppa.evidence ->> 'categoryMismatch')::boolean, true) = false
    and (
      (
        ppa.source = 'admin'
        and coalesce((ppa.evidence ->> 'humanManualApproval')::boolean, false) = true
        and ppa.approval_origin = 'telegram'
        and ppa.review_id is not null
        and ppa.approved_at is not null
        and ppa.primary_image_url = v_primary_image
        and ppa.source_product_url is not null
      )
      or (
        ppa.source = 'product_rotation'
        and coalesce((ppa.evidence ->> 'manualEditorialOverride')::boolean, false) = true
        and nullif(btrim(ppa.evidence ->> 'primaryImageUrl'), '') = v_primary_image
      )
    )
  order by ppa.created_at desc
  limit 1
  for update;

  if v_authorization_id is null then raise exception 'PRODUCT_PUBLICATION_BLOCKED:AUTHORIZATION_MISSING'; end if;

  v_human_manual_approval := v_authorization_source = 'admin'
    and coalesce((v_authorization_evidence ->> 'humanManualApproval')::boolean, false) = true;

  if v_human_manual_approval then
    if v_review_id is null
       or nullif(btrim(v_shop_id), '') is null
       or nullif(btrim(v_item_id), '') is null
       or nullif(btrim(v_source_url), '') is null then
      raise exception 'PRODUCT_PUBLICATION_BLOCKED:HUMAN_REVIEW_PROOF_MISSING';
    end if;

    if not exists (
      select 1
      from public.telegram_pending_reviews t
      where t.id = v_review_id
        and t.status in ('publishing', 'published')
        and coalesce((t.data #>> '{lifecycle,humanApproved}')::boolean, false) = true
    ) then
      raise exception 'PRODUCT_PUBLICATION_BLOCKED:HUMAN_REVIEW_NOT_APPROVED';
    end if;

    if not exists (
      select 1
      from public.product_source_identities psi
      where lower(psi.marketplace) = 'shopee'
        and psi.review_id = v_review_id
        and psi.shop_id = v_shop_id
        and psi.item_id = v_item_id
        and psi.source_product_url = v_source_url
        and (psi.product_id is null or psi.product_id = new.id)
    ) then
      raise exception 'PRODUCT_PUBLICATION_BLOCKED:SHOPEE_IDENTITY_INVALID';
    end if;
  else
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

    if new.display_title_status <> 'reviewed' then raise exception 'PRODUCT_PUBLICATION_BLOCKED:DISPLAY_TITLE_NOT_REVIEWED'; end if;
    if new.image_editorial_status <> 'clean' or new.image_curation ->> 'status' <> 'ready' then raise exception 'PRODUCT_PUBLICATION_BLOCKED:IMAGE_REVIEW_NOT_CLEAN'; end if;
    if new.image_review_fingerprint is null then raise exception 'PRODUCT_PUBLICATION_BLOCKED:IMAGE_REVIEW_NOT_CLEAN'; end if;
  end if;

  update public.product_publication_authorizations
  set consumed_at = now()
  where authorization_id = v_authorization_id and consumed_at is null;

  return new;
end;
$$;

revoke all on function public.hydrate_human_product_publication_authorization() from public, anon, authenticated;
revoke all on function public.bind_manual_shopee_identity_after_publish() from public, anon, authenticated;
revoke all on function public.enforce_product_publication_authorization() from public, anon, authenticated;

comment on function public.enforce_product_publication_authorization() is
  'Cerberus invariant: autonomous Curator/recovery/score/fallback evidence can never authorize publication; Curator products require durable Telegram human approval.';
