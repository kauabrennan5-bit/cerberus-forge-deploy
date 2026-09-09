\set ON_ERROR_STOP on

begin;

create function pg_temp.seed_product(p_id text, p_created_by text)
returns void
language plpgsql
as $$
declare
  v_image text := 'https://cdn.example.com/' || p_id || '.jpg';
begin
  insert into public.products (
    id, ref, produto, categoria, preco, imagens, link, ativo, destaque, status,
    created_by, slug, descricao, raw_title, display_title,
    display_title_status, image_editorial_status, image_curation
  ) values (
    p_id, 'REF-' || p_id, 'Produto técnico ' || p_id, 'Iluminação', 99.90,
    jsonb_build_array(v_image), 'https://s.shopee.com.br/' || p_id,
    false, false, 'paused', p_created_by, p_id, 'Descrição factual.',
    'Título bruto ' || p_id, 'Luminária editorial ' || p_id,
    'reviewed', 'review_required', jsonb_build_object(
      'status', 'review_required',
      'primaryImageUrl', v_image,
      'rawImageUrls', jsonb_build_array(v_image),
      'galleryImageUrls', '[]'::jsonb,
      'assessments', '[]'::jsonb
    )
  );
end;
$$;

create function pg_temp.expect_publication_blocked(p_id text)
returns void
language plpgsql
as $$
begin
  begin
    update public.products set ativo = true, status = 'published' where id = p_id;
    raise exception 'TEST_EXPECTED_PUBLICATION_BLOCK';
  exception when others then
    if sqlerrm = 'TEST_EXPECTED_PUBLICATION_BLOCK' then
      raise;
    end if;
    if position('PRODUCT_PUBLICATION_BLOCKED:HUMAN_AUTHORIZATION_MISSING' in sqlerrm) = 0 then
      raise exception 'Unexpected publication failure for %: %', p_id, sqlerrm;
    end if;
  end;

  if exists (
    select 1 from public.products
    where id = p_id and ativo is true and status = 'published'
  ) then
    raise exception 'Autonomous product % became public', p_id;
  end if;
end;
$$;

-- Even an attempted future configuration drift is rejected by PostgreSQL.
do $$
begin
  begin
    update public.autonomous_curator_config
    set auto_publish_enabled = true
    where id = 'default';
    raise exception 'TEST_EXPECTED_AUTO_PUBLISH_CONFIG_BLOCK';
  exception when check_violation then
    null;
  end;
  if exists (
    select 1 from public.autonomous_curator_config
    where id = 'default' and auto_publish_enabled is distinct from false
  ) then
    raise exception 'auto_publish_enabled escaped its permanent false invariant';
  end if;
end;
$$;

-- Score, deficit fallback, best-of-lot and recovery records never constitute
-- publication authority without a persisted Telegram approval.
select pg_temp.seed_product('ci-autonomous-score', 'autonomous_curator_queue');
select pg_temp.seed_product('ci-deficit-fallback', 'autonomous_curator_queue');
select pg_temp.seed_product('ci-best-of-lot', 'autonomous_curator_queue');
select pg_temp.seed_product('ci-recovery', 'autonomous_curator_queue');

insert into public.product_source_identities (
  marketplace, shop_id, item_id, source_product_url, product_id, source
)
select 'Shopee', 'shop-' || id, 'item-' || id,
       'https://shopee.com.br/product/shop-' || id || '/item-' || id,
       id, 'autonomous_curator'
from public.products
where id in ('ci-autonomous-score', 'ci-deficit-fallback', 'ci-best-of-lot', 'ci-recovery');

