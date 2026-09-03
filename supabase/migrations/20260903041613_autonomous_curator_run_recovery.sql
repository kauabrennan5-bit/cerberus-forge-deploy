-- Restored to the exact version recorded in LIVE supabase_migrations.
-- Explicit, idempotent recovery metadata for abandoned Autonomous Curator runs.

alter table public.autonomous_curator_runs
  add column if not exists interrupted_at timestamptz null,
  add column if not exists recovered_at timestamptz null,
  add column if not exists recovery_reason text null,
  add column if not exists previous_cycle_id text null;

alter table public.autonomous_curator_runs
  drop constraint if exists autonomous_curator_runs_status_check;

alter table public.autonomous_curator_runs
  add constraint autonomous_curator_runs_status_check
  check (status = any (array[
    'running'::text,
    'completed'::text,
    'partial'::text,
    'failed'::text,
    'dry_run'::text,
    'interrupted'::text,
    'recovered'::text
  ]));

create index if not exists autonomous_curator_runs_stale_running_idx
  on public.autonomous_curator_runs(started_at)
  where status = 'running' and completed_at is null;

comment on column public.autonomous_curator_runs.interrupted_at is
  'Timestamp when boot recovery determined that an unfinished execution was abandoned.';
comment on column public.autonomous_curator_runs.recovered_at is
  'Timestamp when the abandoned execution was closed idempotently by boot recovery.';
comment on column public.autonomous_curator_runs.recovery_reason is
  'Sanitized reason explaining why an abandoned run was closed rather than replayed.';
comment on column public.autonomous_curator_runs.previous_cycle_id is
  'Cycle identifier that was active when the abandoned run was recovered, if known.';
