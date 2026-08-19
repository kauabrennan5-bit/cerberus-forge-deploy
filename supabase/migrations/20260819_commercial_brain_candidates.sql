-- ============================================================================
-- Bloco N14 — Commercial Brain de CANDIDATES — Migration aditiva (LOCAL).
--
-- ESCOPO DESTA MIGRATION:
-- 1. Estender o CHECK de filter_version da tabela candidate_assessment
--    para aceitar o novo filtro de avaliação comercial do N14:
--    'n14:commercial_brain_v1' (reutilizando a tabela do Bloco N4,
--    sem criar segunda tabela de assessment).
-- 2. Adicionar índice composto (candidate_id, filter_version, created_at)
--    para a consulta do gate N13 e leitura das avaliações N14.
--
-- STATUS: LOCAL-ONLY nesta fase. NÃO APLICAR EM PRODUÇÃO sem autorização
-- explícita (Fase 2+). A aplicação em produção ocorrerá apenas quando o
-- usuário autorizar o deploy correspondente.
-- ============================================================================

-- 1. Estender o CHECK de filter_version.
alter table public.candidate_assessment
  drop constraint if exists candidate_assessment_filter_version_check;

alter table public.candidate_assessment
  add constraint candidate_assessment_filter_version_check
  check (filter_version in (
    'cerberus_filter_v1',
    'n13:curator_v1',
    'n14:commercial_brain_v1'
  ));

-- 2. Índice composto para o gate N13 e a leitura N14.
create index if not exists idx_candidate_assessment_candidate_filter
  on public.candidate_assessment (candidate_id, filter_version, created_at desc);
