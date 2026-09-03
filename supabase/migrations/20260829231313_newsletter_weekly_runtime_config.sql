create table if not exists public.newsletter_weekly_runtime_config (
  id text primary key,
  weekly_enabled boolean not null default false,
  brevo_list_id bigint,
  contact_sync_verified_at timestamptz,
  last_sync_at timestamptz,
  last_sync_status text not null default 'never',
  eligible_subscribers_count integer not null default 0,
  brevo_members_count integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint newsletter_weekly_runtime_config_singleton check (id = 'production'),
  constraint newsletter_weekly_runtime_config_list_id check (brevo_list_id is null or brevo_list_id > 0),
  constraint newsletter_weekly_runtime_config_sync_status check (last_sync_status in ('never', 'ready', 'failed')),
  constraint newsletter_weekly_runtime_config_eligible_count check (eligible_subscribers_count >= 0),
  constraint newsletter_weekly_runtime_config_brevo_count check (brevo_members_count >= 0)
);

insert into public.newsletter_weekly_runtime_config (id)
values ('production')
on conflict (id) do nothing;

alter table public.newsletter_weekly_runtime_config enable row level security;
revoke all on table public.newsletter_weekly_runtime_config from anon, authenticated;
grant all on table public.newsletter_weekly_runtime_config to service_role;

comment on table public.newsletter_weekly_runtime_config is
  'Fail-closed non-secret runtime state for the automated weekly Brevo marketing audience.';
