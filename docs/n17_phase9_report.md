# N17 — Fase 9 — Relatório de correção de proveniência

```text
PROOF_RUN_ID=N17_PHASE9_UNBLOCK_20260820
STATUS=BLOCKED — N15 APPROVED NÃO DISPONÍVEL
LOCAL_DECISION=READY FOR REVIEW — CORREÇÃO LOCAL VALIDADA

OBJETIVO
Corrigir somente o desalinhamento comprovado entre a proveniência canônica do discovery e a proveniência consumida por N14/N15, sem alterar policy, thresholds, score, autoridade de aquisição ou qualquer etapa downstream.

DIAGNÓSTICO
O N2 persistia metadata.provenance=n10:discovery, enquanto metadata.source podia conter marketplace_page, url_slug ou unknown como origem de campo. O N14 e o snapshot N15 priorizavam metadata.source. Assim, a origem de campo podia substituir a proveniência operacional do funil e produzir provenance_valid=false no N15.

CORREÇÃO LOCAL APLICADA
1. server/commercial/commercialBrain/service.ts
   - N14 agora prioriza metadata.provenance.
   - metadata.source permanece somente como fallback para candidatos legados sem metadata.provenance.
   - Nenhum campo UNKNOWN foi promovido a KNOWN.
   - As dimensões commission, market e competition continuam sem inferência.

2. server/commercial/governance/service.ts
   - buildCandidateSnapshot agora prioriza metadata.provenance.
   - metadata.source e candidate.provenance permanecem fallbacks compatíveis.
   - A policy N15, thresholds, TTL, ações e status não foram alterados.

TESTES ADICIONADOS
- tests/commercialBrainN14.test.ts: metadata.provenance canônico vence metadata.source.
- tests/governanceN15.test.ts: buildCandidateSnapshot prioriza metadata.provenance sobre metadata.source.
- O teste legado de N14 continua validando fallback para metadata.source quando metadata.provenance não existe.

GATES LOCAIS
npm test=PASS — 1407/1407
npx tsc --noEmit=PASS
npm run build=PASS
git diff --check=PASS
secret scan sanitizado=PASS

PRODUÇÃO E PUBLICAÇÃO
RENDER_HEALTH=PASS
RENDER_SHA=458b10878112d6b96d513e68e3929875cf5db497
LOCAL_HEAD=458b10878112d6b96d513e68e3929875cf5db497
ORIGIN_HEAD=458b10878112d6b96d513e68e3929875cf5db497
A correção permanece somente no working tree local. Commit, push e deploy NÃO foram executados nesta Fase 9, conforme regra de autorização explícita.

SUPABASE — LEITURA SOMENTE
products=14
candidates=0
candidate_evidence=0
candidate_assessment=0
affiliate_links=0
job_queue=0
publication_executions=0
commercial_cycles=0
n15_acquire_approved=0
Nenhum dado artificial foi criado ou persistido.

FLUXO DOWNSTREAM
N13 real=NÃO EXECUTADO nesta Fase 9
N14 real=NÃO EXECUTADO nesta Fase 9
N15 real=NÃO EXECUTADO nesta Fase 9
N17 acquisition=NÃO EXECUTADA
N8/Shopee API=NÃO CHAMADA
N6 persistence=NÃO EXECUTADA
Replay/conflict=NÃO EXECUTADOS
N16=NÃO EXECUTADO
N18+=NÃO INICIADO

DECISÃO
A correção local está READY FOR REVIEW. O fluxo operacional permanece BLOCKED porque não existe uma autorização N15 ACQUIRE_AFFILIATE APPROVED no Supabase e a correção ainda não foi publicada em produção. Não é permitido criar autorização artificial, chamar a Shopee antes de APPROVED, ou iniciar N17/N16/N18+.

PRÓXIMO PASSO MÍNIMO
Revisar o diff local e, se aprovado explicitamente, autorizar commit, push e deploy da correção. Após a publicação, repetir somente o fluxo oficial N2→N3→N13→N14→N15. Prosseguir para N17 apenas se N15 retornar APPROVED com authorization_ref, candidate_id, assessment_id e expires_at válidos.

ARQUIVOS ALTERADOS PELA FASE 9
server/commercial/commercialBrain/service.ts
server/commercial/governance/service.ts
tests/commercialBrainN14.test.ts
tests/governanceN15.test.ts

NENHUMA ALTERAÇÃO EM N13 ENGINE, POLICY N15, N16, N17, N8, CREDENTIALS, TELEGRAM, SCHEDULER, AGENTS OU BANCO.
```
