# N16 — Fase 3 — Relatório de Prova Viva Controlada em Produção

**Bloco:** N16 — Publicação Automática Governada  
**Objetivo:** validar em produção o executor de publicação que consome exclusivamente autorizações N15 `APPROVED` para a ação `PUBLISH`, preservando fail-closed, idempotência, observabilidade, isolamento e reversibilidade.  
**PROOF_RUN_ID:** `N16_PHASE3_20260819T183758Z`  
**Data da prova:** 19 de agosto de 2026, UTC  
**Autor:** Manus AI

> **Decisão final:** `FASE 3 N16 CONCLUÍDA COM LIMITAÇÕES — FAIL-CLOSED CONSOLIDADO — HAPPY PATH E2E SKIPPED POR DEPENDÊNCIA EXTERNA — AGUARDANDO RESOLUÇÃO DE INFRAESTRUTURA/N17`

## 1. Escopo e autoridade

A Fase 3 executou somente a prova viva controlada do N16. O N15 permaneceu como a única autoridade de autorização. O N16 não criou autorização própria, não alterou o catálogo canônico, não publicou para N17, N18, N19 ou N20, não acionou Telegram, scheduler, agentes ou `job_queue`, e não criou `affiliate_links`.

A tentativa positiva foi permitida apenas com dados efetivamente observados. Nenhum N13 `PASS`, score N14, N15 `APPROVED`, evidência, proveniência, digest ou produto foi inventado. A separação `CANDIDATE != FACT CANÔNICO` foi mantida durante toda a prova, conforme o snapshot pré-prova e os contratos versionados [1] [2].

## 2. Snapshot, versão servida e migração

O snapshot pré-prova registrou `HEAD=c9f3e1ceb2eff65224dc6f5da260a601aae2518a`, `origin/main` coincidente, branch `main`, working tree sem alterações rastreadas, serviço saudável, `operatorState=READY` e baseline com 13 produtos e zero registros nas superfícies de prova [1].

O SHA antes e depois da Fase 3 foi o mesmo:

```text
SHA antes: c9f3e1ceb2eff65224dc6f5da260a601aae2518a
SHA depois: c9f3e1ceb2eff65224dc6f5da260a601aae2518a
HEAD local = origin/main = SHA servido pelo Render
```

Não houve alteração de código, commit, push, migration nova ou deploy durante a Fase 3. A migration `20260820_publication_executions.sql`, aplicada na Fase 2, permaneceu compatível com o schema ativo em produção: os nomes efetivos são `n15_authorization_digest`, `publication_payload_digest`, `provider_reference`, `result`, `reason_codes`, `error_code` e `error_message` [2].

A verificação final de produção retornou `/health` saudável, com o SHA esperado. O endpoint de status do Telegram retornou `apiHealthy=true`, `backendReady=true`, `webhookMatchesExpectedUrl=true`, `pendingUpdates=0`, `operatorState=READY` e o mesmo `backendSha` do serviço.

## 3. Auditoria do schema do ledger

A tabela `publication_executions` foi auditada diretamente no Supabase de produção. O RLS está habilitado, não existem policies públicas, `execution_key` possui unicidade, e os índices de candidato, status, request e `proof_run_id` estão presentes conforme a migration versionada [2].

O schema ativo preserva os campos necessários para auditoria: identidade da execução, chave determinística, candidato, digest da autorização N15, digest do payload, destino, ação, status, reason codes, referência do provider, resultado, erros, request, correlação, `proof_run_id`, timestamps e metadata.

## 4. Tentativa legítima da cadeia positiva

Foi feita uma única tentativa legítima de descoberta no Mercado Livre usando a URL real `https://produto.mercadolivre.com.br/MLB-1456580521`. A descoberta retornou HTTP 200, `found=1`, `created=1`, e gerou o candidato `can-79c5c6d2d1e4849588d23a37`. A coleta falhou com `collection_failed: http_error`; título, preço, imagens, vendedor, rating, reviews, disponibilidade e categoria permaneceram `UNKNOWN`. Nenhum dado foi confirmado por aproximação.

A avaliação oficial N13 desse candidato retornou HTTP 200 com `outcome=evaluated` e veredicto `BLOCKED`. A decisão registrou ausência de evidência, incoerência das evidências UNKNOWN e proveniência não reconhecida. O digest N13 observado foi `sha256:38ec163027a2aac120612c6798363f9be148052b3f299ad4bc4f9cc5d04d32ba`.

