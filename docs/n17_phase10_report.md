# N17 — Fase 10 — Relatório final

```text
PROOF_RUN_ID=N17_PHASE10_FINAL_20260820
STATUS=BLOCKED
DECISION=BLOCKED — DEPENDÊNCIA EXTERNA (Shopee commercial dimensions not contractually specified)
N17=NOT_OPERATIONAL_FOR_REAL_ACQUISITION
READY_FOR_N18=NO

OBJETIVO
Publicar a correção de proveniência da Fase 9, repetir o fluxo real N2→N3→N13→N14→N15 e prosseguir para N17 somente se N15 produzisse uma autorização legítima APPROVED para ACQUIRE_AFFILIATE.

ESCOPO E PUBLICAÇÃO
A publicação foi limitada exatamente aos quatro arquivos autorizados da Fase 9:
- server/commercial/commercialBrain/service.ts
- server/commercial/governance/service.ts
- tests/commercialBrainN14.test.ts
- tests/governanceN15.test.ts

A correção publicada no commit cf7225e6cd1d37f64ab164a56ffa65a66ce1fefe faz o N14 e o snapshot do N15 priorizarem metadata.provenance como proveniência operacional canônica. metadata.source permanece somente como fallback de compatibilidade para registros legados sem metadata.provenance. A correção impede que a origem de um campo substitua a proveniência canônica do funil; não promove UNKNOWN para KNOWN, não cria score, não altera thresholds, policy, TTL, ações, autoridade de aquisição ou qualquer regra de governança.

Render:
- health=HTTP 200
- SHA servido confirmado=cf7225e6cd1d37f64ab164a56ffa65a66ce1fefe
- deploy=CONFIRMADO

FLUXO REAL EXECUTADO
A cadeia oficial executada foi:
N2 discovery → N3 research/evidence → N13 curation → N14 Commercial Brain → N15 Governance ACQUIRE_AFFILIATE

Identidade da oportunidade observada:
- candidate_id=can-67fe9cdde06b01c9453ddd0c
- marketplace=Shopee
- source_product_id=423833774
- source_shop_id=25690571694

Resultados observados:
- N2 discovery=EXECUTED
- N3 research/evidence=EXECUTED
- N13=PASS
- N14 band=INSUFFICIENT
- N15 action=ACQUIRE_AFFILIATE
- N15 decision=BLOCKED
- N15 APPROVED=NOT_RETURNED

GATE LEGÍTIMO DE PARADA
O N14 permaneceu INSUFFICIENT porque a integração Shopee Affiliate BR não fornece, sob contrato oficial verificável, cobertura comercial suficiente para sustentar a decisão. A observação real de price como string não define oficialmente moeda, unidade, escala decimal, locale, arredondamento ou transformação segura para priceMinorUnits. availability, commission, competition e market permanecem NOT AVAILABLE e BLOCKED — CONTRACT UNSPECIFIED no caminho atual. Nenhuma dimensão foi inferida, convertida em zero, promovida para KNOWN ou usada para inflar score.

Este é um bloqueio por DEPENDÊNCIA EXTERNA — contrato da API Shopee/comercial coverage — e não um defeito da correção de proveniência publicada. A correção funcionou no sentido de preservar a proveniência canônica, mas não poderia criar cobertura comercial que a fonte não especifica.

N17 E DOWNSTREAM
- N17 acquisition=NOT_EXECUTED
- N8/Shopee API=NOT_CALLED
- provider oficial=NOT_INVOKED
- N6 persistence=NOT_EXECUTED
- affiliate_link_id=NOT_CREATED
- acquisition_ref=NOT_CREATED
- response_digest de aquisição=NOT_CREATED
- replay=NOT_EXECUTED
- conflict=NOT_EXECUTED
- N16 resolução=NOT_EXECUTED
- publicação/distribuição=NOT_EXECUTED
- N18+=NOT_EXECUTED

A parada ocorreu antes de qualquer chamada de aquisição porque não existia N15 APPROVED legítimo. IDENTITY_UNCERTAIN, replay, conflito e resolução N16 não foram exercitados nesta prova, pois suas pré-condições não foram satisfeitas.

CLEANUP SELETIVO
O cleanup foi executado somente para candidate_id=can-67fe9cdde06b01c9453ddd0c, na ordem obrigatória e com RETURNING:
1. publication_executions: 0 removidas; retorno vazio confirmado.
2. candidate_assessment: 3 removidas; todos os retornos corresponderam ao candidate_id da prova.
3. candidate_evidence: 9 removidas; todos os retornos corresponderam ao candidate_id da prova.
4. candidates: 1 removido; retorno correspondeu ao candidate_id da prova.

Nenhum produto canônico, affiliate_link, job_queue, commercial_cycle ou registro fora do candidato da prova foi alterado pelo cleanup.

BASELINE SUPABASE — SOMENTE LEITURA
ANTES DA PROVA:
- products=14
- candidates=0
- candidate_evidence=0
- candidate_assessment=0
- affiliate_links=0
- job_queue=0
- publication_executions=0
- commercial_cycles=0

INVENTÁRIO ANTES DO CLEANUP:
- publication_executions=0
- candidate_assessment=3
- candidate_evidence=9
- candidates=1

DEPOIS DO CLEANUP:
- products=14
- candidates=0
- candidate_evidence=0
- candidate_assessment=0
- affiliate_links=0
- job_queue=0
- publication_executions=0
- commercial_cycles=0

TEMPORÁRIOS
Removidos após o cleanup:
- docs/n17_phase10_cleanup_step.json
- docs/n17_phase10_cleanup_inventory.json
- docs/phase10_products_read.json

GATES
- npm test=PASS — 1407/1407
- npx tsc --noEmit=PASS
- npm run build=PASS
- git diff --check=PASS
- secret scan sanitizado=PASS
- Render /health=PASS — HTTP 200
- Render SHA servido=PASS — cf7225e6cd1d37f64ab164a56ffa65a66ce1fefe

INTEGRIDADE E LIMITES
Não houve fabricação de N13 PASS, score N14, aprovação N15, provenance, digest, evidence ou artefato de publicação. Não houve relaxamento de threshold, alteração de policy, bypass de governança, chamada real de aquisição Shopee, publicação, alteração de catálogo ou início de N18.

DECISÃO FINAL
STATUS=BLOCKED
N14=INSUFFICIENT
N15=BLOCKED
N17=NOT_OPERATIONAL_FOR_REAL_ACQUISITION
READY_FOR_N18=NO

O próximo passo mínimo, somente mediante nova autorização explícita, é obter contrato oficial Shopee que defina as dimensões comerciais necessárias ou autorizar uma fonte comercial alternativa verificável para o N14. Não iniciar N18, não criar APPROVED artificial e não executar aquisição até que N14 produza cobertura suficiente e N15 produza legitimamente APPROVED / ACQUIRE_AFFILIATE.

COMMIT/PUSH/DEPLOY
- commit da correção de proveniência=cf7225e6cd1d37f64ab164a56ffa65a66ce1fefe
- push=CONCLUÍDO na publicação autorizada
- deploy Render=CONCLUÍDO e SHA confirmado
- commit do relatório final=NOT PERFORMED
- push do relatório final=NOT PERFORMED
```

## Referências internas

[1]: `docs/n17_phase9_report.md` — correção de proveniência e gates da Fase 9.
[2]: `docs/infra03_phase25_shopee_commercial_coverage.md` — consolidação da cobertura comercial Shopee e bloqueio contratual.
[3]: `docs/n17_phase8_report.md` — padrão anterior de prova real, parada fail-closed e cleanup seletivo.
