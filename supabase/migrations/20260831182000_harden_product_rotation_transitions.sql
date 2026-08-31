create or replace function public.enforce_product_rotation_transition()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'cancelled' and new.status <> 'cancelled' then
    raise exception 'ROTATION_TERMINAL_CANCELLED';
  end if;
  if old.status = 'replaced' and new.status <> 'replaced' then
    raise exception 'ROTATION_TERMINAL_REPLACED';
  end if;

  if old.status = 'searching' and new.status not in ('searching','candidate_ready','failed','cancelled') then
    raise exception 'ROTATION_INVALID_TRANSITION:%->%', old.status, new.status;
  elsif old.status = 'candidate_ready' and new.status not in ('candidate_ready','searching','applying','failed','cancelled') then
    raise exception 'ROTATION_INVALID_TRANSITION:%->%', old.status, new.status;
  elsif old.status = 'failed' and new.status not in ('failed','searching','candidate_ready','cancelled') then
    raise exception 'ROTATION_INVALID_TRANSITION:%->%', old.status, new.status;
  elsif old.status = 'applying' and new.status not in ('applying','candidate_ready','replaced','failed') then
    raise exception 'ROTATION_INVALID_TRANSITION:%->%', old.status, new.status;
  end if;

  if old.status in ('cancelled','replaced') then
    new.candidate_product_id := old.candidate_product_id;
    new.replacement_product_id := old.replacement_product_id;
    new.completed_at := old.completed_at;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_product_rotation_state_transition on public.product_rotation_requests;
create trigger trg_product_rotation_state_transition
before update on public.product_rotation_requests
for each row execute function public.enforce_product_rotation_transition();

comment on function public.enforce_product_rotation_transition() is
  'Prevents asynchronous Telegram rotation searches from reviving terminal cancelled/replaced requests or crossing unsafe state transitions.';
