# N16 — Fase 4 — Relatório Final de Consolidação

**Bloco:** N16 — Publicação Automática Governada  
**Objetivo:** consolidar a correção mínima de configuração do executor N16, validar novamente a fronteira governada em produção, preservar o N15 como autoridade exclusiva, comprovar o comportamento fail-closed, remover os artefatos temporários e encerrar o N16 sem iniciar o N17.  
**PROOF_RUN_ID:** `N16_PHASE4_20260819T193123Z`  
**Data:** 19 de agosto de 2026, UTC  
**Autor:** Manus AI  
**Status:** concluído.

> **Decisão terminal:** `FASE 4 N16 CONCLUÍDA COM LIMITAÇÕES — CONFIGURAÇÃO DO EXECUTOR CONSOLIDADA — FAIL-CLOSED CONSOLIDADO — HAPPY PATH E2E SKIPPED POR DEPENDÊNCIA EXTERNA — AGUARDANDO RESOLUÇÃO DE INFRAESTRUTURA/N17`

## 1. Resumo executivo

A Fase 4 foi executada dentro do escopo autorizado do N16. A única mudança de código consolidada tornou a nomenclatura da configuração do FakeProvider compatível com a Fase 4, preservando um fallback legado estritamente controlado para a Fase 2. Também foi adicionada uma regressão automatizada para garantir que as envs canônicas da Fase 4 permaneçam reconhecidas pelo bootstrap e pela rota administrativa.

A cadeia positiva foi tentada somente por meio das rotas oficiais. A descoberta real no Mercado Livre criou um candidato com coleta falha (`http_error`), sem evidência KNOWN. A avaliação oficial N13 retornou `BLOCKED`; portanto, não existia base legítima para gerar N14 válido, N15 `APPROVED` ou executar o provider. O happy path, `PUBLISHED`, `FAILED`, `AMBIGUOUS` e a idempotência de uma publicação efetivamente publicada permanecem corretamente classificados como `SKIPPED — DEPENDÊNCIA EXTERNA`, não como sucesso.

As provas fail-closed observadas bloquearam todas as entradas sem autorização N15 válida. O FakeProvider foi habilitado temporariamente, mas não recebeu chamadas. Nenhuma publicação comercial foi executada; nenhum produto canônico, link de afiliado, job, agente, scheduler, Telegram ou bloco N17–N20 foi acionado.

## 2. Autoridade e limites arquiteturais

O N15 permaneceu como a única autoridade de autorização. O N16 somente aceita a ação `PUBLISH` e exige avaliação N15 `APPROVED`, candidato correspondente, digests compatíveis, payload válido, destino permitido e autorização dentro do TTL. O N16 não cria sua própria autorização e não converte ausência de dados, `UNKNOWN`, falha de coleta, N13 `BLOCKED` ou N15 não aprovado em permissão.

A auditoria do serviço, engine, rota, contrato e repositório confirmou que o N16 não referencia `productsRepository`, N17, N18, N19, N20, Telegram, scheduler, agents ou `job_queue`. O executor não altera o catálogo canônico e não cria `affiliate_links`. A regra `CANDIDATE != FACT CANÔNICO` permaneceu preservada durante a prova.

## 3. Snapshot e estado inicial

O snapshot somente leitura anterior às alterações registrou o seguinte estado [1]:

```text
PROOF_RUN_ID=N16_PHASE4_20260819T193123Z
SHA antes=c9f3e1ceb2eff65224dc6f5da260a601aae2518a
origin/main antes=c9f3e1ceb2eff65224dc6f5da260a601aae2518a
branch=main
health=ok
operatorState=READY
backendReady=true
apiHealthy=true
webhookMatchesExpectedUrl=true
pendingUpdates=0
```

O baseline inicial era:

```text
products=13
candidates=0
candidate_evidence=0
candidate_assessment=0
affiliate_links=0
job_queue=0
publication_executions=0
commercial_cycles=0
```

O schema ativo de `publication_executions` foi confirmado antes da prova com RLS habilitado, zero policies públicas, chave primária em `execution_id`, unicidade em `execution_key`, constraints de ação/status/JSON e índices para candidato, execução, status, request e `proof_run_id` [1]. A migration de referência é `supabase/migrations/20260820_publication_executions.sql`; ela já havia sido aplicada na Fase 2. A Fase 4 não aplicou nova migration.