insert into public.product_publication_authorizations (
  authorization_id, product_id, source, gate_version, score, threshold,
  maximum_catalog_similarity, evidence, expires_at
)
values
  (gen_random_uuid(), 'ci-autonomous-score', 'autonomous_curator', 'ci', 100, 70, 0,
    '{"lifecycleApproved":true,"categoryMismatch":false,"offBrand":false,"reviewState":"APPROVED"}'::jsonb,
    now() + interval '1 hour'),
  (gen_random_uuid(), 'ci-deficit-fallback', 'autonomous_curator', 'ci', 1, 70, 0,
    '{"deficitFallback":true,"categoryMismatch":false}'::jsonb,
    now() + interval '1 hour'),
  (gen_random_uuid(), 'ci-best-of-lot', 'autonomous_curator', 'ci', 1, 70, 0,
    '{"bestOfLotFallback":true,"categoryMismatch":false}'::jsonb,
    now() + interval '1 hour'),
  (gen_random_uuid(), 'ci-recovery', 'recovery', 'ci', 100, 70, 0,
    '{"deficitFallback":true,"bestOfLotFallback":true,"lifecycleApproved":true,"categoryMismatch":false}'::jsonb,
    now() + interval '1 hour');

select pg_temp.expect_publication_blocked('ci-autonomous-score');
select pg_temp.expect_publication_blocked('ci-deficit-fallback');
select pg_temp.expect_publication_blocked('ci-best-of-lot');
select pg_temp.expect_publication_blocked('ci-recovery');

-- A real Telegram claim with matching operation, Shopee identity and image
-- fingerprint is the one positive publication case.
select pg_temp.seed_product('ci-human-product', 'telegram_manual');

insert into public.telegram_pending_reviews (
  id, chat_id, sender_id, created_at, expires_at, status, data, updated_at
) values (
  'ci-human-review', 'ci-chat', 'ci-sender',
  (extract(epoch from clock_timestamp()) * 1000)::bigint,
  (extract(epoch from clock_timestamp() + interval '1 hour') * 1000)::bigint,
  'publishing',
  jsonb_build_object(
    'id', 'ci-human-review',
    'status', 'publishing',
    'normalizedUrl', 'https://shopee.com.br/product/123456/789012',
    'imagemPrincipal', 'https://cdn.example.com/ci-human-product.jpg',
    'imageCuration', jsonb_build_object('primaryImageUrl', 'https://cdn.example.com/ci-human-product.jpg'),
    'existingProduct', jsonb_build_object(
      'shopId', '123456',
      'itemId', '789012',
      'humanApproval', jsonb_build_object(
        'origin', 'telegram',
        'reviewId', 'ci-human-review',
        'operationId', 'ci-human-operation',
        'approvedAt', '2026-09-08T12:00:00.000Z',
        'shopId', '123456',
        'itemId', '789012',
        'sourceProductUrl', 'https://shopee.com.br/product/123456/789012',
        'primaryImageUrl', 'https://cdn.example.com/ci-human-product.jpg',
        'primaryImageFingerprint', 'sha256:fa673166334ab40d9f4d23e62c8f18670744ecbbe72f0c9886e7f1592dc8b940'
      )
    ),
    'lifecycle', jsonb_build_object(
      'state', 'APPROVED',
      'humanApproved', true,
      'operationId', 'ci-human-operation',
      'audit', jsonb_build_array(jsonb_build_object(
        'type', 'PRODUCT_APPROVED',
        'timestamp', '2026-09-08T12:00:00.000Z'
      ))
    )
  ),
  now()
);

insert into public.product_source_identities (
  marketplace, shop_id, item_id, source_product_url, product_id, review_id, source
) values (
  'Shopee', '123456', '789012',
  'https://shopee.com.br/product/123456/789012',
  null, 'ci-human-review', 'autonomous_curator'
);

insert into public.product_publication_authorizations (
  authorization_id, product_id, source, gate_version, score, threshold,
  maximum_catalog_similarity, evidence, expires_at, review_id, approved_at,
  approval_origin, shop_id, item_id, source_product_url, primary_image_url,
  image_fingerprint, operation_id, human_approval_evidence
) values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ci-human-product', 'admin', 'ci',
  0, 88, 0,
  jsonb_build_object(
    'primaryImageUrl', 'https://cdn.example.com/ci-human-product.jpg',
    'humanManualApproval', true,
    'categoryMismatch', false,
    'reviewId', 'ci-human-review',
    'operationId', 'ci-human-operation'
  ),
  now() + interval '1 hour',
  'ci-human-review', '2026-09-08T12:00:00.000Z', 'telegram',
  '123456', '789012', 'https://shopee.com.br/product/123456/789012',
  'https://cdn.example.com/ci-human-product.jpg',
  'sha256:fa673166334ab40d9f4d23e62c8f18670744ecbbe72f0c9886e7f1592dc8b940',
  'ci-human-operation',
  jsonb_build_object(
    'kind', 'telegram_callback',
    'origin', 'telegram',
    'reviewId', 'ci-human-review',
    'operationId', 'ci-human-operation',
    'approvedAt', '2026-09-08T12:00:00.000Z',
    'shopId', '123456',
    'itemId', '789012',
    'sourceProductUrl', 'https://shopee.com.br/product/123456/789012',
    'primaryImageUrl', 'https://cdn.example.com/ci-human-product.jpg',
    'primaryImageFingerprint', 'sha256:fa673166334ab40d9f4d23e62c8f18670744ecbbe72f0c9886e7f1592dc8b940'
  )
);

