-- Weekly production hardening: editorial proof, immutable content snapshots,
-- expiring promotions and two-step audience confirmation metadata.
--
-- Logical rollback: stop reading/writing the additive columns first, then drop
-- their constraints/indexes/columns in a new forward migration. The promotion
-- expiresAt backfill is intentionally not reversed because an explicit expiry
-- is safer than restoring an unbounded legacy offer.

begin;

alter table public.products
  add column if not exists image_editorial_status text not null default 'unreviewed',
  add column if not exists image_curation jsonb,
  add column if not exists image_reviewed_at timestamptz,
  add column if not exists image_review_model text,
  add column if not exists image_review_version text,
  add column if not exists image_review_fingerprint text,
  add column if not exists display_title_status text not null default 'unreviewed',
  add column if not exists display_title_reviewed_at timestamptz,
  add column if not exists display_title_review_model text,
  add column if not exists display_title_review_version text;

alter table public.products
  drop constraint if exists products_image_editorial_status_check,
  add constraint products_image_editorial_status_check
    check (image_editorial_status in ('clean', 'overlay_suspected', 'unreviewed', 'review_required')),
  drop constraint if exists products_image_curation_shape_check,
  add constraint products_image_curation_shape_check
    check (image_curation is null or jsonb_typeof(image_curation) = 'object'),
  drop constraint if exists products_image_review_fingerprint_check,
  add constraint products_image_review_fingerprint_check
    check (image_review_fingerprint is null or image_review_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  drop constraint if exists products_image_review_proof_check,
  add constraint products_image_review_proof_check
    check (
      image_editorial_status <> 'clean'
      or (
        image_curation is not null
        and image_curation ->> 'status' = 'ready'
        and nullif(btrim(image_curation ->> 'primaryImageUrl'), '') is not null
        and image_reviewed_at is not null
        and nullif(btrim(image_review_model), '') is not null
        and nullif(btrim(image_review_version), '') is not null
        and image_review_fingerprint is not null
      )
    ),
  drop constraint if exists products_display_title_status_check,
  add constraint products_display_title_status_check
    check (display_title_status in ('ready', 'unreviewed', 'review_required')),
  drop constraint if exists products_display_title_review_proof_check,
  add constraint products_display_title_review_proof_check
    check (
      display_title_status <> 'ready'
      or (
        nullif(btrim(display_title), '') is not null
        and display_title_reviewed_at is not null
        and nullif(btrim(display_title_review_model), '') is not null
        and nullif(btrim(display_title_review_version), '') is not null
      )
    );

comment on column public.products.image_curation is
  'Auditoria visual estruturada: URLs analisadas, decisões, confiança, motivos e imagem principal aprovada.';
comment on column public.products.image_review_fingerprint is
  'SHA-256 da URL principal aprovada; qualquer mudança de imagem principal invalida a revisão.';
comment on column public.products.display_title_status is
  'Gate editorial explícito do título semanal; ausência/falha permanece review_required.';

-- Ofertas legadas sem expiração recebem TTL conservador de 24 horas a partir
-- da confirmação original. O preço-base não é alterado.
update public.products
set oferta_promocional = jsonb_set(
  oferta_promocional,
  '{expiresAt}',
  to_jsonb(((oferta_promocional ->> 'confirmedAt')::numeric + 86400000)),
  true
)
where oferta_promocional is not null
  and jsonb_typeof(oferta_promocional) = 'object'
  and jsonb_typeof(oferta_promocional -> 'confirmedAt') = 'number'
  and not (oferta_promocional ? 'expiresAt');

alter table public.products
  drop constraint if exists products_oferta_promocional_shape_check,
  add constraint products_oferta_promocional_shape_check
  check (
    oferta_promocional is null
    or (
      jsonb_typeof(oferta_promocional) = 'object'
      and jsonb_typeof(oferta_promocional -> 'price') = 'number'
      and (oferta_promocional ->> 'price')::numeric > 0
      and oferta_promocional ->> 'condition' in ('pix', 'pix_with_coupon', 'coupon', 'other')
      and oferta_promocional ->> 'source' = 'admin_confirmed'
      and jsonb_typeof(oferta_promocional -> 'confirmedAt') = 'number'
      and (oferta_promocional ->> 'confirmedAt')::numeric > 0
      and jsonb_typeof(oferta_promocional -> 'expiresAt') = 'number'
      and (oferta_promocional ->> 'expiresAt')::numeric > (oferta_promocional ->> 'confirmedAt')::numeric
      and (
        not (oferta_promocional ? 'benefits')
        or jsonb_typeof(oferta_promocional -> 'benefits') = 'array'
      )
    )
  );

alter table public.email_campaigns
  add column if not exists editorial_snapshot jsonb,
  add column if not exists editorial_fingerprint text,
  add column if not exists editorial_composition_mode text,
  add column if not exists editorial_categories text[] not null default '{}'::text[],
  add column if not exists preview_expires_at timestamptz,
  add column if not exists approval_expires_at timestamptz,
  add column if not exists approval_audience_count integer,
  add column if not exists approval_audience_status text;

alter table public.email_campaigns
  drop constraint if exists email_campaigns_editorial_snapshot_shape_check,
  add constraint email_campaigns_editorial_snapshot_shape_check
    check (editorial_snapshot is null or jsonb_typeof(editorial_snapshot) = 'object'),
  drop constraint if exists email_campaigns_editorial_fingerprint_check,
  add constraint email_campaigns_editorial_fingerprint_check
    check (editorial_fingerprint is null or editorial_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  drop constraint if exists email_campaigns_editorial_composition_mode_check,
  add constraint email_campaigns_editorial_composition_mode_check
    check (editorial_composition_mode is null or editorial_composition_mode in ('thematic', 'diversified')),
  drop constraint if exists email_campaigns_approval_audience_count_check,
  add constraint email_campaigns_approval_audience_count_check
    check (approval_audience_count is null or approval_audience_count >= 0),
  drop constraint if exists email_campaigns_approval_audience_status_check,
  add constraint email_campaigns_approval_audience_status_check
    check (approval_audience_status is null or approval_audience_status in ('pending', 'ready', 'mismatch', 'unavailable'));

create index if not exists email_campaigns_weekly_sent_cutoff_idx
  on public.email_campaigns (sent_at desc)
  where campaign_type = 'collection'
    and status = 'sent'
    and sent_at is not null
    and edition_key like 'weekly:%';

commit;