## 4. Alteração mínima consolidada

A divergência encontrada era exclusivamente de nomenclatura de configuração: a Fase 4 exige `N16_PHASE4_FAKE_PROVIDER_MODE` e `N16_PHASE4_PROOF_RUN_ID`, enquanto a fonte anterior usava somente os nomes da Fase 2. Sem a correção, a janela temporária de prova da Fase 4 não habilitaria o FakeProvider nem permitiria o `proof_run_id` correspondente.

O patch foi restrito a três arquivos:

```text
server.ts
server/routes/publicationN16Routes.ts
tests/publicationN16.test.ts
```

O bootstrap passou a priorizar `N16_PHASE4_FAKE_PROVIDER_MODE` e manter `N16_PHASE2_FAKE_PROVIDER_MODE` apenas como fallback legado controlado. A rota passou a priorizar `N16_PHASE4_PROOF_RUN_ID` e manter o fallback legado correspondente. Não houve fallback para provider real.

A regressão `AP` confirmou que o runtime reconhece as envs da Fase 4. O diff não contém App ID, App Secret, token Telegram, senha administrativa, chave Render ou outro segredo.

## 5. Tentativa legítima da cadeia positiva

Foi executada uma única tentativa oficial de descoberta real no Mercado Livre, usando a URL observada:

```text
POST /api/commercial/discover
marketplace=MERCADOLIVRE
mode=url
url=https://produto.mercadolivre.com.br/MLB-1456580521
limit=1
```

A resposta foi HTTP 200 com `ok=true`, `outcome=created` e o candidato `can-82add7c87c8ffcdfb3b9449a`. A coleta retornou `collection_failed: http_error`; título, preço, imagens, vendedor, rating, review count, disponibilidade e categoria permaneceram desconhecidos. Nenhuma evidência KNOWN foi produzida.

A avaliação oficial N13 do candidato retornou HTTP 200, `outcome=evaluated`, `verdict=BLOCKED`, `confidence=0.63`, digest `sha256:d0f391b90c136d5f4db07b29b3cdcc892d31fd5cca69d48cdfcb580f8247056f` e rationale `informacao_insuficiente_ou_conflitante`. Os gates registrados foram evidência ausente/UNKNOWN e proveniência não reconhecida.

A decisão oficial N15 para o mesmo candidato e `action=PUBLISH` retornou HTTP 200 com `outcome=blocked_by_policy`, status `BLOCKED`, decision digest `sha256:533caf8ba6b29eea1797b8bb4cfaf02879b1cd34d80dad2f2f78ab50037b8c53`, score indisponível e as razões `n13_verdict_not_pass`, `n14_assessment_missing`, `evidence_insufficient`, `provenance_invalid` e `risk_unacceptable`.

> Não foi fabricado N13 `PASS`, score N14, N15 `APPROVED`, evidência, proveniência, digest ou produto. A cadeia positiva foi encerrada honestamente como `SKIPPED — DEPENDÊNCIA EXTERNA`.

## 6. Matriz final das provas P1–P12

