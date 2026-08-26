-- PREPARED ONLY — NÃO APLICAR NESTA TASK.
-- Campanhas de e-mail Telegram → Brevo.
-- Não altera newsletter_subscribers, Q7, outbox existente ou qualquer dado.

begin;

create table public.email_campaigns (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references public.products(id) on delete restrict,
  subject text not null check (char_length(btrim(subject)) between 1 and 255),
  body_html text not null check (char_length(btrim(body_html)) > 0),
  body_text text not null check (char_length(btrim(body_text)) > 0),
  status text not null default 'draft' check (status in (
    'draft',
    'pending_approval',
    'approved',
    'test_sent',
    'sending',
    'sent',
    'failed',
    'cancelled'
  )),
  created_by_telegram_id text not null check (char_length(btrim(created_by_telegram_id)) > 0),
  approved_by_telegram_id text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  test_sent_at timestamptz,
  test_sent_by_telegram_id text,
  general_send_confirmed_at timestamptz,
  general_send_confirmed_by_telegram_id text,
  sent_at timestamptz,
  recipients_total integer not null default 0 check (recipients_total >= 0),
  recipients_success integer not null default 0 check (recipients_success >= 0),
  recipients_failed integer not null default 0 check (recipients_failed >= 0),
  recipients_skipped integer not null default 0 check (recipients_skipped >= 0),
  constraint email_campaigns_state_timestamps_check check (
    (status in ('draft', 'pending_approval')
      and approved_at is null
      and approved_by_telegram_id is null
      and test_sent_at is null
      and test_sent_by_telegram_id is null
      and general_send_confirmed_at is null
      and general_send_confirmed_by_telegram_id is null
      and sent_at is null)
    or (status = 'approved'
      and approved_at is not null
      and approved_by_telegram_id is not null
      and test_sent_at is null
      and test_sent_by_telegram_id is null
      and general_send_confirmed_at is null
      and general_send_confirmed_by_telegram_id is null
      and sent_at is null)
    or (status = 'test_sent'
      and approved_at is not null
      and approved_by_telegram_id is not null
      and test_sent_at is not null
      and test_sent_by_telegram_id is not null
      and ((general_send_confirmed_at is null and general_send_confirmed_by_telegram_id is null)
        or (general_send_confirmed_at is not null and general_send_confirmed_by_telegram_id is not null))
      and sent_at is null)
    or (status = 'sending'
      and approved_at is not null
      and approved_by_telegram_id is not null
      and test_sent_at is not null
      and test_sent_by_telegram_id is not null
      and general_send_confirmed_at is not null
      and general_send_confirmed_by_telegram_id is not null
      and sent_at is null)
    or (status = 'sent'
      and approved_at is not null
      and approved_by_telegram_id is not null
      and test_sent_at is not null
      and test_sent_by_telegram_id is not null
      and general_send_confirmed_at is not null
      and general_send_confirmed_by_telegram_id is not null
      and sent_at is not null)
    or (status = 'failed'
      and approved_at is not null
      and approved_by_telegram_id is not null
      and test_sent_at is not null
      and test_sent_by_telegram_id is not null
      and general_send_confirmed_at is not null
      and general_send_confirmed_by_telegram_id is not null
      and sent_at is null)
    or (status = 'cancelled' and sent_at is null)
  ),
  constraint email_campaigns_recipient_counts_check check (
    recipients_success + recipients_failed + recipients_skipped <= recipients_total
  )
);

create index email_campaigns_status_created_idx
  on public.email_campaigns (status, created_at desc);

create index email_campaigns_product_created_idx
  on public.email_campaigns (product_id, created_at desc);

alter table public.email_campaigns enable row level security;
revoke all on table public.email_campaigns from public;
revoke all on table public.email_campaigns from anon;
revoke all on table public.email_campaigns from authenticated;
grant all on table public.email_campaigns to service_role;

