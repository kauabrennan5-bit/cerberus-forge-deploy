-- Human approval is the only authority that may move a Curator product into
-- the public catalogue.  This migration is deliberately forward-only: it
-- preserves the historical review/authorization trail and adds an idempotent
-- recovery primitive for interrupted Telegram publications.

begin;

-- auto_publish_enabled remains in the configuration shape for compatibility,
-- but the database makes the only safe value permanent.
update public.autonomous_curator_config
set auto_publish_enabled = false,
    updated_at = now()
where auto_publish_enabled is distinct from false;

alter table public.autonomous_curator_config
  alter column auto_publish_enabled set default false,
  alter column auto_publish_enabled set not null,
  drop constraint if exists autonomous_curator_auto_publish_disabled,
  add constraint autonomous_curator_auto_publish_disabled
    check (auto_publish_enabled = false);

-- Durable Telegram approval -> authorization -> product audit linkage.
-- review_id intentionally is not a foreign key: terminal reviews move to the
-- private archive while this historical proof must remain queryable forever.
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

alter table public.product_publication_authorizations
  drop constraint if exists product_publication_authorizations_approval_origin_check,
  add constraint product_publication_authorizations_approval_origin_check
    check (approval_origin is null or approval_origin = 'telegram'),
  drop constraint if exists product_publication_authorizations_image_fingerprint_check,
  add constraint product_publication_authorizations_image_fingerprint_check
    check (image_fingerprint is null or image_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  drop constraint if exists product_publication_authorizations_human_evidence_shape_check,
  add constraint product_publication_authorizations_human_evidence_shape_check
    check (human_approval_evidence is null or jsonb_typeof(human_approval_evidence) = 'object');

create unique index if not exists product_publication_authorizations_operation_uq
  on public.product_publication_authorizations(operation_id)
  where operation_id is not null;

create index if not exists product_publication_authorizations_review_idx
  on public.product_publication_authorizations(review_id, created_at desc)
  where review_id is not null;

create index if not exists telegram_pending_reviews_stale_publishing_idx
  on public.telegram_pending_reviews(updated_at, id)
  where status = 'publishing';

-- Separate human editorial authority from the automatic AI review state.  The
-- automatic fields are never forged.  This proof is valid only for the exact
-- image URL/fingerprint shown to the human.
alter table public.products
  add column if not exists human_editorial_approved_at timestamptz,
  add column if not exists human_editorial_image_url text,
  add column if not exists human_editorial_image_fingerprint text,
  add column if not exists human_editorial_review_id text,
  add column if not exists human_editorial_authorization_id uuid;

alter table public.products
  drop constraint if exists products_human_editorial_authorization_fk,
  add constraint products_human_editorial_authorization_fk
    foreign key (human_editorial_authorization_id)
    references public.product_publication_authorizations(authorization_id)
    on delete restrict;

create index if not exists products_human_editorial_authorization_idx
  on public.products(human_editorial_authorization_id)
  where human_editorial_authorization_id is not null;

alter table public.products
  drop constraint if exists products_human_editorial_image_fingerprint_check,
  add constraint products_human_editorial_image_fingerprint_check
    check (
      human_editorial_image_fingerprint is null
      or human_editorial_image_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    ),
  drop constraint if exists products_human_editorial_proof_check,
  add constraint products_human_editorial_proof_check
    check (
      human_editorial_approved_at is null
      or (
        nullif(btrim(human_editorial_image_url), '') is not null
        and human_editorial_image_url ~* '^https://'
        and human_editorial_image_fingerprint is not null
        and nullif(btrim(human_editorial_review_id), '') is not null
        and human_editorial_authorization_id is not null
      )
    );

-- Conservative legacy backfill.  A row is trusted only when the published
-- Telegram review, lifecycle approval event, consumed human authorization,
-- canonical product and Shopee identity all agree exactly.  No missing proof
-- is inferred.
with review_sources as (
  select id, status, data from public.telegram_pending_reviews
  union all
  select id, status, data from private.telegram_pending_reviews_archive
), trusted_reviews as (
  select
    r.id as review_id,
    r.data #>> '{lifecycle,publishedProductId}' as product_id,
    r.data #>> '{lifecycle,operationId}' as operation_id,
    r.data #>> '{existingProduct,shopId}' as shop_id,
    r.data #>> '{existingProduct,itemId}' as item_id,
    r.data ->> 'normalizedUrl' as source_product_url,
    coalesce(
      r.data #>> '{imageCuration,primaryImageUrl}',
      r.data ->> 'imagemPrincipal',
      r.data #>> '{imagens,0}'
    ) as primary_image_url,
    approved.event ->> 'timestamp' as approved_at_text,
    r.data as review_data
  from review_sources r
  cross join lateral (
    select event
    from jsonb_array_elements(
      case
        when jsonb_typeof(r.data #> '{lifecycle,audit}') = 'array'
          then r.data #> '{lifecycle,audit}'
        else '[]'::jsonb
      end
    ) event
    where event ->> 'type' = 'PRODUCT_APPROVED'
      and event ->> 'timestamp' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T'
    order by event ->> 'timestamp'
    limit 1
  ) approved
  where r.status = 'published'
    and lower(coalesce(r.data #>> '{lifecycle,humanApproved}', 'false')) = 'true'
    and nullif(btrim(r.data #>> '{lifecycle,publishedProductId}'), '') is not null
    and nullif(btrim(r.data #>> '{lifecycle,operationId}'), '') is not null
    and nullif(btrim(r.data #>> '{existingProduct,shopId}'), '') is not null
    and nullif(btrim(r.data #>> '{existingProduct,itemId}'), '') is not null
    and nullif(btrim(r.data ->> 'normalizedUrl'), '') is not null
), candidate_matches as (
  select
    ppa.authorization_id,
    tr.product_id,
    tr.review_id,
    tr.operation_id,
    tr.shop_id,
    tr.item_id,
    tr.source_product_url,
    tr.primary_image_url,
    tr.approved_at_text::timestamptz as approved_at,
    tr.review_data,
    count(*) over (partition by tr.review_id) as review_match_count,
    count(*) over (partition by tr.operation_id) as operation_match_count,
    count(*) over (partition by ppa.authorization_id) as authorization_match_count,
    count(*) over (partition by tr.product_id) as product_match_count
  from trusted_reviews tr
  join public.products p
    on p.id = tr.product_id
   and coalesce(p.image_curation ->> 'primaryImageUrl', p.imagens ->> 0) = tr.primary_image_url
  join public.product_source_identities psi
    on psi.product_id = p.id
   and lower(psi.marketplace) = 'shopee'
   and psi.shop_id = tr.shop_id
   and psi.item_id = tr.item_id
   and psi.source_product_url = tr.source_product_url
  join public.product_publication_authorizations ppa
    on ppa.product_id = p.id
   and ppa.source = 'admin'
   and ppa.consumed_at is not null
   and lower(coalesce(ppa.evidence ->> 'humanManualApproval', 'false')) = 'true'
   and nullif(btrim(ppa.evidence ->> 'primaryImageUrl'), '') = tr.primary_image_url
   and nullif(btrim(ppa.evidence ->> 'sourceProductUrl'), '') = tr.source_product_url
   and ppa.consumed_at >= tr.approved_at_text::timestamptz
   and ppa.consumed_at <= tr.approved_at_text::timestamptz + interval '5 minutes'
), trusted_matches as (
  select
    authorization_id,
    review_id,
    operation_id,
    shop_id,
    item_id,
    source_product_url,
    primary_image_url,
    approved_at,
    review_data
  from candidate_matches
  where review_match_count = 1
    and operation_match_count = 1
    and authorization_match_count = 1
    and product_match_count = 1
)
update public.product_publication_authorizations ppa
set review_id = tm.review_id,
    approved_at = tm.approved_at,
    approval_origin = 'telegram',
    shop_id = tm.shop_id,
    item_id = tm.item_id,
    source_product_url = tm.source_product_url,
    primary_image_url = tm.primary_image_url,
    operation_id = tm.operation_id,
    human_approval_evidence = jsonb_build_object(
      'kind', 'trusted_legacy_backfill',
      'origin', 'telegram',
      'reviewId', tm.review_id,
      'operationId', tm.operation_id,
      'approvedAt', tm.approved_at,
      'shopId', tm.shop_id,
      'itemId', tm.item_id,
      'sourceProductUrl', tm.source_product_url,
      'primaryImageUrl', tm.primary_image_url,
      'telegramSenderId', tm.review_data ->> 'senderId',
      'telegramChatId', tm.review_data ->> 'chatId'
    )
from trusted_matches tm
where ppa.authorization_id = tm.authorization_id
  and ppa.review_id is null;

-- pgcrypto is present in Supabase but intentionally absent from the vanilla
-- PostgreSQL rebuild fixture.  Execute the safe legacy hash backfill only when
-- the extension function exists; all new application writes provide the hash.
do $backfill$
begin
  if to_regprocedure('extensions.digest(bytea,text)') is not null then
    execute $sql$
      update public.product_publication_authorizations
      set image_fingerprint = 'sha256:' || encode(
        extensions.digest(convert_to(primary_image_url, 'UTF8'), 'sha256'),
        'hex'
      )
      where approval_origin = 'telegram'
        and primary_image_url is not null
        and image_fingerprint is null
    $sql$;
  end if;
end;
$backfill$;

update public.product_publication_authorizations
set human_approval_evidence = human_approval_evidence || jsonb_build_object(
  'primaryImageFingerprint', image_fingerprint
)
where approval_origin = 'telegram'
  and human_approval_evidence ->> 'kind' = 'trusted_legacy_backfill'
  and image_fingerprint is not null;

-- Preserve the historical review on identities that older trigger versions
-- bound to a product while clearing review_id.
update public.product_source_identities psi
set review_id = ppa.review_id,
    updated_at = now()
from public.product_publication_authorizations ppa
where ppa.product_id = psi.product_id
  and ppa.approval_origin = 'telegram'
  and ppa.review_id is not null
  and ppa.shop_id = psi.shop_id
  and ppa.item_id = psi.item_id
  and ppa.source_product_url = psi.source_product_url
  and psi.review_id is null;

update public.products p
set human_editorial_approved_at = ppa.approved_at,
    human_editorial_image_url = ppa.primary_image_url,
    human_editorial_image_fingerprint = ppa.image_fingerprint,
    human_editorial_review_id = ppa.review_id,
    human_editorial_authorization_id = ppa.authorization_id
from public.product_publication_authorizations ppa
where ppa.product_id = p.id
  and ppa.approval_origin = 'telegram'
  and ppa.consumed_at is not null
  and ppa.approved_at is not null
  and ppa.image_fingerprint is not null
  and ppa.primary_image_url = coalesce(
    nullif(btrim(p.image_curation ->> 'primaryImageUrl'), ''),
    nullif(btrim(p.imagens ->> 0), '')
  )
  and ppa.human_approval_evidence ->> 'origin' = 'telegram'
  and ppa.human_approval_evidence ->> 'reviewId' = ppa.review_id
  and ppa.human_approval_evidence ->> 'operationId' = ppa.operation_id
  and (ppa.human_approval_evidence ->> 'approvedAt')::timestamptz = ppa.approved_at
  and ppa.human_approval_evidence ->> 'shopId' = ppa.shop_id
  and ppa.human_approval_evidence ->> 'itemId' = ppa.item_id
  and ppa.human_approval_evidence ->> 'sourceProductUrl' = ppa.source_product_url
  and ppa.human_approval_evidence ->> 'primaryImageUrl' = ppa.primary_image_url
  and ppa.human_approval_evidence ->> 'primaryImageFingerprint' = ppa.image_fingerprint
  and exists (
    select 1
    from public.product_source_identities psi
    where psi.product_id = p.id
      and lower(psi.marketplace) = 'shopee'
      and psi.shop_id = ppa.shop_id
      and psi.item_id = ppa.item_id
      and psi.source_product_url = ppa.source_product_url
      and psi.review_id = ppa.review_id
  )
  and ppa.authorization_id = (
    select newest.authorization_id
    from public.product_publication_authorizations newest
    where newest.product_id = p.id
      and newest.approval_origin = 'telegram'
      and newest.consumed_at is not null
      and newest.image_fingerprint is not null
      and newest.human_approval_evidence ->> 'origin' = 'telegram'
      and newest.human_approval_evidence ->> 'reviewId' = newest.review_id
      and newest.human_approval_evidence ->> 'operationId' = newest.operation_id
      and (newest.human_approval_evidence ->> 'approvedAt')::timestamptz = newest.approved_at
      and newest.human_approval_evidence ->> 'shopId' = newest.shop_id
      and newest.human_approval_evidence ->> 'itemId' = newest.item_id
      and newest.human_approval_evidence ->> 'sourceProductUrl' = newest.source_product_url
      and newest.human_approval_evidence ->> 'primaryImageUrl' = newest.primary_image_url
      and newest.human_approval_evidence ->> 'primaryImageFingerprint' = newest.image_fingerprint
    order by newest.consumed_at desc
    limit 1
  );

-- A consumed publication authorization is an audit record, not mutable
-- application state.  This keeps review_id and the complete human evidence
-- available even after the operational Telegram row is archived and even if
-- the product later changes image or leaves the public catalogue.
create or replace function public.prevent_consumed_publication_authorization_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if old.consumed_at is not null then
    raise exception 'PRODUCT_PUBLICATION_AUTHORIZATION_IMMUTABLE_AFTER_CONSUMPTION';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

revoke all on function public.prevent_consumed_publication_authorization_mutation()
  from public, anon, authenticated;

drop trigger if exists product_publication_authorizations_consumed_immutable
  on public.product_publication_authorizations;
create trigger product_publication_authorizations_consumed_immutable
before update or delete on public.product_publication_authorizations
for each row
execute function public.prevent_consumed_publication_authorization_mutation();

-- Fail closed for historical products created by Curator/manual Telegram paths.
-- If the conservative match above could not prove the Telegram decision, the
-- row leaves the public catalogue and remains recoverable for a fresh card.
update public.products p
set ativo = false,
    status = 'paused'
where p.ativo = true
  and p.status = 'published'
  and (
    lower(coalesce(p.created_by, '')) = 'telegram_manual'
    or lower(coalesce(p.created_by, '')) = 'telegram_rotation_candidate'
    or lower(coalesce(p.created_by, '')) like '%autonomous_curator%'
  )
  and not exists (
    select 1
    from public.product_publication_authorizations ppa
    where ppa.authorization_id = p.human_editorial_authorization_id
      and ppa.product_id = p.id
      and ppa.approval_origin = 'telegram'
      and ppa.review_id = p.human_editorial_review_id
      and ppa.approved_at = p.human_editorial_approved_at
      and ppa.primary_image_url = p.human_editorial_image_url
      and ppa.image_fingerprint = p.human_editorial_image_fingerprint
      and ppa.consumed_at is not null
      and ppa.human_approval_evidence ->> 'origin' = 'telegram'
      and ppa.human_approval_evidence ->> 'reviewId' = ppa.review_id
      and ppa.human_approval_evidence ->> 'operationId' = ppa.operation_id
      and (ppa.human_approval_evidence ->> 'approvedAt')::timestamptz = ppa.approved_at
      and ppa.human_approval_evidence ->> 'shopId' = ppa.shop_id
      and ppa.human_approval_evidence ->> 'itemId' = ppa.item_id
      and ppa.human_approval_evidence ->> 'sourceProductUrl' = ppa.source_product_url
      and ppa.human_approval_evidence ->> 'primaryImageUrl' = ppa.primary_image_url
      and ppa.human_approval_evidence ->> 'primaryImageFingerprint' = ppa.image_fingerprint
      and exists (
        select 1
        from public.product_source_identities psi
        where psi.product_id = p.id
          and lower(psi.marketplace) = 'shopee'
          and psi.shop_id = ppa.shop_id
          and psi.item_id = ppa.item_id
          and psi.source_product_url = ppa.source_product_url
          and psi.review_id = ppa.review_id
      )
  );

-- The publication gate no longer recognizes autonomous/recovery/queue score,
-- lifecycle, deficit or best-of-lot evidence as authority.  Telegram manual
-- publication must match a persisted, claimed review and its Shopee identity.
create or replace function public.enforce_product_publication_authorization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_authorization public.product_publication_authorizations%rowtype;
  v_review public.telegram_pending_reviews%rowtype;
  v_rotation_request public.product_rotation_requests%rowtype;
  v_shop_id text;
  v_item_id text;
  v_source_url text;
  v_primary_image text;
  v_is_human_telegram boolean;
  v_is_manual_rotation boolean;
begin
  if not (new.ativo is true and new.status = 'published') then
    return new;
  end if;

  -- INSERT ... ON CONFLICT invokes BEFORE INSERT before conflict detection.
  -- A byte-identical already-public row is a no-op, not a new publication.
  if tg_op = 'INSERT' and exists (
    select 1
    from public.products p
    where p.id = new.id
      and p.ativo is true
      and p.status = 'published'
      and (to_jsonb(p) - 'created_at') = (to_jsonb(new) - 'created_at')
  ) then
    return new;
  end if;

  -- Technical catalogue invariants apply to every public transition and to
  -- later edits of a public row. Human approval may replace editorial ranking,
  -- but it never replaces title, price, category, affiliate-link or image checks.
  if nullif(btrim(new.produto), '') is null
     or nullif(btrim(new.display_title), '') is null then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:DISPLAY_TITLE_INVALID';
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
  if new.link is null or new.link !~* '^https://([^/]+\.)?shopee\.com\.br/' then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:AFFILIATE_LINK_INVALID';
  end if;

  v_primary_image := coalesce(
    nullif(btrim(new.image_curation ->> 'primaryImageUrl'), ''),
    nullif(btrim(new.imagens ->> 0), '')
  );
  if v_primary_image is null or v_primary_image !~* '^https://' then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:PRIMARY_IMAGE_MISSING';
  end if;

  if tg_op = 'UPDATE'
     and old.ativo is true
     and old.status = 'published' then
    if new.created_by is distinct from old.created_by then
      raise exception 'PRODUCT_PUBLICATION_BLOCKED:PUBLICATION_ORIGIN_IMMUTABLE';
    end if;
    if (
      lower(coalesce(new.created_by, '')) = 'telegram_manual'
      or lower(coalesce(new.created_by, '')) = 'telegram_rotation_candidate'
      or lower(coalesce(new.created_by, '')) like '%autonomous_curator%'
    ) and not exists (
      select 1
      from public.product_publication_authorizations prior
      where prior.authorization_id = new.human_editorial_authorization_id
        and prior.product_id = new.id
        and prior.approval_origin = 'telegram'
        and prior.review_id = new.human_editorial_review_id
        and prior.approved_at = new.human_editorial_approved_at
        and prior.primary_image_url = new.human_editorial_image_url
        and new.human_editorial_image_url = v_primary_image
        and prior.image_fingerprint = new.human_editorial_image_fingerprint
        and prior.human_approval_evidence ->> 'origin' = 'telegram'
        and prior.human_approval_evidence ->> 'reviewId' = prior.review_id
        and prior.human_approval_evidence ->> 'operationId' = prior.operation_id
        and (prior.human_approval_evidence ->> 'approvedAt')::timestamptz = prior.approved_at
        and prior.human_approval_evidence ->> 'shopId' = prior.shop_id
        and prior.human_approval_evidence ->> 'itemId' = prior.item_id
        and prior.human_approval_evidence ->> 'sourceProductUrl' = prior.source_product_url
        and prior.human_approval_evidence ->> 'primaryImageUrl' = prior.primary_image_url
        and prior.human_approval_evidence ->> 'primaryImageFingerprint' = prior.image_fingerprint
        and prior.consumed_at is not null
    ) then
      raise exception 'PRODUCT_PUBLICATION_BLOCKED:HUMAN_APPROVAL_AUDIT_INVALID';
    end if;
    return new;
  end if;

  -- Transactional rollback may restore the exact previously-public rotation
  -- source.  It can never promote a Curator queue candidate.
  if tg_op = 'UPDATE'
     and current_setting('cerberus.rotation_recovery', true) = 'on'
     and old.ativo is false
     and old.status = 'archived'
     and new.ativo = true
     and new.status = 'published' then
    if not exists (
      select 1
      from public.product_publication_authorizations prior
      where prior.product_id = new.id
        and prior.approval_origin = 'telegram'
        and prior.consumed_at is not null
        and prior.authorization_id = new.human_editorial_authorization_id
        and prior.review_id = new.human_editorial_review_id
        and prior.approved_at = new.human_editorial_approved_at
        and prior.primary_image_url = new.human_editorial_image_url
        and new.human_editorial_image_url = v_primary_image
        and prior.image_fingerprint = new.human_editorial_image_fingerprint
        and prior.human_approval_evidence ->> 'origin' = 'telegram'
        and prior.human_approval_evidence ->> 'reviewId' = prior.review_id
        and prior.human_approval_evidence ->> 'operationId' = prior.operation_id
        and (prior.human_approval_evidence ->> 'approvedAt')::timestamptz = prior.approved_at
        and prior.human_approval_evidence ->> 'shopId' = prior.shop_id
        and prior.human_approval_evidence ->> 'itemId' = prior.item_id
        and prior.human_approval_evidence ->> 'sourceProductUrl' = prior.source_product_url
        and prior.human_approval_evidence ->> 'primaryImageUrl' = prior.primary_image_url
        and prior.human_approval_evidence ->> 'primaryImageFingerprint' = prior.image_fingerprint
    ) then
      raise exception 'PRODUCT_PUBLICATION_BLOCKED:ROTATION_RECOVERY_HUMAN_PROOF_INVALID';
    end if;
    return new;
  end if;

  select ppa.* into v_authorization
  from public.product_publication_authorizations ppa
  where ppa.product_id = new.id
    and ppa.consumed_at is null
    and ppa.expires_at > now()
    and lower(coalesce(ppa.evidence ->> 'categoryMismatch', 'true')) = 'false'
    and coalesce(ppa.primary_image_url, nullif(btrim(ppa.evidence ->> 'primaryImageUrl'), '')) = v_primary_image
    and lower(coalesce(ppa.evidence ->> 'humanManualApproval', 'false')) = 'true'
    and ppa.approval_origin = 'telegram'
    and ppa.approved_at is not null
    and nullif(btrim(ppa.review_id), '') is not null
    and nullif(btrim(ppa.operation_id), '') is not null
    and nullif(btrim(ppa.shop_id), '') is not null
    and nullif(btrim(ppa.item_id), '') is not null
    and ppa.source_product_url ~* '^https://([^/]+\.)?shopee\.com\.br/'
    and ppa.primary_image_url ~* '^https://'
    and ppa.image_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    and ppa.human_approval_evidence ->> 'origin' = 'telegram'
    and ppa.human_approval_evidence ->> 'reviewId' = ppa.review_id
    and ppa.human_approval_evidence ->> 'operationId' = ppa.operation_id
    and (ppa.human_approval_evidence ->> 'approvedAt')::timestamptz = ppa.approved_at
    and ppa.human_approval_evidence ->> 'shopId' = ppa.shop_id
    and ppa.human_approval_evidence ->> 'itemId' = ppa.item_id
    and ppa.human_approval_evidence ->> 'sourceProductUrl' = ppa.source_product_url
    and ppa.human_approval_evidence ->> 'primaryImageUrl' = ppa.primary_image_url
    and ppa.human_approval_evidence ->> 'primaryImageFingerprint' = ppa.image_fingerprint
    and (
      (
        ppa.source = 'admin'
        and new.created_by = 'telegram_manual'
      )
      or (
        ppa.source = 'product_rotation'
        and lower(coalesce(ppa.evidence ->> 'manualEditorialOverride', 'false')) = 'true'
        and new.created_by in ('autonomous_curator_queue', 'telegram_rotation_candidate')
      )
    )
  order by ppa.created_at desc
  limit 1
  for update;

  if v_authorization.authorization_id is null then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:HUMAN_AUTHORIZATION_MISSING';
  end if;

  v_is_human_telegram := v_authorization.approval_origin = 'telegram'
    and v_authorization.source in ('admin', 'product_rotation');
  v_is_manual_rotation := v_authorization.source = 'product_rotation';

  if not v_is_human_telegram then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:HUMAN_AUTHORIZATION_MISSING';
  end if;

  if v_authorization.source = 'admin' then
    select * into v_review
    from public.telegram_pending_reviews r
    where r.id = v_authorization.review_id
      and r.status in ('publishing', 'published')
      and lower(coalesce(r.data #>> '{lifecycle,humanApproved}', 'false')) = 'true'
      and r.data #>> '{lifecycle,operationId}' = v_authorization.operation_id
      and r.data ->> 'normalizedUrl' = v_authorization.source_product_url
      and coalesce(
        r.data #>> '{imageCuration,primaryImageUrl}',
        r.data ->> 'imagemPrincipal',
        r.data #>> '{imagens,0}'
      ) = v_authorization.primary_image_url
      and r.data #>> '{existingProduct,humanApproval,origin}' = 'telegram'
      and r.data #>> '{existingProduct,humanApproval,reviewId}' = v_authorization.review_id
      and r.data #>> '{existingProduct,humanApproval,operationId}' = v_authorization.operation_id
      and (r.data #>> '{existingProduct,humanApproval,approvedAt}')::timestamptz = v_authorization.approved_at
      and r.data #>> '{existingProduct,humanApproval,shopId}' = v_authorization.shop_id
      and r.data #>> '{existingProduct,humanApproval,itemId}' = v_authorization.item_id
      and r.data #>> '{existingProduct,humanApproval,sourceProductUrl}' = v_authorization.source_product_url
      and r.data #>> '{existingProduct,humanApproval,primaryImageUrl}' = v_authorization.primary_image_url
      and r.data #>> '{existingProduct,humanApproval,primaryImageFingerprint}' = v_authorization.image_fingerprint
    for update;

    if not found then
      raise exception 'PRODUCT_PUBLICATION_BLOCKED:TELEGRAM_APPROVAL_NOT_PERSISTED';
    end if;

    select psi.shop_id, psi.item_id, psi.source_product_url
      into v_shop_id, v_item_id, v_source_url
    from public.product_source_identities psi
    where lower(psi.marketplace) = 'shopee'
      and psi.shop_id = v_authorization.shop_id
      and psi.item_id = v_authorization.item_id
      and psi.source_product_url = v_authorization.source_product_url
      and psi.review_id = v_authorization.review_id
      and (psi.product_id is null or psi.product_id = new.id)
    limit 1
    for update;

  elsif v_is_manual_rotation then
    select * into v_rotation_request
    from public.product_rotation_requests r
    where r.id::text = v_authorization.review_id
      and r.status = 'applying'
      and r.candidate_product_id = new.id
      and r.metadata #>> '{human_approval,kind}' = 'product_rotation_telegram_callback'
      and r.metadata #>> '{human_approval,origin}' = 'telegram'
      and r.metadata #>> '{human_approval,reviewId}' = v_authorization.review_id
      and r.metadata #>> '{human_approval,operationId}' = v_authorization.operation_id
      and (r.metadata #>> '{human_approval,approvedAt}')::timestamptz = v_authorization.approved_at
      and r.metadata #>> '{human_approval,candidateProductId}' = new.id
      and r.metadata #>> '{human_approval,primaryImageUrl}' = v_authorization.primary_image_url
      and r.metadata #>> '{human_approval,primaryImageFingerprint}' = v_authorization.image_fingerprint
      and r.metadata #>> '{human_approval,shopId}' = v_authorization.shop_id
      and r.metadata #>> '{human_approval,itemId}' = v_authorization.item_id
      and r.metadata #>> '{human_approval,sourceProductUrl}' = v_authorization.source_product_url
    for update;

    if not found then
      raise exception 'PRODUCT_PUBLICATION_BLOCKED:ROTATION_TELEGRAM_APPROVAL_NOT_PERSISTED';
    end if;

    select psi.shop_id, psi.item_id, psi.source_product_url
      into v_shop_id, v_item_id, v_source_url
    from public.product_source_identities psi
    where psi.product_id = new.id
      and lower(psi.marketplace) = 'shopee'
      and psi.shop_id = v_authorization.shop_id
      and psi.item_id = v_authorization.item_id
      and psi.source_product_url = v_authorization.source_product_url
    limit 1
    for update;
  else
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:HUMAN_AUTHORIZATION_SOURCE_INVALID';
  end if;

  new.human_editorial_approved_at := v_authorization.approved_at;
  new.human_editorial_image_url := v_authorization.primary_image_url;
  new.human_editorial_image_fingerprint := v_authorization.image_fingerprint;
  new.human_editorial_review_id := v_authorization.review_id;
  new.human_editorial_authorization_id := v_authorization.authorization_id;

  if nullif(btrim(v_shop_id), '') is null
     or nullif(btrim(v_item_id), '') is null
     or nullif(btrim(v_source_url), '') is null
     or v_source_url !~* '^https://([^/]+\.)?shopee\.com\.br/' then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:SHOPEE_IDENTITY_INVALID';
  end if;

  update public.product_publication_authorizations
  set consumed_at = now()
  where authorization_id = v_authorization.authorization_id
    and consumed_at is null;

  if not found then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:AUTHORIZATION_ALREADY_CONSUMED';
  end if;
  return new;
end;
$function$;

revoke all on function public.enforce_product_publication_authorization() from public, anon, authenticated;

-- The old trigger watched only status/ativo. Watching every field that can
-- invalidate publication prevents an already-public row from dropping its
-- Telegram provenance or weakening a technical invariant in place.
drop trigger if exists products_enforce_publication_authorization on public.products;
drop trigger if exists products_publication_authorization on public.products;
drop trigger if exists products_publication_authorization_gate on public.products;
drop trigger if exists products_publication_authorization_guard on public.products;
create trigger products_publication_authorization_guard
before insert or update of
  ativo, status, created_by, produto, display_title, preco, categoria, link,
  imagens, image_curation, human_editorial_approved_at,
  human_editorial_image_url, human_editorial_image_fingerprint,
  human_editorial_review_id, human_editorial_authorization_id
on public.products
for each row
execute function public.enforce_product_publication_authorization();

-- Preserve review_id permanently when the identity is bound.  The reservation
-- timestamps may be cleared; the provenance may not.
create or replace function public.bind_manual_shopee_identity_after_publish()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_authorization public.product_publication_authorizations%rowtype;
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

  select ppa.* into v_authorization
  from public.product_publication_authorizations ppa
  where ppa.product_id = new.id
    and ppa.source = 'admin'
    and ppa.consumed_at is not null
    and ppa.approval_origin = 'telegram'
    and ppa.review_id is not null
  order by ppa.consumed_at desc
  limit 1;

  if v_authorization.authorization_id is null then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:MANUAL_APPROVAL_AUDIT_MISSING';
  end if;

  update public.product_source_identities psi
  set product_id = new.id,
      review_id = v_authorization.review_id,
      reserved_run_id = null,
      reserved_until = null,
      updated_at = now()
  where lower(psi.marketplace) = 'shopee'
    and psi.shop_id = v_authorization.shop_id
    and psi.item_id = v_authorization.item_id
    and psi.source_product_url = v_authorization.source_product_url
    and psi.review_id = v_authorization.review_id
    and (psi.product_id is null or psi.product_id = new.id);

  get diagnostics v_bound_count = row_count;
  if v_bound_count <> 1 then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:MANUAL_SOURCE_IDENTITY_BIND_FAILED';
  end if;
  return new;
end;
$function$;

revoke all on function public.bind_manual_shopee_identity_after_publish() from public, anon, authenticated;

-- Changing the primary image invalidates only the current human editorial
-- authority.  Historical publication authorization/review evidence remains.
create or replace function public.invalidate_human_editorial_approval_on_image_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_new_primary text;
begin
  v_new_primary := coalesce(
    nullif(btrim(new.image_curation ->> 'primaryImageUrl'), ''),
    nullif(btrim(new.imagens ->> 0), '')
  );
  if old.human_editorial_approved_at is not null
     and v_new_primary is distinct from old.human_editorial_image_url then
    new.human_editorial_approved_at := null;
    new.human_editorial_image_url := null;
    new.human_editorial_image_fingerprint := null;
    new.human_editorial_review_id := null;
    new.human_editorial_authorization_id := null;
    if old.ativo is true and old.status = 'published' then
      new.ativo := false;
      new.status := 'paused';
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function public.invalidate_human_editorial_approval_on_image_change() from public, anon, authenticated;

drop trigger if exists products_invalidate_human_editorial_approval on public.products;
drop trigger if exists products_00_invalidate_human_editorial_approval on public.products;
-- PostgreSQL orders triggers with the same timing/event by name.  The `00`
-- prefix guarantees invalidation pauses the row before the publication guard
-- evaluates the new image.
create trigger products_00_invalidate_human_editorial_approval
before update of imagens, image_curation on public.products
for each row
execute function public.invalidate_human_editorial_approval_on_image_change();

-- Generic, idempotent stale-claim reconciler.  Row locks plus SKIP LOCKED make
-- concurrent runs safe.  A live authorization/execution keeps the claim; a
-- published product finalizes it; otherwise the review is released to error so
-- a fresh human retry can reacquire the normal compare-and-set claim.
create or replace function public.reconcile_stale_telegram_publications(
  p_ttl interval default interval '15 minutes',
  p_limit integer default 100
)
returns table(review_id text, outcome text, published_product_id text)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_review public.telegram_pending_reviews%rowtype;
  v_product_id text;
  v_operation_id text;
  v_has_active_execution boolean;
begin
  if p_ttl < interval '5 minutes' or p_limit < 1 or p_limit > 500 then
    raise exception 'TELEGRAM_PUBLICATION_RECONCILER_ARGUMENT_INVALID';
  end if;

  for v_review in
    select r.*
    from public.telegram_pending_reviews r
    where r.status = 'publishing'
      and r.updated_at < now() - p_ttl
    order by r.updated_at
    limit p_limit
    for update skip locked
  loop
    v_product_id := null;
    v_operation_id := null;

    select p.id, ppa.operation_id
      into v_product_id, v_operation_id
    from public.product_publication_authorizations ppa
    join public.products p on p.id = ppa.product_id
    where ppa.review_id = v_review.id
      and ppa.approval_origin = 'telegram'
      and ppa.consumed_at is not null
      and p.ativo is true
      and p.status = 'published'
    order by ppa.consumed_at desc
    limit 1;

    if v_product_id is null then
      select p.id, ppa.operation_id
        into v_product_id, v_operation_id
      from public.product_publication_authorizations ppa
      join public.products p on p.id = ppa.product_id
      where ppa.operation_id = v_review.data #>> '{lifecycle,operationId}'
        and ppa.approval_origin = 'telegram'
        and ppa.consumed_at is not null
        and coalesce(ppa.review_id, ppa.evidence ->> 'reviewId') = v_review.id
        and p.ativo is true
        and p.status = 'published'
      order by ppa.consumed_at desc
      limit 1;
    end if;

    if v_product_id is null then
      select p.id, coalesce(
        v_review.data #>> '{lifecycle,operationId}',
        ppa.operation_id
      )
        into v_product_id, v_operation_id
      from public.products p
      left join public.product_publication_authorizations ppa
        on ppa.product_id = p.id
       and ppa.consumed_at is not null
      where p.id = v_review.data #>> '{lifecycle,publishedProductId}'
        and p.ativo is true
        and p.status = 'published'
        and ppa.consumed_at is not null
        and ppa.approval_origin = 'telegram'
        and (
          ppa.review_id = v_review.id
          or exists (
            select 1 from public.product_source_identities psi
            where psi.product_id = p.id and psi.review_id = v_review.id
          )
        )
      order by ppa.consumed_at desc nulls last
      limit 1;
    end if;

    if v_product_id is null then
      select p.id, ppa.operation_id
        into v_product_id, v_operation_id
      from public.product_source_identities psi
      join public.products p on p.id = psi.product_id
      join public.product_publication_authorizations ppa
        on ppa.product_id = p.id
       and ppa.approval_origin = 'telegram'
       and ppa.consumed_at is not null
      where lower(psi.marketplace) = 'shopee'
        and p.ativo is true
        and p.status = 'published'
        and (
          psi.review_id = v_review.id
          or (
            psi.shop_id = v_review.data #>> '{existingProduct,shopId}'
            and psi.item_id = v_review.data #>> '{existingProduct,itemId}'
            and psi.source_product_url = v_review.data ->> 'normalizedUrl'
            and coalesce(ppa.review_id, ppa.evidence ->> 'reviewId') = v_review.id
          )
        )
      order by ppa.consumed_at desc
      limit 1;
    end if;

    if v_product_id is not null then
      update public.telegram_pending_reviews
      set status = 'published',
          data = coalesce(v_review.data, '{}'::jsonb)
            || jsonb_build_object(
              'status', 'published',
              'reconciledAt', now(),
              'reconciledOutcome', 'published_product_found',
              'lifecycle', coalesce(v_review.data -> 'lifecycle', '{}'::jsonb)
                || jsonb_build_object(
                  'state', 'PUBLISHED',
                  'publishedProductId', v_product_id,
                  'operationId', coalesce(v_operation_id, v_review.data #>> '{lifecycle,operationId}'),
                  'audit', jsonb_build_array(jsonb_build_object(
                    'type', 'PRODUCT_PUBLISHED',
                    'timestamp', now(),
                    'state', 'PUBLISHED',
                    'reason', 'Publicação confirmada pelo reconciliador idempotente.'
                  )) || case
                    when jsonb_typeof(v_review.data #> '{lifecycle,audit}') = 'array'
                      then v_review.data #> '{lifecycle,audit}'
                    else '[]'::jsonb
                  end
                )
            ),
          updated_at = now()
      where id = v_review.id and status = 'publishing';

      review_id := v_review.id;
      outcome := 'published';
      published_product_id := v_product_id;
      return next;
      continue;
    end if;

    select exists (
      select 1
      from public.product_publication_authorizations ppa
      where ppa.review_id = v_review.id
        and ppa.consumed_at is null
        and ppa.expires_at > now()
      union all
      select 1
      from public.publication_executions pe
      where pe.status in ('PENDING','VALIDATING','AUTHORIZED','EXECUTING')
        and pe.updated_at >= now() - p_ttl
        and (
          pe.candidate_id = v_review.id
          or pe.correlation_id = v_review.data #>> '{lifecycle,operationId}'
          or pe.metadata ->> 'reviewId' = v_review.id
        )
    ) into v_has_active_execution;

    if v_has_active_execution then
      review_id := v_review.id;
      outcome := 'active_execution';
      published_product_id := null;
      return next;
      continue;
    end if;

    update public.product_source_identities psi
    set review_id = null,
        reserved_run_id = null,
        reserved_until = null,
        updated_at = now()
    where psi.review_id = v_review.id and psi.product_id is null;

    update public.product_publication_authorizations ppa
    set expires_at = least(ppa.expires_at, now())
    where ppa.review_id = v_review.id
      and ppa.consumed_at is null;

    update public.telegram_pending_reviews
    set status = 'error',
        data = coalesce(v_review.data, '{}'::jsonb)
          || jsonb_build_object(
            'status', 'error',
            'reconciledAt', now(),
            'reconciledOutcome', 'claim_released_no_product',
            'lifecycle', coalesce(v_review.data -> 'lifecycle', '{}'::jsonb)
              || jsonb_build_object(
                'state', 'ERROR',
                'error', 'PERSISTENCE_ERROR',
                'audit', jsonb_build_array(jsonb_build_object(
                  'type', 'PRODUCT_PUBLICATION_FAILED',
                  'timestamp', now(),
                  'state', 'ERROR',
                  'reason', 'Claim órfã liberada pelo reconciliador idempotente.'
                )) || case
                  when jsonb_typeof(v_review.data #> '{lifecycle,audit}') = 'array'
                    then v_review.data #> '{lifecycle,audit}'
                  else '[]'::jsonb
                end
              )
          ),
        updated_at = now()
    where id = v_review.id and status = 'publishing';

    review_id := v_review.id;
    outcome := 'released_to_error';
    published_product_id := null;
    return next;
  end loop;
end;
$function$;

revoke all on function public.reconcile_stale_telegram_publications(interval, integer) from public, anon, authenticated;
grant execute on function public.reconcile_stale_telegram_publications(interval, integer) to service_role;

comment on function public.reconcile_stale_telegram_publications(interval, integer) is
  'Idempotently finalizes or releases stale Telegram publishing claims without creating products.';
comment on column public.product_publication_authorizations.review_id is
  'Durable Telegram review identifier; retained after review archival and product publication.';
comment on column public.products.human_editorial_image_fingerprint is
  'Separate human editorial authority for the exact current primary image; never aliases automatic AI review state.';

commit;