| Prova | Resultado | Evidência observada | Provider |
|---|---|---|---|
| P1 | `SKIPPED — DEPENDÊNCIA EXTERNA` | N13 legítimo bloqueado por `collection_failed: http_error`; não houve N15 `APPROVED` | 0 chamadas |
| P2 | `SKIPPED — DEPENDÊNCIA EXTERNA` | Dependente de N13 `PASS`, N14 válido e N15 `APPROVED` | 0 chamadas |
| P3 | `SKIPPED — DEPENDÊNCIA EXTERNA` | Replay positivo exige execução autorizada; nenhuma autorização legítima alcançou o provider | 0 chamadas |
| P4 | `SKIPPED — DEPENDÊNCIA EXTERNA` | Provider em modo `failure` não foi acionado sem N15 `APPROVED` | 0 chamadas |
| P5 | `SKIPPED — DEPENDÊNCIA EXTERNA` | Provider em modo `ambiguous` não foi acionado sem N15 `APPROVED` | 0 chamadas |
| P6 | `PASS — FAIL-CLOSED, com limitação de isolamento` | Assessment N15 envelhecido permaneceu `BLOCKED`; execução não alcançou provider. A expiração não foi isolada sobre `APPROVED`, pois o assessment tinha `expires_at=null` | 0 chamadas |
| P7 | `PASS — FAIL-CLOSED, com limitação de isolamento` | Digest divergente/ausência de autorização bloqueou; o gate não foi isolado sobre uma autorização `APPROVED` | 0 chamadas |
| P8 | `PASS — FAIL-CLOSED` | HTTP 400, `publication_payload_invalid`; ação diferente de `PUBLISH` rejeitada antes da execução | 0 chamadas |
| P9 | `PASS — FAIL-CLOSED` | HTTP 200, `BLOCKED`, `candidate_not_found`; não houve provider | 0 chamadas |
| P10 | `PASS — FAIL-CLOSED` | HTTP 200, `BLOCKED`, N15 não aprovado; linha de ledger criada | 0 chamadas |
| P11 | `PASS — FAIL-CLOSED` | HTTP 200, `BLOCKED`, payload inválido; linha de ledger criada | 0 chamadas |
| P12 | `PASS — FAIL-CLOSED` | HTTP 200, `BLOCKED`, destino inválido no request; linha de ledger criada | 0 chamadas |

P1–P5, `PUBLISHED`, `FAILED`, `AMBIGUOUS` e a idempotência de uma publicação positiva continuam sem prova E2E porque a dependência externa impede a produção legítima de N13 `PASS` e N15 `APPROVED`. Essa classificação não foi convertida em PASS artificial.

## 7. Ledger, chaves, digests e estados

O read-back anterior ao cleanup encontrou três linhas do ledger para o `PROOF_RUN_ID` da Fase 4. Todas estavam em estado terminal `BLOCKED`, tinham `provider_reference=null`, `result={}` e não continham segredo.

```text
P10
execution_id=n16-1be551ac3b589e3790182060392f9bec9bf130c30c5b86b3673e0a1d855b141a
execution_key=1be551ac3b589e3790182060392f9bec9bf130c5b86b3673e0a1d855b141a
candidate_id=can-82add7c87c8ffcdfb3b9449a
request_id=N16_PHASE4_20260819T193123Z:P10
action=PUBLISH
destination=cerberusfinds.com
n15_authorization_digest=sha256:533caf8ba6b29eea1797b8bb4cfaf02879b1cd34d80dad2f2f78ab50037b8c53
publication_payload_digest=sha256:1fe8d799a069571c25f8eca48563f5bc4cf5dc2da323b398bb765fe41a22afdf
status=BLOCKED
reason_codes=n15_authorization_not_approved,n15_authorization_invalid,n15_digest_mismatch
provider_reference=null
```

```text
P11
execution_id=n16-4a179df98cc9ae44ccb9cef283edc248b9aa1f7adb8f785859573f61977a23fe
execution_key=null
candidate_id=can-82add7c87c8ffcdfb3b9449a
request_id=N16_PHASE4_20260819T193123Z:P11
action=PUBLISH
destination=cerberusfinds.com
n15_authorization_digest=sha256:533caf8ba6b29eea1797b8bb4cfaf02879b1cd34d80dad2f2f78ab50037b8c53
publication_payload_digest=null
status=BLOCKED
reason_codes=publication_payload_invalid,n15_authorization_not_approved,n15_authorization_invalid,n15_digest_mismatch
provider_reference=null
```

```text
P12
execution_id=n16-99e5262be6a9e6b85e82a9edf6f0d4df5f20fdb114f58799d3e40807e3d6fe51
execution_key=99e5262be6a9e6b85e82a9edf6f0d4df5f20fdb114f58799d3e40807e3d6fe51
candidate_id=can-82add7c87c8ffcdfb3b9449a
request_id=N16_PHASE4_20260819T193123Z:P12
action=PUBLISH
destination=not-a-url
n15_authorization_digest=sha256:533caf8ba6b29eea1797b8bb4cfaf02879b1cd34d80dad2f2f78ab50037b8c53
publication_payload_digest=sha256:1fe8d799a069571c25f8eca48563f5bc4cf5dc2da323b398bb765fe41a22afdf
status=BLOCKED
reason_codes=n15_authorization_not_approved,n15_authorization_invalid,n15_digest_mismatch
provider_reference=null
```