Como N13 não produziu `PASS`, não havia base legítima para executar N14, gerar um score comercial, obter N15 `APPROVED` ou alcançar o provider N16. Portanto, a cadeia positiva E2E não foi convertida artificialmente em sucesso.

## 5. Matriz das provas P1–P12

| Prova | Resultado | Evidência principal | Provider |
|---|---|---|---|
| P1 | `SKIPPED — DEPENDÊNCIA EXTERNA` | N13 legítimo bloqueado por `http_error`; não houve N15 `APPROVED` | 0 chamadas |
| P2 | `SKIPPED — DEPENDÊNCIA EXTERNA` | Dependente de N13 `PASS` e N14; cadeia positiva indisponível | 0 chamadas |
| P3 | `SKIPPED — DEPENDÊNCIA EXTERNA` | Replay positivo exige publicação previamente autorizada; não houve N15 `APPROVED` | 0 chamadas |
| P4 | `SKIPPED — DEPENDÊNCIA EXTERNA` | Não existia N15 `APPROVED` legítimo para testar provider `failure` | 0 chamadas |
| P5 | `SKIPPED — DEPENDÊNCIA EXTERNA` | Não existia N15 `APPROVED` legítimo para testar provider `ambiguous` | 0 chamadas |
| P6 | `PASS — FAIL-CLOSED` | HTTP 200, `BLOCKED`, provider não alcançado; avaliação N15 permaneceu `BLOCKED` mesmo envelhecida | 0 chamadas |
| P7 | `PASS — FAIL-CLOSED` | HTTP 200, `BLOCKED`, autorização ausente; provider não alcançado | 0 chamadas |
| P8 | `PASS — FAIL-CLOSED` | HTTP 400, `publication_payload_invalid`, ação diferente de `PUBLISH` rejeitada | 0 chamadas |
| P9 | `PASS — FAIL-CLOSED` | HTTP 200, `BLOCKED`, `candidate_not_found`; nenhum provider | 0 chamadas |
| P10 | `PASS — FAIL-CLOSED` | HTTP 200, `BLOCKED`, N15 não aprovado; ledger gravado | 0 chamadas |
| P11 | `PASS — FAIL-CLOSED` | HTTP 200, `BLOCKED`, payload semântico inválido; ledger gravado | 0 chamadas |
| P12 | `PASS — FAIL-CLOSED` | HTTP 200, `BLOCKED`, destino inválido no request; ledger gravado | 0 chamadas |

P6–P12 provaram que o executor não alcança o provider sem autorização válida. Algumas condições específicas foram avaliadas juntamente com gates anteriores: a expiração de P6 não foi isolada sobre uma autorização `APPROVED`, o mismatch de digest de P7 não foi isolado sobre uma autorização `APPROVED`, e o destino inválido de P12 foi acompanhado pela ausência de autorização. Essas limitações estão registradas abaixo e não foram mascaradas como prova positiva.

## 6. Detalhes de execução, chaves e digests

Todas as linhas de ledger da prova tiveram status terminal `BLOCKED`, `provider_reference=null`, `result={}` e nenhum resultado de provider. As linhas foram auditadas antes do cleanup e removidas seletivamente depois.

```text
P6
candidate_id: can-6da4525d4869b4869514305c
execution_id: n16-36d370540700a120af5a8adcf5b41aa177bf7c8659b5afb8e7d0ddbf70524896
execution_key: 36d370540700a120af5a8adcf5b41aa177bf7c8659b5afb8e7d0ddbf70524896
action: PUBLISH
authorization_digest: sha256:6cb4fdc30764126938840dcd7a920e9c86b4165e22c3128f0ecc551aeaf00231
payload_digest: sha256:1b6d54c58c6dcfa3ceebce002e66dc4c3c2bdf81899b00464f8b4f7551f0ac90
status: BLOCKED
reason_codes: n15_authorization_not_approved, n15_authorization_invalid, n15_digest_mismatch
```

```text
P7
candidate_id: can-971bca1c106aeb0d0a4129d5
execution_id: n16-f01c7e7d5090b38dd0a1adf65567d42317d749091a3751b358b364ccc6d19cc9
execution_key: null
authorization_digest: null
payload_digest: sha256:74ebaadda548a47bb113e7498959f5ab482abfce64d4aa71029ba0cbfbf517b1
status: BLOCKED
reason_codes: n15_authorization_missing
```

