begin;

create table if not exists public.edge_rate_limit_windows (
  scope text not null,
  key_hash text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (scope, key_hash)
);

alter table public.edge_rate_limit_windows enable row level security;
revoke all on public.edge_rate_limit_windows from anon, authenticated;

create or replace function public.cerberus_consume_edge_rate_limit(
  p_scope text,
  p_key_hash text,
  p_window_seconds integer,
  p_limit integer
) returns table(allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.edge_rate_limit_windows%rowtype;
begin
  if nullif(btrim(p_scope),'') is null
     or nullif(btrim(p_key_hash),'') is null
     or p_window_seconds < 1
     or p_window_seconds > 86400
     or p_limit < 1
     or p_limit > 10000 then
    raise exception 'EDGE_RATE_LIMIT_ARGUMENT_INVALID';
  end if;

  insert into public.edge_rate_limit_windows(scope,key_hash,window_started_at,request_count,updated_at)
  values(p_scope,p_key_hash,v_now,1,v_now)
  on conflict(scope,key_hash) do update set
    window_started_at = case
      when public.edge_rate_limit_windows.window_started_at + make_interval(secs => p_window_seconds) <= v_now then v_now
      else public.edge_rate_limit_windows.window_started_at
    end,
    request_count = case
      when public.edge_rate_limit_windows.window_started_at + make_interval(secs => p_window_seconds) <= v_now then 1
      else public.edge_rate_limit_windows.request_count + 1
    end,
    updated_at = v_now
  returning * into v_row;

  allowed := v_row.request_count <= p_limit;
  remaining := greatest(0,p_limit-v_row.request_count);
  reset_at := v_row.window_started_at + make_interval(secs => p_window_seconds);
  return next;
end;
$$;

revoke all on function public.cerberus_consume_edge_rate_limit(text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.cerberus_consume_edge_rate_limit(text,text,integer,integer) to service_role;

commit;
