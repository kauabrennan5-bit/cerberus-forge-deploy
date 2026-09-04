begin;

alter function public.set_updated_at() set search_path = '';

create index if not exists idx_product_rotation_requests_candidate_product_id
  on public.product_rotation_requests(candidate_product_id);
create index if not exists idx_product_rotation_requests_replacement_product_id
  on public.product_rotation_requests(replacement_product_id);
create index if not exists idx_product_source_identities_reserved_run_id
  on public.product_source_identities(reserved_run_id);

create extension if not exists pg_cron;
create schema if not exists private;
revoke all on schema private from anon, authenticated;

create table if not exists private.telegram_pending_reviews_archive (
  id text primary key,
  chat_id text,
  sender_id text,
  first_name text,
  username text,
  created_at bigint,
  expires_at bigint,
  status text not null,
  data jsonb,
  inserted_at timestamptz,
  updated_at timestamptz,
  archived_at timestamptz not null default now(),
  archive_reason text not null default 'terminal_retention'
);

create or replace function private.archive_terminal_telegram_reviews(retention interval default interval '7 days')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  archived_count integer := 0;
begin
  with moved as (
    delete from public.telegram_pending_reviews
    where status in ('expired','published','rejected')
      and updated_at < now() - retention
    returning id, chat_id, sender_id, first_name, username, created_at, expires_at, status, data, inserted_at, updated_at
  ), archived as (
    insert into private.telegram_pending_reviews_archive (
      id, chat_id, sender_id, first_name, username, created_at, expires_at, status, data,
      inserted_at, updated_at, archived_at, archive_reason
    )
    select id, chat_id, sender_id, first_name, username, created_at, expires_at, status, data,
      inserted_at, updated_at, now(), 'terminal_retention'
    from moved
    on conflict (id) do update set
      chat_id = excluded.chat_id,
      sender_id = excluded.sender_id,
      first_name = excluded.first_name,
      username = excluded.username,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at,
      status = excluded.status,
      data = excluded.data,
      inserted_at = excluded.inserted_at,
      updated_at = excluded.updated_at,
      archived_at = excluded.archived_at,
      archive_reason = excluded.archive_reason
    returning 1
  )
  select count(*)::integer into archived_count from archived;
  return archived_count;
end;
$$;

revoke all on function private.archive_terminal_telegram_reviews(interval) from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'cerberus-telegram-review-archive') then
    perform cron.schedule(
      'cerberus-telegram-review-archive',
      '15 * * * *',
      $job$select private.archive_terminal_telegram_reviews(interval '7 days');$job$
    );
  end if;
end;
$$;

commit;