update public.products
set ativo = true, status = 'published'
where id = 'ci-human-product';

do $$
begin
  if not exists (
    select 1
    from public.products p
    join public.product_publication_authorizations ppa
      on ppa.authorization_id = p.human_editorial_authorization_id
    join public.product_source_identities psi
      on psi.product_id = p.id and psi.review_id = ppa.review_id
    where p.id = 'ci-human-product'
      and p.ativo is true
      and p.status = 'published'
      and p.human_editorial_review_id = 'ci-human-review'
      and ppa.review_id = 'ci-human-review'
      and ppa.operation_id = 'ci-human-operation'
      and ppa.approval_origin = 'telegram'
      and ppa.consumed_at is not null
  ) then
    raise exception 'Valid Telegram approval did not produce the durable audit chain';
  end if;

  begin
    update public.products set created_by = 'system' where id = 'ci-human-product';
    raise exception 'TEST_EXPECTED_ORIGIN_IMMUTABILITY_BLOCK';
  exception when others then
    if sqlerrm = 'TEST_EXPECTED_ORIGIN_IMMUTABILITY_BLOCK' then raise; end if;
    if position('PRODUCT_PUBLICATION_BLOCKED:PUBLICATION_ORIGIN_IMMUTABLE' in sqlerrm) = 0 then
      raise exception 'Unexpected origin mutation failure: %', sqlerrm;
    end if;
  end;

  begin
    update public.products set preco = 0 where id = 'ci-human-product';
    raise exception 'TEST_EXPECTED_TECHNICAL_BLOCK';
  exception when others then
    if sqlerrm = 'TEST_EXPECTED_TECHNICAL_BLOCK' then raise; end if;
    if position('PRODUCT_PUBLICATION_BLOCKED:PRICE_UNVERIFIED' in sqlerrm) = 0 then
      raise exception 'Unexpected technical mutation failure: %', sqlerrm;
    end if;
  end;
end;
$$;

-- Reconciler cases: published product found, no product, recent claim and an
-- already-finalized review. Running it twice must have no second effect.
update public.telegram_pending_reviews
set updated_at = now() - interval '1 hour'
where id = 'ci-human-review';

insert into public.telegram_pending_reviews (
  id, chat_id, sender_id, created_at, expires_at, status, data, updated_at
)
values
  ('ci-stale-no-product', 'ci-chat', 'ci-sender', 1, 2, 'publishing',
    '{"id":"ci-stale-no-product","status":"publishing","lifecycle":{"state":"APPROVED"}}'::jsonb,
    now() - interval '1 hour'),
  ('ci-recent-publishing', 'ci-chat', 'ci-sender', 1, 2, 'publishing',
    '{"id":"ci-recent-publishing","status":"publishing"}'::jsonb,
    now()),
  ('ci-already-finalized', 'ci-chat', 'ci-sender', 1, 2, 'published',
    '{"id":"ci-already-finalized","status":"published"}'::jsonb,
    now() - interval '1 hour');

do $$
declare
  v_processed integer;
