-- Cerberus Bloco 7.5: persistência mínima do estado crítico do Operator.
-- Aplicar no projeto Supabase canônico após revisão administrativa.
-- Não contém dados, tokens, IPs, user agents ou histórico de incidentes.

create table if not exists public.operator_state (
  state_key text primary key,
  action_id text not null,
  incident_id text,
  circuit_state text not null default 'CLOSED' check (circuit_state in ('CLOSED', 'OPEN')),
  failure_count integer not null default 0 check (failure_count >= 0),
  retry_count integer not null default 0 check (retry_count >= 0),
  last_execution_at timestamptz,
  cooldown_until timestamptz,
  circuit_open_until timestamptz,
  last_transition_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists operator_state_action_id_idx on public.operator_state(action_id);
create index if not exists operator_state_circuit_open_idx on public.operator_state(circuit_open_until)
  where circuit_state = 'OPEN';

alter table public.operator_state enable row level security;

-- O backend usa a service role. Nenhuma leitura ou escrita pública é permitida.
-- Não criar policy anon/authenticated para esta tabela.

comment on table public.operator_state is 'Estado crítico mínimo do Cerberus Operator; acesso exclusivo pelo backend privilegiado.';
