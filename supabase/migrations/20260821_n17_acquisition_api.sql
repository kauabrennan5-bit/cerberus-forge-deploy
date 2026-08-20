-- N17 — Affiliate Acquisition API persistence extension
--
-- Migration additive and backward-compatible:
--   * all N17-specific columns are nullable;
--   * existing manual affiliate links remain valid;
--   * no catalog, candidate, evidence, assessment, publication, job or agent data
--     is created or modified by this migration.
--
-- N17 remains orchestration only. N8 remains the sole technical acquisition
-- authority; this schema only stores a confirmed N8 result.

begin;

alter table public.affiliate_links
  add column if not exists acquisition_ref text,
  add column if not exists authorization_ref text,
  add column if not exists assessment_id text,
  add column if not exists idempotency_key_n17 text,
  add column if not exists response_digest_n17 text,
  add column if not exists listing_id text,
  add column if not exists seller_id text,
  add column if not exists title_snapshot text,
  add column if not exists canonical_url text,
  add column if not exists method text;

-- The original v1 constraint accepted only admin:manual. Preserve that value
-- and add the explicit N17 API provenance without changing existing rows.
alter table public.affiliate_links
  drop constraint if exists affiliate_links_provenance_check;

alter table public.affiliate_links
  add constraint affiliate_links_provenance_check
  check (provenance in ('admin:manual', 'n17:api'));

-- method is nullable so legacy manual rows remain untouched. N17 API rows use
-- API; MANUAL is retained as a compatible catalog value for future/manual data.
alter table public.affiliate_links
  add constraint affiliate_links_method_check
  check (method is null or method in ('MANUAL', 'API'));

-- Unique only for populated N17 keys: multiple legacy rows with NULL remain
-- unaffected, while replay/concurrency can be resolved by the N17 key.
create unique index if not exists ux_affiliate_links_idempotency_key_n17
  on public.affiliate_links (idempotency_key_n17)
  where idempotency_key_n17 is not null;

create index if not exists idx_affiliate_links_listing_n17
  on public.affiliate_links (listing_id)
  where listing_id is not null;

comment on column public.affiliate_links.acquisition_ref is
  'N17/N8 acquisition reference; opaque external-operation reference, never a secret.';
comment on column public.affiliate_links.authorization_ref is
  'N15 authorization reference consumed by N17; not an authorization by itself.';
comment on column public.affiliate_links.assessment_id is
  'Assessment reference associated with the N15 authorization.';
comment on column public.affiliate_links.idempotency_key_n17 is
  'Deterministic N17 acquisition idempotency key; unique when populated.';
comment on column public.affiliate_links.response_digest_n17 is
  'Digest of permitted acquisition metadata only; never raw response or credentials.';
comment on column public.affiliate_links.listing_id is
  'Confirmed external listing identity returned by N8.';
comment on column public.affiliate_links.seller_id is
  'Confirmed external seller identity returned by N8.';
comment on column public.affiliate_links.title_snapshot is
  'Observed title snapshot returned by N8; not a canonical product fact.';
comment on column public.affiliate_links.canonical_url is
  'Confirmed marketplace canonical URL returned by N8.';
comment on column public.affiliate_links.method is
  'Acquisition method; nullable for legacy rows, API for N17 official-provider acquisitions.';

commit;
