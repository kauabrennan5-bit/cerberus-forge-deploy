# N17 — Fase 20 (extensão) — Cleanup Governado e Revogação de Credencial

**PROOF_RUN_ID:** `N17_PHASE20_CLEANUP_20260820`
**Data:** 20 de agosto de 2026 (22:12–22:27 UTC)
**Execução:** read-only para o catálogo; remoção limitada ao candidato de prova; nenhuma operação N2–N15, N16, N17, N18; nenhuma alteração de código, commit, push ou deploy.

## 1. Objetivo

Remover governadamente o candidato de prova `can-044a25b735cb3c468b36cdce` e todos os seus resíduos no Supabase, e revogar exclusivamente a Render API key temporária criada para a Fase 14, preservando integralmente o catálogo canônico e as demais credenciais.

## 2. Inventario antes da remoção

A contagem antes da remoção, verificada diretamente no Supabase, era a seguinte.

| Tabela | Contagem antes |
| --- | --- |
| `products` | 14 |
| `candidates` | 1 (somente o candidato de prova) |
| `candidate_evidence` | 10 |
| `candidate_assessment` | 5 |
| `affiliate_links` | 0 |
| `publication_executions` | 0 |
| `commercial_cycles` | 0 |
| `job_queue` | 0 |

Os cinco assessments pertenciam exclusivamente ao candidato de prova: dois de curadoria (N13), dois do Commercial Brain (N14) e um da governança (N15, decisão `BLOCKED`). Uma auditoria prévia das restrições de chave estrangeira confirmou que não há `ON DELETE` em cascata entre essas tabelas, o que exigiu remoção explícita na ordem de dependência: evidências → assessments → candidato.

## 3. Execução da remoção

Cada remoção foi executada com `RETURNING *` para comprovar exatamente o que foi deletado, sem qualquer condição que pudesse afetar outro registro. A sequência foi:

| Passo | Tabela | Registros removidos | IDs efetivamente removidos |
| --- | --- | --- | --- |
| 1 | `candidate_evidence` | 10 | `evi-sha256:4dc06775...`, `evi-sha256:9eaae5b9...`, `evi-sha256:93882923...`, `evi-sha256:d4e72e0b...`, `evi-sha256:a40a2483...`, `evi-sha256:86f5f3f3...`, `evi-sha256:5dd66c5d...`, `evi-sha256:5daaca15...`, `evi-sha256:846c80fb...`, `evi-sha256:fd2198c0...` |
| 2 | `candidate_assessment` | 5 | `cur-aa9f89c7...`, `cur-876f2c42...`, `cb-044a25b735cb3c468b36cdce` (2 assessments N14), `gov-044a25b7...-ACQUIRE_AFFILIATE` (N15) |
| 3 | `candidates` | 1 | `can-044a25b735cb3c468b36cdce` |

Nenhum dado artificial foi criado em nenhum momento, e nenhuma linha de `products`, `affiliate_links`, `publication_executions`, `commercial_cycles` ou `job_queue` foi tocada.

## 4. Inventario depois da remoção

| Tabela | Contagem depois |
| --- | --- |
| `products` | **14 (intacto)** |
| `candidates` | 0 |
| `candidate_evidence` | 0 |
| `candidate_assessment` | 0 |
| `affiliate_links` | 0 |
| `publication_executions` | 0 |
| `commercial_cycles` | 0 |
| `job_queue` | 0 |

O estado final do banco coincide com a baseline estabelecida antes da prova: 14 produtos canônicos e zero candidatos, evidências, assessments, links ou jobs residuais.

## 5. Revogação da Render API key temporária

A API pública do Render não expõe revogação programática de API keys (o endpoint `DELETE /v1/apiKeys/{key}` retorna 404 e a documentação oficial orienta a revogação pelo dashboard). A revogação foi então executada pelo **Render Dashboard**, na sessão autenticada já disponível: `Account settings → API Keys → menu da key "shoppe" (rnd_AQsUap…) → Revoke → confirmar`.

A key `shoppe` — criada há 1h e utilizada exclusivamente para a prova da Fase 14 — foi removida; a tabela de API Keys passou a exibir apenas `FindsBot` (rnd_hx52FG…), que **não foi alterada**. A revogação foi confirmada programaticamente: qualquer chamada à API Render com a key anterior retorna `{"message":"Unauthorized"}` e HTTP `401`.

Durante todo o uso na Fase 14, a key operou somente no escopo da prova (leitura do serviço e criação de jobs one-off); nenhuma variável de ambiente com valor secreto foi lida via API, e nenhum segredo da Shopee foi exposto por meio dela.

## 6. Estado final do projeto

| Item | Estado |
| --- | --- |
| Deploy Render | `cerberus-forge-deploy-backend`, SHA servido `ce31323` (Fase 20 publicada), health 200 |
| Código publicado | `evidenceSignals.ts` (bridge) + integração em `service.ts` + 13 testes novos |
| Banco Supabase | Baseline: 14 produtos canônicos, 0 candidatos/evidências/assessments/links/jobs |
| Credenciais Render | `shoppe` revogada (401 confirmado); `FindsBot` intacta |
| Fluxos N2–N15 | Não executados durante o cleanup (autorização condiciona próxima execução) |
| N16/N17/N18 | Não executados — N17 permanece condicionado a N15 `APPROVED` |

## 7. Ponto de situação técnico (não avançar sem nova autorização)

O replay pós-Fase 20 confirmou empiricamente que a infraestrutura está funcionando: o N14 passou a transportar a evidência oficial (`evidence_refs` populado no assessment, `signals.price.source="evidence:evi-..."`) e mantém as flags corretas (`quality=UNKNOWN`, `unit=string_price_unscaled`, `SCALE_UNVERIFIED_CONTRACT_UNSPECIFIED`). O resultado N14 foi `INSUFFICIENT` porque somente **1 dimensão KNOWN (price)** foi encontrada, contra `MIN_DIMENSIONS_KNOWN=2`. O N15 retornou `BLOCKED` com motivos legítimos (`n14_score_invalid`, `risk_unacceptable`, `score_at_least_min`), e nenhuma autorização artificial foi criada.

As dimensões UNKNOWN remanescentes — seller, availability, commission, competition e market — permanecem bloqueadas por `BLOCKED — CONTRACT UNSPECIFIED` (Fases 21–24): a policy oficial 10010 da Shopee rejeita seller/stock, e nenhuma das demais dimensões possui contrato oficial na Affiliate API `productOfferV2`. A origem da segunda dimensão KNOWN é a dependência que impede `N14=SUFFICIENT` → `N15=APPROVED` → `N17`.

**Parado, conforme instruído.** Nenhuma nova implementação da 2ª dimensão foi iniciada. Aguardando próxima autorização.
