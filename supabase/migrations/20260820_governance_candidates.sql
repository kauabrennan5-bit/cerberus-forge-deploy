-- ============================================================================
-- Bloco N15 — Governança / Decisão Governada — Migration aditiva (LOCAL).
--
-- ESCOPO DESTA MIGRATION:
-- 1. Estender o CHECK de filter_version da tabela candidate_assessment
--    para aceitar o novo filtro de decisão de governança do N15:
--    'n15:governance_v1' (reutilizando a tabela do Bloco N4,
--    sem criar segunda tabela de assessment).
-- 2. Reforçar o índice composto (candidate_id, filter_version, created_at)
--    que já existe (created_by N14) — o N15 compartilha a mesma consulta.
--
-- STATUS: LOCAL-ONLY nesta fase. NÃO APLICAR EM PRODUÇÃO sem autorização
-- explícita (Fase 2+). A aplicação em produção ocorrerá apenas quando o
-- usuário autorizar o deploy correspondente.
--
-- CONTRATO DE PERSISTÊNCIA DO N15:
-- - filter_version = 'n15:governance_v1' (único valor novo desta migration).
-- - dimensions.status = APPROVED | REVIEW | BLOCKED.
-- - dimensions.action = PUBLISH | ACQUIRE_AFFILIATE | DISTRIBUTE | ADVERTISE.
-- - classification = WINNER (APPROVED) | HIDDEN_GEM (REVIEW) |
--                    NOT_RECOMMENDED (BLOCKED).
-- - recommendation = NONE (o N15 não emite recomendações de ação; o
--                    executor é externo e depende de autorização futura).
-- - is_actionable = false SEMPRE (o N15 avalia; NÃO executa nada).
-- - idempotency_key = digest determinístico do snapshot (replay dedup).
-- ============================================================================
-- 1. Estender o CHECK de filter_version.
alter table public.candidate_assessment
  drop constraint if exists candidate_assessment_filter_version_check;

alter table public.candidate_assessment
  add constraint candidate_assessment_filter_version_check
  check (filter_version in (
    'cerberus_filter_v1',
    'n13:curator_v1',
    'n14:commercial_brain_v1',
    'n15:governance_v1'
  ));

-- 2. O índice composto já existe (created_by N14, created_at desc).
--    A consulta do N15 usa o mesmo padrão (candidate_id, filter_version);
--    nada a adicionar.
-- ============================================================================
