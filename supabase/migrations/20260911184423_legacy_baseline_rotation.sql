begin;
create table if not exists public.catalog_legacy_baseline (
  product_id text primary key,
  source_sha text not null,
  captured_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object')
);
alter table public.catalog_legacy_baseline enable row level security;
revoke all on public.catalog_legacy_baseline from anon, authenticated;
insert into public.catalog_legacy_baseline(product_id,source_sha,metadata)
select id,'949fef27ace775f53b98901db616a759ce4cc025',jsonb_build_object('provenance','cloudflare-versioned-snapshot','humanApprovalBackfill',false)
from public.products
where status='published' and ativo=false and created_by is null and human_editorial_review_id is null and human_editorial_authorization_id is null
on conflict(product_id) do nothing;
create or replace function public.cerberus_telegram_apply_rotation(
  p_request_id uuid,p_sender_id text,p_chat_id text,p_message_id text,p_callback_query_id text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, extensions as $$
declare
  v_request public.product_rotation_requests%rowtype;
  v_source public.products%rowtype;
  v_candidate public.products%rowtype;
  v_source_is_legacy_baseline boolean := false;
  v_primary_image text; v_fingerprint text; v_shop_id text; v_item_id text; v_source_url text;
  v_operation_id text; v_authorization_id uuid; v_approved_at timestamptz; v_human_evidence jsonb;
begin
  select * into v_request from public.product_rotation_requests where id=p_request_id for update;
  if not found then raise exception 'ROTATION_REQUEST_NOT_FOUND'; end if;
  if v_request.status='replaced' then return jsonb_build_object('ok',true,'replayed',true,'requestId',p_request_id,'productId',v_request.replacement_product_id); end if;
  if v_request.status<>'candidate_ready' or v_request.candidate_product_id is null then raise exception 'ROTATION_NOT_READY:%',v_request.status; end if;
  select * into v_source from public.products where id=v_request.source_product_id for update;
  select * into v_candidate from public.products where id=v_request.candidate_product_id for update;
  if v_source.id is null or v_candidate.id is null then raise exception 'ROTATION_PRODUCTS_MISSING'; end if;
  select exists(select 1 from public.catalog_legacy_baseline where product_id=v_source.id) into v_source_is_legacy_baseline;
  if v_source.status<>'published' or (v_source.ativo is not true and v_source_is_legacy_baseline is not true) then raise exception 'ROTATION_SOURCE_NOT_PUBLIC'; end if;
  if v_candidate.ativo is true and v_candidate.status='published' then raise exception 'ROTATION_CANDIDATE_ALREADY_PUBLIC'; end if;
  v_primary_image := coalesce(nullif(btrim(v_candidate.image_curation->>'primaryImageUrl'),''),nullif(btrim(v_candidate.imagens->>0),''));
  if v_primary_image is null or v_primary_image !~* '^https://' then raise exception 'ROTATION_PRIMARY_IMAGE_INVALID'; end if;
  if v_candidate.link is null or v_candidate.link !~* '^https://([^/]+\.)?shopee\.com\.br/' then raise exception 'ROTATION_AFFILIATE_LINK_INVALID'; end if;
  select shop_id,item_id,source_product_url into v_shop_id,v_item_id,v_source_url from public.product_source_identities where product_id=v_candidate.id and lower(marketplace)='shopee' limit 1 for update;
  if v_shop_id is null or v_item_id is null or v_source_url is null then raise exception 'ROTATION_SHOPEE_IDENTITY_INVALID'; end if;
  v_fingerprint := 'sha256:' || encode(digest(v_primary_image,'sha256'),'hex');
  v_operation_id := 'EDGE-ROT-' || replace(gen_random_uuid()::text,'-',''); v_authorization_id := gen_random_uuid(); v_approved_at := clock_timestamp();
  v_human_evidence := jsonb_build_object('kind','product_rotation_telegram_callback','origin','telegram','reviewId',p_request_id::text,'operationId',v_operation_id,'approvedAt',v_approved_at,'approverUserId',p_sender_id,'chatId',p_chat_id,'messageId',p_message_id,'callbackQueryId',p_callback_query_id,'candidateProductId',v_candidate.id,'shopId',v_shop_id,'itemId',v_item_id,'sourceProductUrl',v_source_url,'primaryImageUrl',v_primary_image,'primaryImageFingerprint',v_fingerprint,'sourceWasLegacyBaseline',v_source_is_legacy_baseline);
  update public.product_rotation_requests set status='applying',metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('human_approval',v_human_evidence),updated_at=now() where id=p_request_id;
  update public.products set created_by='telegram_rotation_candidate' where id=v_candidate.id and ativo is not true;
  insert into public.product_publication_authorizations(authorization_id,product_id,source,gate_version,score,threshold,maximum_catalog_similarity,evidence,expires_at,review_id,approved_at,approval_origin,shop_id,item_id,source_product_url,primary_image_url,image_fingerprint,operation_id,human_approval_evidence)
  values(v_authorization_id,v_candidate.id,'product_rotation','serverless-rotation-human-v1',100,1,0,jsonb_build_object('humanManualApproval',true,'manualEditorialOverride',true,'categoryMismatch',false,'primaryImageUrl',v_primary_image),now()+interval '10 minutes',p_request_id::text,v_approved_at,'telegram',v_shop_id,v_item_id,v_source_url,v_primary_image,v_fingerprint,v_operation_id,v_human_evidence);
  update public.products set ativo=true,status='published' where id=v_candidate.id;
  update public.products set ativo=false,status='archived' where id=v_source.id;
  update public.product_rotation_requests set status='replaced',replacement_product_id=v_candidate.id,reason='ROTATED_BY_USER',completed_at=now(),updated_at=now() where id=p_request_id;
  insert into public.catalog_overlay_entries(product_id,action,source,review_id,metadata,updated_at) values(v_source.id,'hide','telegram_rotation',p_request_id::text,jsonb_build_object('operationId',v_operation_id,'legacyBaseline',v_source_is_legacy_baseline),now()) on conflict(product_id) do update set action='hide',source=excluded.source,review_id=excluded.review_id,metadata=excluded.metadata,updated_at=now();
  insert into public.catalog_overlay_entries(product_id,action,source,review_id,metadata,updated_at) values(v_candidate.id,'upsert','telegram_rotation',p_request_id::text,jsonb_build_object('operationId',v_operation_id),now()) on conflict(product_id) do update set action='upsert',source=excluded.source,review_id=excluded.review_id,metadata=excluded.metadata,updated_at=now();
  insert into public.telegram_decision_events(decision,rotation_request_id,sender_id,chat_id,message_id,callback_query_id,operation_id,product_id,evidence) values('rotation_approve',p_request_id,p_sender_id,p_chat_id,p_message_id,p_callback_query_id,v_operation_id,v_candidate.id,v_human_evidence) on conflict (callback_query_id) where callback_query_id is not null do nothing;
  return jsonb_build_object('ok',true,'requestId',p_request_id,'sourceProductId',v_source.id,'productId',v_candidate.id,'operationId',v_operation_id,'sourceWasLegacyBaseline',v_source_is_legacy_baseline);
end;
$$;
revoke all on function public.cerberus_telegram_apply_rotation(uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.cerberus_telegram_apply_rotation(uuid,text,text,text,text) to service_role;
commit;