```text
P10
candidate_id: can-6c761b0d9f391542aa6b70d9
execution_id: n16-69ed08b83af2463135e7a6bec0570ef5e571188755b78cf82b0660f634308079
execution_key: 69ed08b83af2463135e7a6bec0570ef5e571188755b78cf82b0660f634308079
action: PUBLISH
authorization_digest: sha256:117f1a5e7be72a221a835cdcb56727dab2dc9c81d781b31a023a69a28e842879
payload_digest: sha256:2d3aba43aed709702a5206997624a105fa656edd9589dc6ed30f5f6b0d15bb59
destination: cerberusfinds.com
status: BLOCKED
reason_codes: n15_authorization_not_approved, n15_authorization_invalid, n15_digest_mismatch
```

```text
P11
candidate_id: can-6c761b0d9f391542aa6b70d9
execution_id: n16-490315cc0ae2cf31ac7050fe5a6a270bd1782fc7c3c9f887d5e126521c837507
execution_key: null
payload_digest: null
destination: cerberusfinds.com
status: BLOCKED
reason_codes: publication_payload_invalid, n15_authorization_not_approved, n15_authorization_invalid, n15_digest_mismatch
```

```text
P12
candidate_id: can-8d97c86185c03a9c1079eef1
execution_id: n16-35c16a61174b7b37155b2625c217d970380207d35bddd397f3698f32fc8ae430
execution_key: null
authorization_digest: null
payload_digest: sha256:0edd879446aac03359473c23cd0b4b521d5b82d26e32597f27d24329361da035
destination: not-a-url
status: BLOCKED
reason_codes: n15_authorization_missing
```

P8 não gerou linha de ledger porque a rota rejeitou a ação inválida no gate de entrada. P9 também não gerou linha porque o candidato não existia; a ausência de linha nesses dois casos é uma limitação de observabilidade de erros de entrada ou de resolução anterior ao ledger, não uma publicação silenciosa.

## 7. Replay, idempotência e concorrência

O request P10 foi repetido uma vez e enviado simultaneamente em duas chamadas adicionais. As três chamadas concorrentes e o replay retornaram HTTP 200, status `BLOCKED`, o mesmo `execution_id` `n16-69ed08b83af2463135e7a6bec0570ef5e571188755b78cf82b0660f634308079` e a mesma `execution_key` `69ed08b83af2463135e7a6bec0570ef5e571188755b78cf82b0660f634308079`.

A auditoria do ledger mostrou apenas uma linha para essa chave. Assim, a idempotência e a proteção contra segunda identidade de execução foram comprovadas no caminho BLOCKED com chave determinística. A idempotência de uma publicação efetivamente `PUBLISHED` não foi comprovada em produção porque não existia autorização N15 legítima para alcançar o provider.

Não houve retry automático de `FAILED` ou `AMBIGUOUS`; esses estados não foram produzidos na produção desta fase, pois não havia autorização válida para chamar o FakeProvider.

## 8. Provider e isolamento

O FakeProvider foi habilitado temporariamente em modo `success` somente para permitir o teste controlado da fronteira caso uma autorização N15 válida existisse. Como a cadeia legítima terminou em N13 `BLOCKED`, as contagens observadas de chamadas `validate`, `publish` e `getStatus` foram todas zero. Os modos `failure` e `ambiguous` não foram acionados porque isso exigiria uma autorização N15 `APPROVED` legítima.

A auditoria estática do código e os contadores de produção confirmaram que N16 não chama N17, N18, N19 ou N20, não usa Telegram, scheduler, agentes ou `job_queue`, e não escreve `products` ou `affiliate_links` [3] [4] [5] [6].

Antes do cleanup, as contagens eram `products=13`, `candidates=5`, `candidate_evidence=0`, `candidate_assessment=3`, `affiliate_links=0`, `job_queue=0`, `publication_executions=5` e `commercial_cycles=0`. O catálogo permaneceu intacto e nenhum candidato recebeu `promoted_product_id`.

## 9. Cleanup seletivo e restauração

O cleanup foi executado na ordem obrigatória, sempre com CTE limitada, filtro explícito e `RETURNING`:

```text
1. publication_executions: 5 linhas removidas pelo PROOF_RUN_ID.
2. candidate_assessment: 3 linhas removidas pelos candidate_ids explícitos.
3. candidate_evidence: 0 linhas removidas; não havia evidências vinculadas.
4. candidates: 5 linhas removidas pelos candidate_ids explícitos.
```

Não foi usado `TRUNCATE`, `DELETE` amplo ou limpeza por aproximação. A verificação final retornou exatamente:

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

