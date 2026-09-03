-- Local rebuild reconciliation for LIVE auxiliary objects whose original historical
-- migration SQL is no longer present. This file stays outside supabase/migrations
-- and is materialized by Supabase Rebuild Gate only after the exact LIVE ledger.

create index if not exists idx_candidate_evidence_candidate on public.candidate_evidence(candidate_id);
create index if not exists idx_candidate_evidence_field_hash on public.candidate_evidence(field_hash) where field_hash is not null;
create index if not exists idx_candidate_evidence_field_state on public.candidate_evidence(field_state);
create index if not exists idx_candidate_evidence_observed_at on public.candidate_evidence(observed_at desc);
create index if not exists idx_candidate_evidence_research on public.candidate_evidence(research_id);

create index if not exists job_queue_claim_idx on public.job_queue(status, next_run_at);
create index if not exists job_queue_correlation_idx on public.job_queue(correlation_id);
create index if not exists job_queue_idempotency_idx on public.job_queue(idempotency_key);
create index if not exists job_queue_lease_idx on public.job_queue(status, lease) where lease is not null;
create index if not exists job_queue_type_status_idx on public.job_queue(type, status);

create index if not exists policy_evaluations_agent_idx on public.policy_evaluations(agent_id, agent_version, evaluated_at desc);
create index if not exists policy_evaluations_causation_idx on public.policy_evaluations(causation_id) where causation_id is not null;
create index if not exists policy_evaluations_correlation_idx on public.policy_evaluations(correlation_id) where correlation_id is not null;
create index if not exists policy_evaluations_decision_idx on public.policy_evaluations(decision, evaluated_at desc);
create index if not exists policy_evaluations_evaluated_at_idx on public.policy_evaluations(evaluated_at desc);
create unique index if not exists policy_evaluations_request_fingerprint_idx on public.policy_evaluations(request_fingerprint);

create index if not exists product_price_observed_correlation_idx on public.product_price_observed(correlation_id, observed_at desc);
create index if not exists product_price_observed_product_idx on public.product_price_observed(product_id, observed_at desc);
create index if not exists product_price_observed_source_idx on public.product_price_observed(source_name, observed_at desc);
create index if not exists product_availability_observed_correlation_idx on public.product_availability_observed(correlation_id, observed_at desc);
create index if not exists product_availability_observed_product_idx on public.product_availability_observed(product_id, observed_at desc);
create index if not exists product_availability_observed_source_idx on public.product_availability_observed(source_name, observed_at desc);
create index if not exists product_source_observed_correlation_idx on public.product_source_observed(correlation_id, observed_at desc);
create index if not exists product_source_observed_product_idx on public.product_source_observed(product_id, observed_at desc);
create index if not exists product_source_observed_source_idx on public.product_source_observed(source_name, observed_at desc);
create index if not exists product_image_observed_correlation_idx on public.product_image_observed(correlation_id, observed_at desc);
create index if not exists product_image_observed_product_idx on public.product_image_observed(product_id, observed_at desc);
create index if not exists product_image_observed_source_idx on public.product_image_observed(source_name, observed_at desc);

create index if not exists newsletter_outbox_claim_idx on public.newsletter_outbox(status, next_attempt_at);
create index if not exists newsletter_outbox_lease_idx on public.newsletter_outbox(status, lease_until) where lease_until is not null;
create index if not exists newsletter_outbox_subscriber_idx on public.newsletter_outbox(subscriber_email, created_at desc);
create index if not exists newsletter_subscribers_status_idx on public.newsletter_subscribers(status);
create unique index if not exists newsletter_subscribers_unsubscribe_token_hash_uidx on public.newsletter_subscribers(unsubscribe_token_hash) where unsubscribe_token_hash is not null;

create or replace function public.claim_email_campaign_recipient(
  p_campaign_id uuid,
  p_lease_token text,
  p_lease_ms integer default 60000
)
returns setof public.email_campaign_recipients
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
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
$function$;

-- This trigger exists in LIVE but its original creation SQL predates the surviving
-- migration artifacts. Recreate it only in the fresh local rebuild.
drop trigger if exists job_queue_set_updated_at on public.job_queue;
create trigger job_queue_set_updated_at
before update on public.job_queue
for each row execute function public.set_updated_at();