P8 foi rejeitada no gate de entrada e não gerou linha no ledger. P9 foi bloqueada pela resolução de candidato ausente e também não gerou linha. Isso não constitui publicação silenciosa; permanece apenas como dívida de observabilidade para tentativas rejeitadas antes da criação de uma execução identificável.

## 8. Replay, idempotência e concorrência

A Fase 3 já havia repetido o caso P10 bloqueado e enviado requests concorrentes idênticos. As chamadas retornaram o mesmo `execution_id` e a mesma `execution_key`, e o ledger manteve uma única linha para aquela chave. Isso comprovou a idempotência e a proteção contra duplicação no caminho `BLOCKED`.

Na Fase 4 não foi possível testar idempotência de uma execução `PUBLISHED` nem a concorrência de uma autorização `APPROVED`, porque nenhuma autorização legítima alcançou o provider. Portanto, a afirmação comprovada é limitada ao caminho bloqueado; não há claim de publicação positiva.

Não houve retry automático de `FAILED` ou `AMBIGUOUS`. Esses estados não foram produzidos em produção porque a precondição de autorização não existia.

## 9. Provider e isolamento operacional

As envs temporárias foram configuradas somente no serviço Render exato `srv-d9tq9sh42hec738skftg`, com o modo controlado do FakeProvider. O provider permaneceu isolado por `proof_run_id` e não possuía fallback para provider real. Como N15 nunca retornou `APPROVED`, as contagens observadas de validação, publicação e status do provider foram zero.

Após as provas, foram removidas seletivamente as duas envs temporárias:

```text
N16_PHASE4_PROOF_RUN_ID       HTTP 204 — ausente após cleanup
N16_PHASE4_FAKE_PROVIDER_MODE HTTP 204 — ausente após cleanup
```

Nenhuma outra configuração do Render foi alterada. O pós-deploy confirmou o serviço saudável, Operator `READY`, Telegram saudável e webhook canônico; nenhuma chamada de publicação real foi feita.

## 10. Cleanup seletivo e restauração

O cleanup foi executado com filtros explícitos, CTE limitada e `RETURNING`, na ordem obrigatória:

```text
1. publication_executions: 3 linhas removidas — P10, P11 e P12.
2. candidate_assessment: 2 linhas removidas — N13 e N15 do candidato da prova.
3. candidate_evidence: 0 linhas removidas — não havia evidências persistidas.
4. candidates: 1 candidato removido — can-82add7c87c8ffcdfb3b9449a.
```

Não foi utilizado `TRUNCATE`, não houve `DELETE` amplo e nenhum produto canônico foi removido ou alterado.

A consulta final de baseline retornou exatamente:

```text
products=13
candidates=0
candidate_evidence=0
candidate_assessment=0
affiliate_links=0
job_queue=0
publication_executions=0
commercial_cycles=0
```

## 11. Gates locais e produção

| Gate | Resultado | Evidência |
|---|---|---|
| `npm test` | `PASS` | 1321 testes, 0 falhas, 0 cancelados, 0 skipped |
| `npx tsc --noEmit` | `PASS` | exit code 0 |
| `npm run build` | `PASS` | Vite e bundle server concluídos; apenas aviso convencional de chunk grande |
| `git diff --check` | `PASS` | nenhuma falha de whitespace |
| Secret scan | `PASS` | nenhum padrão de credencial encontrado no diff rastreado |
| Auditoria de escopo | `PASS` | commit limitado a três arquivos N16 |
| `/health` pós-deploy | `PASS` | status `ok`, SHA servido `44a31d687ae06d2398e6651ad1009e3acfbeefbd` |
| `/api/telegram-status` pós-deploy | `PASS` | API saudável, backend pronto, Operator `READY`, webhook esperado |
| Baseline pós-cleanup | `PASS` | catálogo com 13 produtos e zero resíduos de prova |
| Env temporária | `PASS` | ambas removidas do Render com HTTP 204 |

