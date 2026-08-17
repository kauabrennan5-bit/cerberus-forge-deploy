-- Cerberus Finds Archive — Bloco N9 — Orquestração Comercial + Decision Gate
-- Migration estritamente aditiva: CRIA as tabelas public.commercial_cycles
-- e public.commercial_decisions.
-- NÃO altera, remove ou recria nenhuma tabela, coluna, índice ou policy existente.
-- NÃO altera public.products, public.candidates, public.candidate_evidence,
-- public.research (observações), public.candidate_assessments,
-- public.affiliate_providers, public.affiliate_links, public.job_queue,
-- estruturas de agentes nem scheduler.
-- Padrão: RLS ON, zero policies públicas, CHECKs fechados (catálogos),
-- idempotência (PKs determinísticas), auditável.
--
-- Fronteiras de governança:
--   CYCLE != PRODUCT FACT        (um ciclo nunca promove candidato nem
--   produto; NÃO existe FK para public.products)
--   DECISION != ACTION           (gravar uma decisão NÃO executa nada;
--   publicar segue exclusivamente o executor N5: DECISION + Policy
--   Engine + ApprovalStore)
--   ORQUESTRADOR != BLOCOS       (o N9 somente lê os contratos dos
--   Blocos N2–N8; nunca duplica filtro, resolver, aquisição,
--   executor ou política)
--   SEM PROVENIÊNCIA -> SEM AUTORIDADE (status e catálogos fechados;
--   valores derivados/inventados são rejeitados)
--   NUNCA armazenar credenciais, tokens, secrets ou payloads sensíveis
--   nestas tabelas (logs/registros usam somente IDs, códigos e estados)
-- ============================================================
-- Tabela 1: Commercial Cycles (máquina de estados S1–S8)
-- ============================================================
create table if not exists public.commercial_cycles (
  cycle_id text primary key
    check (char_length(cycle_id) between 8 and 128),
  -- Estado explícito da máquina de estados S1–S8 + decisão + execução.
  -- Transições: somente via registro de etapa (commercial_cycle_steps) —
  -- não existe coluna de status mutável livre; o estado canônico é a
  -- ÚLTIMA etapa registrada.
  status text not null
    check (status in (
      'OPEN',
      'S1_DISCOVERY',
      'S2_CANDIDATE',
      'S3_RESEARCH',
      'S4_ASSESSMENT',
      'S5_ACQUISITION',
      'S6_RESOLUTION',
      'S7_DECISION',
      'S8_PUBLICATION',
      'DECISION_ALLOWED',
      'DECISION_BLOCKED',
      'EXECUTED',
      'EXECUTION_FAILED',
      'FAILED',
      'CLOSED'
    )),
  -- Origem do ciclo: URL direta (admin/Telegram) de um listing.
  source_type text not null
    check (source_type in ('URL', 'QUERY')),
  marketplace text not null
    check (marketplace in ('mercadolivre', 'shopee')),
  source_url text not null default ''
    check (char_length(source_url) <= 2048),
  -- Vínculo rastreável ao candidate do N1 (criado/registado na etapa S1/S2).
  -- Sem FK (a referência é auditável, não relacional: o candidate vive no
  -- N1 e o ciclo apenas o cita — fronteira CANDIDATE != FACT CANÔNICO).
  candidate_id text,
  -- Vínculos rastreáveis aos estágios do funil comercial:
  research_id text,
  assessment_id text,
  acquisition_ref text,
  -- Nível de identidade confirmado pela aquisição (N8) — o gate S7 bloqueia
  -- publicação com PRODUCT_IDENTITY_UNCERTAIN (fail-closed).
  identity_confidence text,
  affiliate_link_id text,
  resolution_status text,
  decision_id text,
  execution_id text,
  -- Produto canônico resultante (CIDADO PELO N5, nunca por este módulo).
  product_id text,
  -- Digest determinístico da cadeia (candidate_id + source_url) que torna o
  -- ciclo reexecutável sem duplicar registros (idempotência por chave).
  idempotency_key text not null
    check (char_length(idempotency_key) between 16 and 128),
  constraint_version text not null default 'n9-cycle-v1',
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  created_by text not null default 'operator-admin'
    check (char_length(created_by) between 2 and 120)
);

