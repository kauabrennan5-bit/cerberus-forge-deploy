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
  v_shop_id text;
  v_item_id text;
  v_source_url text;
  v_primary_image text;
  v_deficit_fallback boolean := false;
  v_human_manual_approval boolean := false;
begin
  if not (coalesce(new.ativo, true) = true and new.status = 'published') then return new; end if;
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

  select ppa.authorization_id, ppa.source, ppa.evidence
    into v_authorization_id, v_authorization_source, v_authorization_evidence
  from public.product_publication_authorizations ppa
  where ppa.product_id = new.id
    and ppa.consumed_at is null
    and ppa.expires_at > now()
    and coalesce((ppa.evidence ->> 'categoryMismatch')::boolean, true) = false
    and nullif(btrim(ppa.evidence ->> 'primaryImageUrl'), '') = v_primary_image
    and ((ppa.source = 'admin'
          and coalesce((ppa.evidence ->> 'humanManualApproval')::boolean, false) = true
          and nullif(btrim(ppa.evidence ->> 'sourceProductUrl'), '') is not null)
      or (ppa.source = 'product_rotation' and coalesce((ppa.evidence ->> 'manualEditorialOverride')::boolean, false) = true)
      or (ppa.source in ('autonomous_curator', 'recovery') and (coalesce((ppa.evidence ->> 'deficitFallback')::boolean, false) = true or coalesce((ppa.evidence ->> 'bestOfLotFallback')::boolean, false) = true))
      or (ppa.score >= ppa.threshold and ppa.maximum_catalog_similarity < 0.82 and coalesce((ppa.evidence ->> 'lifecycleApproved')::boolean, false) = true and coalesce((ppa.evidence ->> 'offBrand')::boolean, true) = false and upper(coalesce(ppa.evidence ->> 'reviewState', '')) not like '%REVIEW%'))
  order by ppa.created_at desc limit 1 for update;

  if v_authorization_id is null then raise exception 'PRODUCT_PUBLICATION_BLOCKED:AUTHORIZATION_MISSING'; end if;

  v_human_manual_approval := v_authorization_source = 'admin'
    and coalesce((v_authorization_evidence ->> 'humanManualApproval')::boolean, false) = true;
  v_deficit_fallback := v_authorization_source in ('autonomous_curator', 'recovery')
    and (coalesce((v_authorization_evidence ->> 'deficitFallback')::boolean, false) = true
      or coalesce((v_authorization_evidence ->> 'bestOfLotFallback')::boolean, false) = true);

  if not v_human_manual_approval then
    if new.image_curation is null
       or nullif(btrim(new.image_curation ->> 'primaryImageUrl'), '') is null
       or (new.image_curation ->> 'primaryImageUrl') !~* '^https://'
       or new.image_review_fingerprint is null then
      raise exception 'PRODUCT_PUBLICATION_BLOCKED:IMAGE_REVIEW_NOT_CLEAN';
    end if;
  end if;

  if v_human_manual_approval then
    select psi.shop_id, psi.item_id, psi.source_product_url
      into v_shop_id, v_item_id, v_source_url
    from public.product_source_identities psi
    where lower(psi.marketplace) = 'shopee'
      and (
        psi.product_id = new.id
        or (
          psi.product_id is null
          and psi.review_id is not null
          and psi.source_product_url = nullif(btrim(v_authorization_evidence ->> 'sourceProductUrl'), '')
        )
      )
    limit 1;
  else
    select psi.shop_id, psi.item_id, psi.source_product_url
      into v_shop_id, v_item_id, v_source_url
    from public.product_source_identities psi
    where psi.product_id = new.id and lower(psi.marketplace) = 'shopee'
    limit 1;
  end if;

  if nullif(btrim(v_shop_id), '') is null
     or nullif(btrim(v_item_id), '') is null
     or nullif(btrim(v_source_url), '') is null
     or v_source_url !~* '^https://([^/]+\.)?shopee\.com\.br/' then
    raise exception 'PRODUCT_PUBLICATION_BLOCKED:SHOPEE_IDENTITY_INVALID';
  end if;

  if not v_human_manual_approval and not v_deficit_fallback then
    if new.display_title_status <> 'reviewed' then raise exception 'PRODUCT_PUBLICATION_BLOCKED:DISPLAY_TITLE_NOT_REVIEWED'; end if;
    if new.image_editorial_status <> 'clean' or new.image_curation ->> 'status' <> 'ready' then raise exception 'PRODUCT_PUBLICATION_BLOCKED:IMAGE_REVIEW_NOT_CLEAN'; end if;
  end if;

  update public.product_publication_authorizations
  set consumed_at = now()
  where authorization_id = v_authorization_id and consumed_at is null;
  return new;
end;
$$;
revoke all on function public.enforce_product_publication_authorization() from public, anon, authenticated;