create table public.email_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.email_campaigns(id) on delete cascade,
  subscriber_email text not null,
  status text not null default 'pending' check (status in (
    'pending',
    'sent',
    'failed',
    'skipped_unsubscribed'
  )),
  provider_message_id text,
  error_detail text,
  sent_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  lease_token text,
  processing_started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_campaign_recipients_campaign_email_key unique (campaign_id, subscriber_email),
  constraint email_campaign_recipients_email_normalized_check check (
    subscriber_email = lower(btrim(subscriber_email))
  ),
  constraint email_campaign_recipients_email_format_check check (
    subscriber_email ~* '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]{2,}$'
  ),
  constraint email_campaign_recipients_state_check check (
    (status = 'sent' and sent_at is not null)
    or (status in ('pending', 'failed', 'skipped_unsubscribed') and sent_at is null)
  ),
  constraint email_campaign_recipients_attempts_lease_check check (
    (lease_until is null and lease_token is null)
    or (lease_until is not null and lease_token is not null and char_length(btrim(lease_token)) > 0)
  )
);

create index email_campaign_recipients_campaign_status_idx
  on public.email_campaign_recipients (campaign_id, status);

create index email_campaign_recipients_campaign_email_idx
  on public.email_campaign_recipients (campaign_id, subscriber_email);

create index email_campaign_recipients_claim_idx
  on public.email_campaign_recipients (status, next_attempt_at, lease_until)
  where status = 'pending';

alter table public.email_campaign_recipients enable row level security;
revoke all on table public.email_campaign_recipients from public;
revoke all on table public.email_campaign_recipients from anon;
revoke all on table public.email_campaign_recipients from authenticated;
grant all on table public.email_campaign_recipients to service_role;

create or replace function public.claim_email_campaign_recipient(
  p_campaign_id uuid,
  p_lease_token text,
  p_lease_ms integer default 60000
)
returns setof public.email_campaign_recipients
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $$
begin
  if p_campaign_id is null then
    raise exception 'EMAIL_CAMPAIGN_ID_REQUIRED';
  end if;
  if coalesce(btrim(p_lease_token), '') = '' then
    raise exception 'EMAIL_CAMPAIGN_RECIPIENT_LEASE_TOKEN_REQUIRED';
  end if;
  if p_lease_ms < 1000 or p_lease_ms > 600000 then
    raise exception 'EMAIL_CAMPAIGN_RECIPIENT_LEASE_INVALID';
  end if;

  return query
  with candidate as (
    select r.id
    from public.email_campaign_recipients as r
    where r.campaign_id = p_campaign_id
      and r.status = 'pending'
      and r.next_attempt_at <= now()
      and (r.lease_until is null or r.lease_until <= now())
    order by r.next_attempt_at asc, r.created_at asc
    for update skip locked
    limit 1
  )
  update public.email_campaign_recipients as r
  set attempt_count = r.attempt_count + 1,
      lease_until = now() + (p_lease_ms || ' milliseconds')::interval,
      lease_token = btrim(p_lease_token),
      processing_started_at = coalesce(r.processing_started_at, now()),
      updated_at = now()
  from candidate
  where r.id = candidate.id
  returning r.*;
end;
$$;

revoke all on function public.claim_email_campaign_recipient(uuid, text, integer) from public;
revoke all on function public.claim_email_campaign_recipient(uuid, text, integer) from anon;
revoke all on function public.claim_email_campaign_recipient(uuid, text, integer) from authenticated;
grant execute on function public.claim_email_campaign_recipient(uuid, text, integer) to service_role;

create or replace function public.reset_email_campaign_failed_recipients(p_campaign_id uuid)
returns integer
language sql
volatile
security invoker
set search_path = pg_catalog, public
as $$
  update public.email_campaign_recipients
  set status = 'pending',
      error_detail = null,
      sent_at = null,
      attempt_count = 0,
      next_attempt_at = now(),
      lease_until = null,
      lease_token = null,
      processing_started_at = null,
      updated_at = now()
  where campaign_id = p_campaign_id
    and status = 'failed';
  select count(*)::integer
  from public.email_campaign_recipients
  where campaign_id = p_campaign_id
    and status = 'pending';
$$;

revoke all on function public.reset_email_campaign_failed_recipients(uuid) from public;
revoke all on function public.reset_email_campaign_failed_recipients(uuid) from anon;
revoke all on function public.reset_email_campaign_failed_recipients(uuid) from authenticated;
grant execute on function public.reset_email_campaign_failed_recipients(uuid) to service_role;

commit;
