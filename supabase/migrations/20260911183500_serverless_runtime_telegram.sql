begin;

create table if not exists public.catalog_overlay_entries (
  product_id text primary key,
  action text not null check (action in ('upsert','hide')),
  source text not null,
  review_id text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  updated_at timestamptz not null default now()
);

create table if not exists public.telegram_decision_events (
  id uuid primary key default gen_random_uuid(),
  decision text not null check (decision in ('publish','discard','rotation_approve','rotation_retry','rotation_cancel')),
  review_id text,
  rotation_request_id uuid,
  sender_id text not null,
  chat_id text not null,
  message_id text,
  callback_query_id text,
  operation_id text,
  product_id text,
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz not null default now()
);

create unique index if not exists telegram_decision_events_callback_query_uidx
  on public.telegram_decision_events(callback_query_id)
  where callback_query_id is not null;
create index if not exists telegram_decision_events_review_idx
  on public.telegram_decision_events(review_id, created_at desc);
create index if not exists telegram_decision_events_rotation_idx
  on public.telegram_decision_events(rotation_request_id, created_at desc);

create table if not exists public.telegram_webhook_updates (
  update_id bigint primary key,
  payload_hash text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received' check (status in ('received','processed','rejected','error')),
  error_code text
);

alter table public.catalog_overlay_entries enable row level security;
alter table public.telegram_decision_events enable row level security;
alter table public.telegram_webhook_updates enable row level security;