O teste completo passou com 1321 cenários porque a regressão `AP` da Fase 4 foi adicionada aos 1320 cenários existentes.

## 12. Commit, push e deploy

O patch foi consolidado sem force push:

```text
commit=44a31d687ae06d2398e6651ad1009e3acfbeefbd
parent=c9f3e1ceb2eff65224dc6f5da260a601aae2518a
message=feat(n16): consolidate phase4 proof configuration
branch=main
origin/main=44a31d687ae06d2398e6651ad1009e3acfbeefbd
SHA servido pelo Render=44a31d687ae06d2398e6651ad1009e3acfbeefbd
```

Os únicos arquivos incluídos no commit foram:

```text
server.ts
server/routes/publicationN16Routes.ts
tests/publicationN16.test.ts
```

O relatório e os snapshots de prova foram gerados como documentação local após a validação. Eles não foram incluídos em um segundo commit para não alterar o SHA servido sem um novo ciclo explícito de validação e deploy.

## 13. Limitações e dívidas abertas

A limitação principal permanece externa ao N16: o egress do Render não conseguiu coletar os dados necessários do Mercado Livre. Sem evidência KNOWN, N13 bloqueia; sem N13 `PASS`, N14 não produz score comercial válido; sem N14 válido, N15 não produz `APPROVED`; sem N15 `APPROVED`, N16 não pode chamar o provider. A cadeia positiva não deve ser simulada nem convertida em PASS.

A prova de expiração P6 foi fail-closed, mas não isolou a expiração sobre uma autorização `APPROVED`; o assessment utilizado era `BLOCKED` e não possuía `expires_at`. O digest mismatch P7 também não foi isolado sobre uma autorização `APPROVED`. P12 foi bloqueado antes de permitir uma avaliação independente do destino inválido, pois a autorização não era válida. Essas limitações são registradas explicitamente e não foram mascaradas.

P8 e P9 não geraram linha de ledger porque foram rejeitados antes de uma execução identificável. O comportamento é seguro e fail-closed, mas a observabilidade de todas as tentativas de entrada continua uma dívida potencial.

A propagação de `proof_run_id` para avaliações N13/N15 não é criada pelo N16 e não foi ampliada nesta fase. O ledger N16 recebeu corretamente o identificador da prova; qualquer mudança no N15 ou no repositório compartilhado exigiria escopo e autorização próprios.

## 14. Decisão final

A Fase 4 está encerrada. O N16 possui configuração phase-agnostic consolidada, regressão local, deploy confirmado, RLS e unicidade de ledger preservados, fail-closed observado, idempotência do caminho bloqueado, isolamento, cleanup seletivo, baseline restaurado e ausência de segredo no diff/ledger/respostas.

O N16 **não** deve ser declarado como publicação E2E positiva em produção. O resultado correto é:

```text
FASE 4 N16 CONCLUÍDA COM LIMITAÇÕES — CONFIGURAÇÃO DO EXECUTOR CONSOLIDADA — FAIL-CLOSED CONSOLIDADO — HAPPY PATH E2E SKIPPED POR DEPENDÊNCIA EXTERNA — AGUARDANDO RESOLUÇÃO DE INFRAESTRUTURA/N17
```

O N17 não foi iniciado. Uma nova prova positiva somente deve ocorrer depois de resolvida a dependência de egress e de existir uma cadeia observada e legítima `N13 PASS → N14 score válido → N15 APPROVED → N16 PUBLISHED`. Qualquer execução posterior deve usar um novo `PROOF_RUN_ID`, novo snapshot e nova autorização formal.

## Referências

[1]: n16_phase4_preflight_snapshot.md "N16 Fase 4 — Preflight Snapshot"
[2]: n16_phase3_report.md "N16 Fase 3 — Relatório de Prova Viva Controlada em Produção"
[3]: ../supabase/migrations/20260820_publication_executions.sql "Migration versionada do ledger N16"
[4]: ../server/commercial/publication/n16Service.ts "Orquestração do executor N16"
[5]: ../server/commercial/publication/n16Engine.ts "Engine de autorização e execução N16"
[6]: ../server/commercial/publication/n16Contract.ts "Contrato canônico N16"
[7]: https://render.com/docs/deploys "Render — Deploys"
