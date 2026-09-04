-- Restored to the exact version recorded in LIVE supabase_migrations.
-- Operator incidents must be explicitly recoverable after dependencies return healthy.

alter table public.operational_incidents
  add column if not exists recovered_at timestamptz null,
  add column if not exists duration_ms bigint null check (duration_ms is null or duration_ms >= 0),
  add column if not exists recovery_reason text null,
  add column if not exists health_evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(health_evidence) = 'object');

alter table public.operational_incidents
  drop constraint if exists operational_incidents_status_check;

alter table public.operational_incidents
  add constraint operational_incidents_status_check
  check (status = any (array[
    'OPEN'::text,
    'ACKNOWLEDGED'::text,
    'INVESTIGATING'::text,
    'AUTO_FIXING'::text,
    'REQUIRES_APPROVAL'::text,
    'ESCALATED'::text,
    'RECOVERING'::text,
    'RESOLVED'::text,
    'BLOCKED'::text
  ]));

create index if not exists operational_incidents_active_component_idx
  on public.operational_incidents(status, updated_at desc)
  where status in ('OPEN','ACKNOWLEDGED','INVESTIGATING','AUTO_FIXING','REQUIRES_APPROVAL','ESCALATED','RECOVERING','BLOCKED');

comment on column public.operational_incidents.recovered_at is
  'Timestamp when a fresh health observation proved that the affected dependency recovered.';
comment on column public.operational_incidents.duration_ms is
  'Measured incident duration from created_at to recovered_at.';
comment on column public.operational_incidents.recovery_reason is
  'Operator recovery reason associated with the health evidence.';
comment on column public.operational_incidents.health_evidence is
  'Sanitized independent component-health evidence used to resolve the incident.';