create or replace function public.cerberus_telegram_register_update(
  p_update_id bigint,
  p_payload_hash text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_update_id is null or p_update_id < 0 or nullif(btrim(p_payload_hash), '') is null then
    return false;
  end if;
  insert into public.telegram_webhook_updates(update_id, payload_hash)
  values (p_update_id, p_payload_hash)
  on conflict (update_id) do nothing;
  return found;
end;
$$;

create or replace function public.cerberus_telegram_mark_update(
  p_update_id bigint,
  p_status text,
  p_error_code text default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('processed','rejected','error') then
    raise exception 'INVALID_TELEGRAM_UPDATE_STATUS';
  end if;
  update public.telegram_webhook_updates
  set status = p_status,
      error_code = case when p_error_code is null then null else left(p_error_code, 120) end,
      processed_at = now()
  where update_id = p_update_id;
end;
$$;

create or replace function public.cerberus_telegram_discard_review(
  p_review_id text,
  p_sender_id text,
  p_chat_id text,
  p_message_id text,
  p_callback_query_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_review public.telegram_pending_reviews%rowtype;
begin
  select * into v_review
  from public.telegram_pending_reviews
  where id = p_review_id
  for update;

  if not found then
    raise exception 'TELEGRAM_REVIEW_NOT_FOUND';
  end if;
  if v_review.status = 'published' then
    raise exception 'TELEGRAM_REVIEW_ALREADY_PUBLISHED';
  end if;

  update public.telegram_pending_reviews
  set status = 'cancelled',
      data = coalesce(data, '{}'::jsonb) || jsonb_build_object(
        'serverlessDecision', jsonb_build_object(
          'decision', 'discard',
          'senderId', p_sender_id,
          'chatId', p_chat_id,
          'messageId', p_message_id,
          'callbackQueryId', p_callback_query_id,
          'decidedAt', now()
        )
      ),
      updated_at = now()
  where id = p_review_id;

  insert into public.telegram_decision_events(
    decision, review_id, sender_id, chat_id, message_id, callback_query_id, evidence
  ) values (
    'discard', p_review_id, p_sender_id, p_chat_id, p_message_id, p_callback_query_id,
    jsonb_build_object('origin','telegram','reviewStatusBefore',v_review.status)
  ) on conflict (callback_query_id) where callback_query_id is not null do nothing;

  return jsonb_build_object('ok', true, 'reviewId', p_review_id, 'status', 'cancelled');
end;
$$;

create or replace function public.cerberus_telegram_publish_review(
  p_review_id text,
  p_sender_id text,
  p_chat_id text,
  p_message_id text,
  p_callback_query_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_review public.telegram_pending_reviews%rowtype;
  v_data jsonb;
  v_product_id text;
  v_ref text;
  v_slug text;
  v_title text;
  v_display_title text;
  v_category text;
  v_price numeric;
  v_images jsonb;
  v_link text;
  v_source_url text;
  v_description text;
  v_raw_title text;
  v_image_curation jsonb;
  v_primary_image text;
  v_fingerprint text;
  v_shop_id text;
  v_item_id text;
  v_operation_id text;
  v_authorization_id uuid;
  v_approved_at timestamptz;
  v_human_evidence jsonb;
  v_existing_identity_product text;
  v_score numeric := 100;
begin
  select * into v_review
  from public.telegram_pending_reviews
  where id = p_review_id
  for update;

  if not found then
    raise exception 'TELEGRAM_REVIEW_NOT_FOUND';
  end if;
  if v_review.status = 'published' then
    select product_id, operation_id into v_product_id, v_operation_id
    from public.telegram_decision_events
    where review_id = p_review_id and decision = 'publish'
    order by created_at desc limit 1;
    return jsonb_build_object('ok', true, 'replayed', true, 'reviewId', p_review_id, 'productId', v_product_id, 'operationId', v_operation_id);
  end if;
  if v_review.status not in ('pending','error') then
    raise exception 'TELEGRAM_REVIEW_NOT_PUBLISHABLE:%', v_review.status;
  end if;

  v_data := coalesce(v_review.data, '{}'::jsonb);
  v_title := nullif(btrim(coalesce(v_data->>'produto', v_data->>'rawTitle')), '');
  v_display_title := nullif(btrim(coalesce(v_data->>'displayTitle', v_title)), '');
  v_category := nullif(btrim(v_data->>'categoria'), '');
  if coalesce(v_data->>'preco','') !~ '^[0-9]+([.][0-9]+)?$' then
    raise exception 'TELEGRAM_REVIEW_PRICE_INVALID';
  end if;
  v_price := (v_data->>'preco')::numeric;
  v_images := case when jsonb_typeof(v_data->'imagens') = 'array' then v_data->'imagens' else '[]'::jsonb end;
  v_primary_image := coalesce(
    nullif(btrim(v_data#>>'{imageCuration,primaryImageUrl}'), ''),
    nullif(btrim(v_data->>'imagemPrincipal'), ''),
    nullif(btrim(v_images->>0), '')
  );
  v_link := nullif(btrim(v_data->>'link'), '');
  v_source_url := nullif(btrim(coalesce(v_data->>'normalizedUrl', v_data->>'sourceProductUrl')), '');
  v_shop_id := nullif(btrim(coalesce(v_data->>'shopId', v_data#>>'{existingProduct,shopId}')), '');
  v_item_id := nullif(btrim(coalesce(v_data->>'itemId', v_data#>>'{existingProduct,itemId}')), '');
  v_description := left(coalesce(v_data->>'descricao',''), 4000);
  v_raw_title := left(coalesce(v_data->>'rawTitle', v_title), 500);

  if v_title is null or v_display_title is null or char_length(v_display_title) < 3 then raise exception 'TELEGRAM_REVIEW_TITLE_INVALID'; end if;
  if char_length(v_display_title) > 90 then v_display_title := left(v_display_title, 90); end if;
  if v_category not in ('Iluminação','Decoração','Móveis','Cozinha & Mesa','Organização','Vestuário','Calçados & Acessórios','Tecnologia','Beleza & Bem-estar','Infantil') then raise exception 'TELEGRAM_REVIEW_CATEGORY_INVALID'; end if;
  if v_price <= 0 then raise exception 'TELEGRAM_REVIEW_PRICE_INVALID'; end if;
  if v_link is null or v_link !~* '^https://([^/]+\.)?shopee\.com\.br/' then raise exception 'TELEGRAM_REVIEW_AFFILIATE_LINK_INVALID'; end if;
  if v_source_url is null or v_source_url !~* '^https://([^/]+\.)?shopee\.com\.br/' then raise exception 'TELEGRAM_REVIEW_SOURCE_URL_INVALID'; end if;
  if v_primary_image is null or v_primary_image !~* '^https://' then raise exception 'TELEGRAM_REVIEW_IMAGE_INVALID'; end if;
  if v_shop_id is null or v_item_id is null then raise exception 'TELEGRAM_REVIEW_SHOPEE_IDENTITY_MISSING'; end if;

  v_product_id := coalesce(nullif(btrim(v_data->>'productId'), ''), 'prod-tg-' || substr(md5(p_review_id),1,20));
  v_ref := coalesce(nullif(btrim(v_data->>'ref'), ''), 'TGM-' || upper(substr(md5(p_review_id),1,10)));
  v_slug := coalesce(nullif(btrim(v_data->>'slug'), ''), 'telegram-' || substr(md5(p_review_id),1,16));
  v_image_curation := case
    when jsonb_typeof(v_data->'imageCuration') = 'object' then v_data->'imageCuration'
    else jsonb_build_object('status','ready','primaryImageUrl',v_primary_image)
  end;
  v_fingerprint := 'sha256:' || encode(digest(v_primary_image, 'sha256'), 'hex');
  v_operation_id := 'EDGE-PUB-' || replace(gen_random_uuid()::text,'-','');
  v_authorization_id := gen_random_uuid();
  v_approved_at := clock_timestamp();

  if coalesce(v_data#>>'{curation,score}','') ~ '^[0-9]+([.][0-9]+)?$' then
    v_score := least(100, greatest(0, (v_data#>>'{curation,score}')::numeric));
  end if;

  select product_id into v_existing_identity_product
  from public.product_source_identities
  where lower(marketplace) = 'shopee' and shop_id = v_shop_id and item_id = v_item_id
  for update;
  if found and v_existing_identity_product is not null and v_existing_identity_product <> v_product_id then
    raise exception 'TELEGRAM_REVIEW_SHOPEE_IDENTITY_ALREADY_BOUND';
  end if;

  insert into public.products(
    id, ref, produto, categoria, preco, imagens, link, ativo, destaque, status,
    created_by, slug, descricao, raw_title, display_title, image_editorial_status,
    image_curation, display_title_status
  ) values (
    v_product_id, v_ref, v_title, v_category, v_price, v_images, v_link, false,
    coalesce((v_data->>'destaque')::boolean, false), 'pending', 'telegram_manual',
    v_slug, v_description, v_raw_title, v_display_title, 'review_required',
    v_image_curation, 'review_required'
  )
  on conflict (id) do update set
    ref = excluded.ref,
    produto = excluded.produto,
    categoria = excluded.categoria,
    preco = excluded.preco,
    imagens = excluded.imagens,
    link = excluded.link,
    destaque = excluded.destaque,
    status = 'pending',
    ativo = false,
    created_by = 'telegram_manual',
    slug = excluded.slug,
    descricao = excluded.descricao,
    raw_title = excluded.raw_title,
    display_title = excluded.display_title,
    image_editorial_status = 'review_required',
    image_curation = excluded.image_curation,
    display_title_status = 'review_required';

  if v_existing_identity_product is null then
    insert into public.product_source_identities(marketplace,shop_id,item_id,source_product_url,product_id,review_id,source)
    values ('shopee',v_shop_id,v_item_id,v_source_url,v_product_id,p_review_id,'telegram_manual')
    on conflict (marketplace,shop_id,item_id) do update set
      source_product_url = excluded.source_product_url,
      product_id = excluded.product_id,
      review_id = excluded.review_id,
      source = excluded.source,
      updated_at = now();
  else
    update public.product_source_identities
    set source_product_url = v_source_url,
        product_id = v_product_id,
        review_id = p_review_id,
        source = 'telegram_manual',
        updated_at = now()
    where lower(marketplace)='shopee' and shop_id=v_shop_id and item_id=v_item_id;
  end if;

  v_human_evidence := jsonb_build_object(
    'origin','telegram',
    'reviewId',p_review_id,
    'operationId',v_operation_id,
    'approvedAt',v_approved_at,
    'approverUserId',p_sender_id,
    'chatId',p_chat_id,
    'messageId',p_message_id,
    'callbackQueryId',p_callback_query_id,
    'shopId',v_shop_id,
    'itemId',v_item_id,
    'sourceProductUrl',v_source_url,
    'primaryImageUrl',v_primary_image,
    'primaryImageFingerprint',v_fingerprint
  );

  update public.telegram_pending_reviews
  set status='publishing',
      data = v_data
        || jsonb_build_object('normalizedUrl',v_source_url,'imageCuration',v_image_curation)
        || jsonb_build_object('lifecycle', coalesce(v_data->'lifecycle','{}'::jsonb) || jsonb_build_object('humanApproved',true,'operationId',v_operation_id))
        || jsonb_build_object('existingProduct', coalesce(v_data->'existingProduct','{}'::jsonb) || jsonb_build_object('humanApproval',v_human_evidence)),
      updated_at=now()
  where id=p_review_id;

  insert into public.product_publication_authorizations(
    authorization_id, product_id, source, gate_version, score, threshold,
    maximum_catalog_similarity, evidence, expires_at, review_id, approved_at,
    approval_origin, shop_id, item_id, source_product_url, primary_image_url,
    image_fingerprint, operation_id, human_approval_evidence
  ) values (
    v_authorization_id, v_product_id, 'admin', 'serverless-human-v1', v_score, 1,
    0, jsonb_build_object('humanManualApproval',true,'categoryMismatch',false,'primaryImageUrl',v_primary_image),
    now() + interval '10 minutes', p_review_id, v_approved_at, 'telegram', v_shop_id,
    v_item_id, v_source_url, v_primary_image, v_fingerprint, v_operation_id, v_human_evidence
  );

  update public.products
  set ativo=true, status='published'
  where id=v_product_id;

  update public.telegram_pending_reviews
  set status='published', updated_at=now()
  where id=p_review_id;

  insert into public.catalog_overlay_entries(product_id,action,source,review_id,metadata,updated_at)
  values(v_product_id,'upsert','telegram_publish',p_review_id,jsonb_build_object('operationId',v_operation_id),now())
  on conflict(product_id) do update set action='upsert',source=excluded.source,review_id=excluded.review_id,metadata=excluded.metadata,updated_at=now();

  insert into public.telegram_decision_events(
    decision, review_id, sender_id, chat_id, message_id, callback_query_id,
    operation_id, product_id, evidence
  ) values (
    'publish',p_review_id,p_sender_id,p_chat_id,p_message_id,p_callback_query_id,
    v_operation_id,v_product_id,v_human_evidence
  ) on conflict (callback_query_id) where callback_query_id is not null do nothing;

  return jsonb_build_object(
    'ok',true,'replayed',false,'reviewId',p_review_id,'productId',v_product_id,
    'authorizationId',v_authorization_id,'operationId',v_operation_id,'approvedAt',v_approved_at
  );
end;
$$;

create or replace function public.cerberus_telegram_apply_rotation(
  p_request_id uuid,
  p_sender_id text,
  p_chat_id text,
  p_message_id text,
  p_callback_query_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.product_rotation_requests%rowtype;
  v_source public.products%rowtype;
  v_candidate public.products%rowtype;
  v_primary_image text;
  v_fingerprint text;
  v_shop_id text;
  v_item_id text;
  v_source_url text;
  v_operation_id text;
  v_authorization_id uuid;
  v_approved_at timestamptz;
  v_human_evidence jsonb;
begin
  select * into v_request from public.product_rotation_requests where id=p_request_id for update;
  if not found then raise exception 'ROTATION_REQUEST_NOT_FOUND'; end if;
  if v_request.status='replaced' then
    return jsonb_build_object('ok',true,'replayed',true,'requestId',p_request_id,'productId',v_request.replacement_product_id);
  end if;
  if v_request.status<>'candidate_ready' or v_request.candidate_product_id is null then
    raise exception 'ROTATION_NOT_READY:%',v_request.status;
  end if;

  select * into v_source from public.products where id=v_request.source_product_id for update;
  select * into v_candidate from public.products where id=v_request.candidate_product_id for update;
  if v_source.id is null or v_candidate.id is null then raise exception 'ROTATION_PRODUCTS_MISSING'; end if;
  if v_source.ativo is not true or v_source.status<>'published' then raise exception 'ROTATION_SOURCE_NOT_PUBLIC'; end if;
  if v_candidate.ativo is true and v_candidate.status='published' then raise exception 'ROTATION_CANDIDATE_ALREADY_PUBLIC'; end if;

  v_primary_image := coalesce(nullif(btrim(v_candidate.image_curation->>'primaryImageUrl'),''),nullif(btrim(v_candidate.imagens->>0),''));
  if v_primary_image is null or v_primary_image !~* '^https://' then raise exception 'ROTATION_PRIMARY_IMAGE_INVALID'; end if;
  if v_candidate.link is null or v_candidate.link !~* '^https://([^/]+\.)?shopee\.com\.br/' then raise exception 'ROTATION_AFFILIATE_LINK_INVALID'; end if;

  select shop_id,item_id,source_product_url into v_shop_id,v_item_id,v_source_url
  from public.product_source_identities
  where product_id=v_candidate.id and lower(marketplace)='shopee'
  limit 1 for update;
  if v_shop_id is null or v_item_id is null or v_source_url is null then raise exception 'ROTATION_SHOPEE_IDENTITY_INVALID'; end if;

  v_fingerprint := 'sha256:' || encode(digest(v_primary_image,'sha256'),'hex');
  v_operation_id := 'EDGE-ROT-' || replace(gen_random_uuid()::text,'-','');
  v_authorization_id := gen_random_uuid();
  v_approved_at := clock_timestamp();
  v_human_evidence := jsonb_build_object(
    'kind','product_rotation_telegram_callback','origin','telegram','reviewId',p_request_id::text,
    'operationId',v_operation_id,'approvedAt',v_approved_at,'approverUserId',p_sender_id,
    'chatId',p_chat_id,'messageId',p_message_id,'callbackQueryId',p_callback_query_id,
    'candidateProductId',v_candidate.id,'shopId',v_shop_id,'itemId',v_item_id,
    'sourceProductUrl',v_source_url,'primaryImageUrl',v_primary_image,'primaryImageFingerprint',v_fingerprint
  );

  update public.product_rotation_requests
  set status='applying',
      metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object('human_approval',v_human_evidence),
      updated_at=now()
  where id=p_request_id;

  update public.products set created_by='telegram_rotation_candidate' where id=v_candidate.id and ativo is not true;

  insert into public.product_publication_authorizations(
    authorization_id,product_id,source,gate_version,score,threshold,maximum_catalog_similarity,
    evidence,expires_at,review_id,approved_at,approval_origin,shop_id,item_id,source_product_url,
    primary_image_url,image_fingerprint,operation_id,human_approval_evidence
  ) values (
    v_authorization_id,v_candidate.id,'product_rotation','serverless-rotation-human-v1',100,1,0,
    jsonb_build_object('humanManualApproval',true,'manualEditorialOverride',true,'categoryMismatch',false,'primaryImageUrl',v_primary_image),
    now()+interval '10 minutes',p_request_id::text,v_approved_at,'telegram',v_shop_id,v_item_id,v_source_url,
    v_primary_image,v_fingerprint,v_operation_id,v_human_evidence
  );

  update public.products set ativo=true,status='published' where id=v_candidate.id;
  update public.products set ativo=false,status='archived' where id=v_source.id;

  update public.product_rotation_requests
  set status='replaced',replacement_product_id=v_candidate.id,reason='ROTATED_BY_USER',completed_at=now(),updated_at=now()
  where id=p_request_id;

  insert into public.catalog_overlay_entries(product_id,action,source,review_id,metadata,updated_at)
  values(v_source.id,'hide','telegram_rotation',p_request_id::text,jsonb_build_object('operationId',v_operation_id),now())
  on conflict(product_id) do update set action='hide',source=excluded.source,review_id=excluded.review_id,metadata=excluded.metadata,updated_at=now();
  insert into public.catalog_overlay_entries(product_id,action,source,review_id,metadata,updated_at)
  values(v_candidate.id,'upsert','telegram_rotation',p_request_id::text,jsonb_build_object('operationId',v_operation_id),now())
  on conflict(product_id) do update set action='upsert',source=excluded.source,review_id=excluded.review_id,metadata=excluded.metadata,updated_at=now();

  insert into public.telegram_decision_events(
    decision,rotation_request_id,sender_id,chat_id,message_id,callback_query_id,operation_id,product_id,evidence
  ) values (
    'rotation_approve',p_request_id,p_sender_id,p_chat_id,p_message_id,p_callback_query_id,v_operation_id,v_candidate.id,v_human_evidence
  ) on conflict (callback_query_id) where callback_query_id is not null do nothing;

  return jsonb_build_object('ok',true,'requestId',p_request_id,'sourceProductId',v_source.id,'productId',v_candidate.id,'operationId',v_operation_id);
end;
$$;

create or replace function public.cerberus_telegram_rotation_decision(
  p_request_id uuid,
  p_decision text,
  p_sender_id text,
  p_chat_id text,
  p_message_id text,
  p_callback_query_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.product_rotation_requests%rowtype;
  v_next_status text;
begin
  if p_decision not in ('rotation_retry','rotation_cancel') then raise exception 'ROTATION_DECISION_INVALID'; end if;
  select * into v_request from public.product_rotation_requests where id=p_request_id for update;
  if not found then raise exception 'ROTATION_REQUEST_NOT_FOUND'; end if;
  if v_request.status in ('replaced','cancelled') then
    return jsonb_build_object('ok',true,'replayed',true,'requestId',p_request_id,'status',v_request.status);
  end if;

  if p_decision='rotation_cancel' then
    v_next_status := 'cancelled';
    update public.product_rotation_requests set status='cancelled',reason='CANCELLED_BY_USER',completed_at=now(),updated_at=now() where id=p_request_id;
  else
    if v_request.candidate_product_id is not null then
      update public.product_rotation_requests
      set status='searching',
          rejected_candidate_ids=array_append(rejected_candidate_ids,v_request.candidate_product_id),
          candidate_product_id=null,
          reason='RETRY_REQUESTED_BY_USER',updated_at=now()
      where id=p_request_id;
    else
      update public.product_rotation_requests set status='searching',reason='RETRY_REQUESTED_BY_USER',updated_at=now() where id=p_request_id;
    end if;
    v_next_status := 'searching';
  end if;

  insert into public.telegram_decision_events(
    decision,rotation_request_id,sender_id,chat_id,message_id,callback_query_id,evidence
  ) values (
    p_decision,p_request_id,p_sender_id,p_chat_id,p_message_id,p_callback_query_id,
    jsonb_build_object('origin','telegram','statusBefore',v_request.status,'statusAfter',v_next_status)
  ) on conflict (callback_query_id) where callback_query_id is not null do nothing;

  return jsonb_build_object('ok',true,'requestId',p_request_id,'status',v_next_status);
end;
$$;

revoke all on public.catalog_overlay_entries from anon, authenticated;
revoke all on public.telegram_decision_events from anon, authenticated;
revoke all on public.telegram_webhook_updates from anon, authenticated;

revoke all on function public.cerberus_telegram_register_update(bigint,text) from public, anon, authenticated;
revoke all on function public.cerberus_telegram_mark_update(bigint,text,text) from public, anon, authenticated;
revoke all on function public.cerberus_telegram_discard_review(text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.cerberus_telegram_publish_review(text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.cerberus_telegram_apply_rotation(uuid,text,text,text,text) from public, anon, authenticated;
revoke all on function public.cerberus_telegram_rotation_decision(uuid,text,text,text,text,text) from public, anon, authenticated;

grant execute on function public.cerberus_telegram_register_update(bigint,text) to service_role;
grant execute on function public.cerberus_telegram_mark_update(bigint,text,text) to service_role;
grant execute on function public.cerberus_telegram_discard_review(text,text,text,text,text) to service_role;
grant execute on function public.cerberus_telegram_publish_review(text,text,text,text,text) to service_role;
grant execute on function public.cerberus_telegram_apply_rotation(uuid,text,text,text,text) to service_role;
grant execute on function public.cerberus_telegram_rotation_decision(uuid,text,text,text,text,text) to service_role;

commit;