As variáveis temporárias do Render `N16_PHASE2_PROOF_RUN_ID` e `N16_PHASE2_FAKE_PROVIDER_MODE` foram removidas com HTTP 204. A consulta final do serviço retornou HTTP 200 e confirmou `N16_PHASE2_PROOF_RUN_ID=ABSENT`, `N16_PHASE2_FAKE_PROVIDER_MODE=ABSENT` e `N16_FAKE_PROVIDER_MODE=ABSENT`.

## 10. Gates finais

| Gate | Resultado | Evidência |
|---|---|---|
| `npm test` | `PASS` | 1320 testes, 0 falhas, 0 cancelados, 0 skipped |
| `npx tsc --noEmit` | `PASS` | exit code 0 |
| `npm run build` | `PASS` | Vite e bundle server concluídos; 13 produtos projetados |
| `git diff --check` | `PASS` | sem erro de whitespace |
| Secret scan do diff | `PASS` | nenhum valor de segredo no diff rastreado |
| `/health` produção | `PASS` | status ok; SHA c9f3e1ceb2eff65224dc6f5da260a601aae2518a |
| `/api/telegram-status` | `PASS` | API saudável; Operator READY; webhook canônico |
| baseline final | `PASS` | 13 produtos e zero resíduos nas tabelas de prova |
| escopo Git | `PASS` | HEAD local = origin/main; sem diff rastreado |

O build emitiu apenas o aviso convencional de tamanho de chunk do frontend, sem erro de compilação ou alteração rastreada no catálogo projetado.

## 11. Limitações e dívidas abertas

A limitação principal é externa ao N16: o egress do Render não conseguiu coletar a página do Mercado Livre, fazendo a tentativa legítima N13 terminar em `BLOCKED`. Sem N13 `PASS`, não existe N14 válido nem N15 `APPROVED`; portanto, não é possível comprovar o happy path E2E nem os estados `PUBLISHED`, `FAILED` ou `AMBIGUOUS` em produção sem violar a regra de não fabricar autorização.

A prova de expiração P6 confirmou o fail-closed, mas não isolou a razão de expiração porque o assessment envelhecido era N15 `BLOCKED` e possuía `expires_at=null`. A prova de digest divergente P7 também confirmou o bloqueio, mas não isolou o digest gate sobre uma autorização `APPROVED`. P12 confirmou bloqueio, mas o primeiro gate de autorização ausente ocorreu antes da validação independente do destino inválido.

A metadata das avaliações N15 observadas carregou `proof_run_id=null`, enquanto o ledger N16 carregou corretamente o `PROOF_RUN_ID`. Isso reflete o contrato atual da rota N15, que não recebe o identificador da prova N16. Qualquer melhoria de propagação de prova no N15 ou no repositório compartilhado é uma dívida de observabilidade fora do escopo desta Fase 3 e não foi implementada.

P8 e P9 não geraram linhas de ledger por serem rejeitados antes da criação de uma execução identificável. O comportamento é fail-closed e não alcança o provider, mas permanece como dívida de observabilidade caso se deseje um ledger para toda tentativa de entrada inválida.

## 12. Decisão e próximo passo

A Fase 3 está encerrada com fail-closed, isolamento, idempotência do caminho BLOCKED, cleanup seletivo e baseline restaurado. Não há alteração local de código a consolidar nesta fase, não houve commit, push ou deploy novo, e o SHA servido continua o SHA consolidado da Fase 2.

O N16 não deve ser declarado E2E positivo em produção. O próximo passo possível é resolver a dependência de infraestrutura/egress e executar uma nova prova autorizada com uma cadeia legítima N13 `PASS` → N14 → N15 `APPROVED`, ou seguir para o N17 somente mediante autorização explícita e plano próprio. O N17 não foi iniciado nesta tarefa.

## Referências

[1]: n16_phase3_preproof_snapshot.md "N16 Phase 3 — Pre-proof snapshot"
[2]: ../supabase/migrations/20260820_publication_executions.sql "Migration versionada do ledger N16"
[3]: ../server/commercial/publication/n16Service.ts "Orquestração do executor N16"
[4]: ../server/commercial/publication/n16Contract.ts "Contrato canônico N16"
[5]: ../server/repositories/publicationExecutionsRepository.ts "Persistência e idempotência do ledger N16"
[6]: ../server/routes/publicationN16Routes.ts "Rota administrativa de execução N16"
[7]: ../tests/publicationN16.test.ts "Suíte de regressão N16"
[8]: ../tests/_proofN16.ts "Prova local N16"