-- ============================================================
-- Tabela 2: Commercial Decisions (documento versionado do gate v1)
-- ============================================================
create table if not exists public.commercial_decisions (
  decision_id text primary key
    check (char_length(decision_id) between 8 and 128),
  cycle_id text not null references public.commercial_cycles (cycle_id) on delete restrict,
  candidate_id text not null,
  -- Documento de decisão versionado. Sem score novo; as regras nomeadas
  -- combinam estados já existentes dos Blocos N2–N8.
  decision text not null
    check (decision in ('DECISION_ALLOWED', 'DECISION_BLOCKED')),
  decision_version text not null default 'commercial_decision_v1',
  -- Regras nomeadas que bloquearam (se blocked) / que passaram (se allowed).
  blocking_rules text[] not null default '{}',
  passed_rules text[] not null default '{}',
  -- Entrada consolidada do gate (referências + estados, nunca valores brutos):
  assessment_id text,
  classification text,
  recommendation text,
  priority text,
  unknowns_count integer not null default 0 check (unknowns_count >= 0),
  contradictions_count integer not null default 0 check (contradictions_count >= 0),
  collection_failed boolean not null default false,
  identity_confidence text,
  resolution_status text,
  price_state text,
  affiliate_state text,
  require_affiliate_link boolean not null default false,
  -- Rationale explicável: o que permitiu, o que bloqueou, quais evidências
  -- foram usadas, quais UNKNOWN permaneceram, qual regra determinou.
  rationale text not null default ''
    check (char_length(rationale) <= 6000),
  -- Digest determinístico do input consolidado (replay idêntico = mesmo
  -- digest; usado pela idempotência da decisão).
  input_digest text not null
    check (char_length(input_digest) between 16 and 128),
  created_at timestamp with time zone not null default now(),
  created_by text not null default 'operator-admin'
    check (char_length(created_by) between 2 and 120)
);

-- ============================================================
-- Tabela 3: Commercial Cycle Steps (registro auditável de cada etapa)
-- ============================================================
-- Cada transição S1→…→S8 é uma LINHA nesta tabela: estado explícito,
-- resultado, rationale, código de bloqueio (quando houver) e referência
-- de evidência. Falhas intermediárias deixam o ciclo em estado
-- recuperável (a etapa é registrada como FAILED/RECOVERABLE).
create table if not exists public.commercial_cycle_steps (
  step_id text primary key
    check (char_length(step_id) between 8 and 128),
  cycle_id text not null references public.commercial_cycles (cycle_id) on delete restrict,
  stage text not null
    check (stage in (
      'DISCOVERY', 'CANDIDATE', 'RESEARCH', 'ASSESSMENT',
      'ACQUISITION', 'RESOLUTION', 'DECISION', 'PUBLICATION'
    )),
  result text not null default 'OK'
    check (char_length(result) <= 120),
  blocking_code text,
  rationale text not null default ''
    check (char_length(rationale) <= 6000),
  evidence_ref text not null default ''
    check (char_length(evidence_ref) <= 2048),
  -- Idempotência por etapa: mesma etapa + mesma entrada = mesma linha
  -- (replay não duplica).
  idempotency_key text not null
    check (char_length(idempotency_key) between 16 and 128),
  created_at timestamp with time zone not null default now(),
  unique (cycle_id, stage, idempotency_key)
);

-- ============================================================
-- Índices (sem FK indevida para products; referências textuais auditáveis)
-- ============================================================
create index if not exists idx_commercial_cycles_candidate on public.commercial_cycles (candidate_id) where candidate_id is not null;
create index if not exists idx_commercial_cycles_status on public.commercial_cycles (status);
create index if not exists idx_commercial_decisions_cycle on public.commercial_decisions (cycle_id);
create index if not exists idx_commercial_cycle_steps_cycle on public.commercial_cycle_steps (cycle_id);

-- ============================================================
-- Row Level Security: ativo; SEM políticas públicas
-- (somente service role / backend, igual aos Blocos N1–N8)
-- ============================================================
alter table public.commercial_cycles enable row level security;
alter table public.commercial_decisions enable row level security;
alter table public.commercial_cycle_steps enable row level security;

-- Garantir que nenhuma policy pública exista (idempotente).
do $$
declare
  _pol record;
begin
  for _pol in (
    select policyname from pg_policies
    where tablename = 'commercial_cycles' and schemaname = 'public'
  ) loop
    execute format('drop policy if exists %I on public.commercial_cycles', _pol.policyname);
  end loop;
  for _pol in (
    select policyname from pg_policies
    where tablename = 'commercial_decisions' and schemaname = 'public'
  ) loop
    execute format('drop policy if exists %I on public.commercial_decisions', _pol.policyname);
  end loop;
  for _pol in (
    select policyname from pg_policies
    where tablename = 'commercial_cycle_steps' and schemaname = 'public'
  ) loop
    execute format('drop policy if exists %I on public.commercial_cycle_steps', _pol.policyname);
  end loop;
end $$;
