-- TASK L — Fundacao local de consentimento explicito e supressao.
-- NAO APLICAR SEM AUTORIZACAO EXPLICITA DE PRODUCAO.
-- Mantem RLS/grants existentes e nao integra ESP.

begin;

alter table public.newsletter_subscribers
  add column if not exists status text not null default 'suppressed',
  add column if not exists marketing_consent boolean not null default false,
  add column if not exists consent_at timestamptz,
  add column if not exists consent_source text,
  add column if not exists consent_purpose text,
  add column if not exists consent_policy_version text,
  add column if not exists unsubscribe_at timestamptz,
  add column if not exists unsubscribe_source text,
  add column if not exists suppression_reason text,
  add column if not exists unsubscribe_token_hash text,
  add column if not exists unsubscribe_token_expires_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

update public.newsletter_subscribers
set status = 'suppressed',
    marketing_consent = false,
    consent_at = null,
    consent_source = null,
    consent_purpose = null,
    consent_policy_version = null,
    suppression_reason = 'legacy_without_structured_consent',
    updated_at = now();

alter table public.newsletter_subscribers
  drop constraint if exists newsletter_subscribers_status_check;

alter table public.newsletter_subscribers
  add constraint newsletter_subscribers_status_check
  check (status in ('subscribed', 'unsubscribed', 'suppressed'));

create unique index if not exists newsletter_subscribers_unsubscribe_token_hash_uidx
  on public.newsletter_subscribers (unsubscribe_token_hash)
  where unsubscribe_token_hash is not null;

create index if not exists newsletter_subscribers_status_idx
  on public.newsletter_subscribers (status);

comment on column public.newsletter_subscribers.marketing_consent is
  'Consentimento explicito para comunicacoes de marketing; nao inferir de created_at.';
comment on column public.newsletter_subscribers.suppression_reason is
  'Razao controlada pela qual o contato nao e elegivel para marketing.';
comment on column public.newsletter_subscribers.unsubscribe_token_hash is
  'Hash SHA-256 de token opaco; token em texto puro nunca e persistido.';

commit;