begin
  select count(*) into v_processed
  from public.reconcile_stale_telegram_publications(interval '15 minutes', 100);
  if v_processed <> 2 then
    raise exception 'Expected exactly two stale reviews, got %', v_processed;
  end if;
  if not exists (
    select 1 from public.telegram_pending_reviews
    where id = 'ci-human-review'
      and status = 'published'
      and data #>> '{lifecycle,publishedProductId}' = 'ci-human-product'
  ) then
    raise exception 'Existing published product was not reconciled';
  end if;
  if not exists (
    select 1 from public.telegram_pending_reviews
    where id = 'ci-stale-no-product' and status = 'error'
  ) then
    raise exception 'Orphan publication claim was not released';
  end if;
  if not exists (
    select 1 from public.telegram_pending_reviews
    where id = 'ci-recent-publishing' and status = 'publishing'
  ) then
    raise exception 'Recent publishing claim was modified';
  end if;
  if not exists (
    select 1 from public.telegram_pending_reviews
    where id = 'ci-already-finalized' and status = 'published'
  ) then
    raise exception 'Already-finalized review was modified';
  end if;

  select count(*) into v_processed
  from public.reconcile_stale_telegram_publications(interval '15 minutes', 100);
  if v_processed <> 0 then
    raise exception 'Repeated reconciler execution was not idempotent';
  end if;
end;
$$;

-- Archive the review and prove the durable authorization still answers which
-- human Telegram decision originated the product.
update public.telegram_pending_reviews
set updated_at = now() - interval '8 days'
where id = 'ci-human-review';
select private.archive_terminal_telegram_reviews(interval '7 days');

do $$
begin
  if exists (select 1 from public.telegram_pending_reviews where id = 'ci-human-review') then
    raise exception 'Terminal review was not archived for audit test';
  end if;
  if not exists (select 1 from private.telegram_pending_reviews_archive where id = 'ci-human-review') then
    raise exception 'Archived Telegram review is missing';
  end if;
  if not exists (
    select 1
    from public.products p
    join public.product_publication_authorizations ppa
      on ppa.product_id = p.id and ppa.review_id = p.human_editorial_review_id
    where p.id = 'ci-human-product'
      and ppa.review_id = 'ci-human-review'
      and ppa.approval_origin = 'telegram'
      and ppa.consumed_at is not null
  ) then
    raise exception 'Approval-to-product audit was lost after review archival';
  end if;

  begin
    update public.product_publication_authorizations
    set review_id = null
    where authorization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    raise exception 'TEST_EXPECTED_CONSUMED_AUTHORIZATION_UPDATE_BLOCK';
  exception when others then
    if sqlerrm = 'TEST_EXPECTED_CONSUMED_AUTHORIZATION_UPDATE_BLOCK' then raise; end if;
    if position('PRODUCT_PUBLICATION_AUTHORIZATION_IMMUTABLE_AFTER_CONSUMPTION' in sqlerrm) = 0 then
      raise exception 'Unexpected consumed authorization update failure: %', sqlerrm;
    end if;
  end;

  begin
    delete from public.product_publication_authorizations
    where authorization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    raise exception 'TEST_EXPECTED_CONSUMED_AUTHORIZATION_DELETE_BLOCK';
  exception when others then
    if sqlerrm = 'TEST_EXPECTED_CONSUMED_AUTHORIZATION_DELETE_BLOCK' then raise; end if;
    if position('PRODUCT_PUBLICATION_AUTHORIZATION_IMMUTABLE_AFTER_CONSUMPTION' in sqlerrm) = 0 then
      raise exception 'Unexpected consumed authorization delete failure: %', sqlerrm;
    end if;
  end;

  update public.products
  set imagens = '["https://cdn.example.com/ci-human-product-changed.jpg"]'::jsonb,
      image_curation = jsonb_set(
        image_curation,
        '{primaryImageUrl}',
        '"https://cdn.example.com/ci-human-product-changed.jpg"'::jsonb
      )
  where id = 'ci-human-product';

  if not exists (
    select 1 from public.products
    where id = 'ci-human-product'
      and ativo is false
      and status = 'paused'
      and human_editorial_approved_at is null
      and human_editorial_image_fingerprint is null
      and human_editorial_review_id is null
      and human_editorial_authorization_id is null
  ) then
    raise exception 'Image change did not invalidate human authority and pause the product';
  end if;
end;
$$;

rollback;
