begin;

alter table public.email_campaigns
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text;

alter table public.email_campaigns
  drop constraint if exists email_campaigns_archive_metadata_check;

alter table public.email_campaigns
  add constraint email_campaigns_archive_metadata_check check (
    (archived_at is null and archive_reason is null)
    or (archived_at is not null and archive_reason = 'test_retention_expired')
  );

create index if not exists email_campaigns_test_retention_idx
  on public.email_campaigns (status, campaign_type, test_sent_at, archived_at);

create or replace function public.cleanup_expired_newsletter_test_campaigns(
  p_archive_after_days integer default 7,
  p_delete_after_days integer default 30,
  p_batch_size integer default 50
)
returns table (
  archived_count integer,
  deleted_count integer,
  skipped_recipient_count integer
)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_archived integer := 0;
  v_deleted integer := 0;
  v_skipped integer := 0;
begin
  if p_archive_after_days < 1 or p_archive_after_days > 365 then
    raise exception 'NEWSLETTER_RETENTION_ARCHIVE_DAYS_INVALID';
  end if;
  if p_delete_after_days < 30 or p_delete_after_days > 3650 then
    raise exception 'NEWSLETTER_RETENTION_DELETE_DAYS_INVALID';
  end if;
  if p_batch_size < 1 or p_batch_size > 50 then
    raise exception 'NEWSLETTER_RETENTION_BATCH_SIZE_INVALID';
  end if;

  with candidates as (
    select c.id
    from public.email_campaigns as c
    where c.campaign_type = 'product'
      and c.status = 'test_sent'
      and c.test_sent_at is not null
      and c.test_sent_at <= now() - make_interval(days => p_archive_after_days)
      and c.archived_at is null
      and not exists (
        select 1
        from public.email_campaign_recipients as r
        where r.campaign_id = c.id
      )
    order by c.test_sent_at asc, c.created_at asc, c.id asc
    for update skip locked
    limit p_batch_size
  )
  update public.email_campaigns as c
  set status = 'cancelled',
      archived_at = now(),
      archive_reason = 'test_retention_expired'
  from candidates
  where c.id = candidates.id;

  get diagnostics v_archived = row_count;

  with candidates as (
    select c.id
    from public.email_campaigns as c
    where c.campaign_type = 'product'
      and c.status = 'cancelled'
      and c.archived_at is not null
      and c.archive_reason = 'test_retention_expired'
      and c.archived_at <= now() - make_interval(days => p_delete_after_days)
      and not exists (
        select 1
        from public.email_campaign_recipients as r
        where r.campaign_id = c.id
      )
    order by c.archived_at asc, c.id asc
    for update skip locked
    limit p_batch_size
  ), deleted as (
    delete from public.email_campaigns as c
    using candidates
    where c.id = candidates.id
    returning c.id
  )
  select count(*)::integer into v_deleted from deleted;

  select count(*)::integer into v_skipped
  from public.email_campaigns as c
  where c.campaign_type = 'product'
    and c.status = 'test_sent'
    and c.test_sent_at is not null
    and c.test_sent_at <= now() - make_interval(days => p_archive_after_days)
    and exists (
      select 1
      from public.email_campaign_recipients as r
      where r.campaign_id = c.id
    );

  return query select v_archived, v_deleted, v_skipped;
end;
$$;

revoke all on function public.cleanup_expired_newsletter_test_campaigns(integer, integer, integer) from public;
revoke all on function public.cleanup_expired_newsletter_test_campaigns(integer, integer, integer) from anon;
revoke all on function public.cleanup_expired_newsletter_test_campaigns(integer, integer, integer) from authenticated;
grant execute on function public.cleanup_expired_newsletter_test_campaigns(integer, integer, integer) to service_role;

commit;
