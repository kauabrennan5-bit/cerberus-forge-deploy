# BLOCO N16 — FASE 2
## Deploy controlado, migration e prova viva do executor

**Data da execução:** 19 de agosto de 2026, UTC.

**PROOF_RUN_ID:** `N16_PHASE2_20260819T174500Z`

**Decisão:** `FASE 2 N16 CONCLUÍDA COM LIMITAÇÕES — GATES FAIL-CLOSED PASS — AGUARDANDO FASE 3`

## 1. Escopo e autoridade

A Fase 2 promoveu o executor N16 para produção, aplicou o ledger `publication_executions`, executou provas controladas e restaurou o baseline. O N16 permaneceu restrito à ação `PUBLISH` e consumiu decisões N15; não criou autorização, não aprovou candidatos e não acessou providers reais.

Não foram conectados marketplaces, N17, N18, N19 ou N20. Não houve criação de produto canônico, aquisição de afiliado, distribuição, publicidade, tracking, Telegram, scheduler, agent runtime ou job.

O executor legado N5 permaneceu isolado. O caminho N16 não chamou `server/routes/publicationRoutes.ts` nem `server/commercial/publication/publicationExecutor.ts`.

## 2. Código, commit e deploy

A auditoria local confirmou branch `main`, working tree sem alterações rastreadas fora do N16 e ausência de alterações em N1–N15 e N5.

A SHA publicada foi:

`c9f3e1ceb2eff65224dc6f5da260a601aae2518a`

A SHA anterior ao commit N16 não foi alterada durante a prova. O commit foi publicado sem force push e `origin/main` ficou alinhado com a SHA acima.

O Render serviu a mesma SHA:

`c9f3e1ceb2eff65224dc6f5da260a601aae2518a`

O último health read-back observado foi:

`status=ok`

`service=cerberus-forge-deploy`

`timestamp=2026-08-19T18:20:06.581Z`

O horário do commit foi `2026-08-19T17:36:29Z`. O deploy automático foi confirmado pela igualdade entre `HEAD`, `origin/main` e `/health.version`.

Os arquivos ainda não rastreados ao final foram `docs/n16_phase2_external_sources.md`, criado como documentação local das fontes da API Render, e este relatório `docs/n16_phase2_report.md`. Ambos foram mantidos fora de novo commit para não mudar a SHA já validada em produção.

## 3. Gates locais finais

A suíte completa terminou com `1320/1320` testes aprovados, `0` falhas, `0` cancelados, `0` skipped e `90` suites.

A suíte específica N16 permaneceu aprovada com `41/41` cenários.

A prova local `tests/_proofN16.ts` permaneceu aprovada com `12/12` cenários, incluindo N15 BLOCKED, autorização ausente, sucesso governado, falha, ambiguidade e replay sem retry.

`npx tsc --noEmit` terminou com zero erros.

`npm run build` terminou com sucesso. O build regenerou uma projeção local de 13 produtos, sem alteração rastreada no catálogo canônico.

`git diff --check` terminou limpo.

O scan final de secrets não encontrou credenciais, tokens, senhas, App ID, App Secret, service-role key ou valores de ambiente nos artefatos N16.

A auditoria de isolamento não encontrou referências a N17, N18, N19, N20, Telegram, scheduler, `job_queue`, agents, `productsRepository`, `publicationExecutor` ou `publicationRoutes` nos componentes N16.

## 4. Migration e read-back do ledger

A migration aplicada foi:

`supabase/migrations/20260820_publication_executions.sql`

A aplicação retornou `success=true`.

A migration foi aditiva. Não executou `DROP`, `TRUNCATE`, alteração de `products`, alteração de `affiliate_links`, alteração de `job_queue` ou alteração de dados anteriores à prova.

O read-back confirmou que `publication_executions` existe e possui RLS habilitado:

`relrowsecurity=true`

O read-back confirmou a constraint única:

`publication_executions_execution_key_key`

Também foram observadas as constraints de primary key, status, action, metadata e result.

Os índices confirmados foram:

- `publication_executions_pkey` em `execution_id`;
- `publication_executions_execution_key_key` em `execution_key`;
- `publication_executions_candidate_idx` em `(candidate_id, created_at DESC)`;
- `publication_executions_status_idx` em `(status, created_at DESC)`;
- `publication_executions_request_idx` em `request_id`;
- `publication_executions_proof_run_idx` em `(proof_run_id, created_at DESC)`.

A consulta de policies retornou `null`, equivalente a zero policies públicas para a tabela.

## 5. Baseline antes e depois

O baseline antes da prova foi:

- `products=13`;
- `candidates=0`;
- `candidate_assessment=0`;
- `candidate_evidence=0`;
- `affiliate_links=0`;
- `job_queue=0`;
- `publication_executions=0`;
- `commercial_cycles=0` no baseline final consultado.

O baseline depois do cleanup e da restauração da configuração foi:

- `products=13`;
- `candidates=0`;
- `candidate_assessment=0`;
- `candidate_evidence=0`;
- `affiliate_links=0`;
- `job_queue=0`;
- `publication_executions=0`;
- `commercial_cycles=0`.

O catálogo canônico permaneceu intacto. Nenhum produto foi criado ou alterado.

## 6. Configuração temporária do FakeProvider

Durante a janela controlada, foram configuradas temporariamente no serviço Render somente as chaves:

`N16_PHASE2_PROOF_RUN_ID`

`N16_PHASE2_FAKE_PROVIDER_MODE`

O modo utilizado foi exclusivamente fake. Não houve provider real nem acesso a marketplace.

Após a prova, as duas variáveis foram removidas pela API oficial do Render. Ambas as operações de remoção retornaram HTTP `204`. O serviço foi aguardado até voltar a `status=ok` e a configuração ficou sem o modo fake temporário para uso normal.

## 7. Provas de autenticação

### N16-P2-A — senha ausente

Input: request sem `x-admin-password`.

Expected: HTTP `401`.

Actual: HTTP `401`.

Provider calls: `0`.

Status: `PASS`.

### N16-P2-B — senha inválida

Input: request com credencial administrativa inválida.

Expected: HTTP `401`.

Actual: HTTP `401`.

Provider calls: `0`.

Status: `PASS`.

### N16-P2-C — senha válida

Input: request autenticado encaminhado ao fluxo N16.

Expected: autenticação superada e processamento governado pelo N16.

Actual: autenticação superada; os cenários sem cadeia N15 válida permaneceram `BLOCKED` ou foram recusados por validação de input. Nenhum provider foi chamado sem autorização N15 APPROVED.

Status: `PASS` para o gate de autenticação e `SKIPPED — DEPENDÊNCIA EXTERNA` para qualquer publicação positiva subsequente.

A senha não apareceu em response, ledger, arquivo, relatório ou log produzido pela prova.

## 8. Provas fail-closed observadas em produção

### N16-P2-01 — N13 ausente

Candidate: artificial, posteriormente removido.

Expected: `BLOCKED`, provider `0`.

Actual: `BLOCKED`, provider `0`.

Status: `PASS`.

### N16-P2-02 — N13 BLOCKED

N13 produziu `classification=INSUFFICIENT`, `recommendation=PARK` e `verdict=BLOCKED` pela infraestrutura oficial, devido à ausência de evidência utilizável.

N15 produziu decisão não recomendada, sem autorização de publicação.

Expected: N16 `BLOCKED`, provider `0`.

Actual: N16 `BLOCKED`, provider `0`.

Status: `PASS`.

### N16-P2-03 — N15 ausente

Foi executado request para candidato sem autorização N15 correspondente.

Expected: `BLOCKED`, provider `0`.

Actual: `BLOCKED`, provider `0`.

Status: `PASS`.

### N16-P2-04 — N15 BLOCKED

Foi executada decisão N15 oficial com ação `PUBLISH` sobre cadeia sem N13/N14 suficientes. O resultado foi não recomendado, sem `APPROVED`.

Expected: N16 `BLOCKED`, provider `0`.

Actual: N16 `BLOCKED`, provider `0`.

Status: `PASS`.

### N16-P2-05 — payload inválido e destino inválido

Foram testados payloads incompletos e destino `not-a-url`, além de request sem cadeia de autorização válida.

Expected: `BLOCKED` ou rejeição de contrato, provider `0`.

Actual: `BLOCKED`/rejeição fail-closed, provider `0`.

Status: `PASS`.

O ledger recebeu nove registros artificiais `BLOCKED` durante a prova. Nenhum recebeu status `PUBLISHED`, `FAILED` ou `AMBIGUOUS`; nenhum teve provider real chamado.

## 9. Happy path controlado

O happy path completo exigiria N13 PASS, N14 válido, N15 APPROVED, ação `PUBLISH`, payload válido, destino válido, digests coerentes e autorização vigente.

A infraestrutura real disponível não permitiu produzir N13 PASS de maneira legítima para os candidatos artificiais sem fabricar evidência, score, digest ou autorização. A própria N13 classificou os candidatos como `INSUFFICIENT` por ausência de evidência utilizável. N14 e N15 não produziram uma cadeia válida para publicação.

Por regra expressa de não fabricação, os cenários positivos foram marcados:

`SKIPPED — DEPENDÊNCIA EXTERNA`

Não foi fabricado N13 PASS, N14 score, N15 APPROVED, digest, provenance ou resultado `PUBLISHED`.

Consequentemente, a prova viva de `PUBLISHED`, provider call `1`, replay idempotente positivo, `FAILED` do provider e `AMBIGUOUS` do provider ficou SKIPPED. A prova equivalente local continua registrada como evidência complementar em `tests/_proofN16.ts`, com `12/12` PASS, mas não substitui a prova viva positiva.

## 10. Ledger e cleanup

Antes do cleanup, o read-back identificou nove registros artificiais no ledger, todos `BLOCKED`.

Os quatro candidatos artificiais foram:

- `can-ddb250baa754645ee2451064`;
- `can-d943140f3ca78ee75ce77263`;
- `can-129c8431e14172cfaac98381`;
- `can-3f0225641f790d5cf00c4ef7`.

A ordem obrigatória foi respeitada:

1. `publication_executions` artificiais;
2. `candidate_assessment` artificial;
3. `candidate_evidence` artificial;
4. `candidates` artificiais.

Foram removidas seletivamente nove execuções N16, dois assessments N13/N15, zero evidências e quatro candidatos. Todos os DELETEs usaram `WHERE` explícito, CTE limitada e `RETURNING`. Não foi usado `TRUNCATE`, `DELETE` amplo ou remoção de dados anteriores à prova.

O read-back final confirmou `publication_executions=0`, `candidate_assessment=0`, `candidate_evidence=0` e `candidates=0`.

## 11. Idempotência, digests e execution keys

A implementação local comprovou que a `execution_key` é determinística e usa candidato, digest da autorização N15, digest do payload, destino e ação. Também comprovou replay sem nova chamada de provider, alteração de payload produzindo novo digest e nova chave, e retenção de `AMBIGUOUS` sem retry automático.

Na prova viva, não havia cadeia N15 APPROVED que permitisse alcançar o provider. Portanto, não foi permitido declarar `PUBLISHED`, replay positivo ou chamada de provider em produção.

Nos registros bloqueados sem autorização ou payload válido, a engine fail-closed não fabricou digests. O read-back mostrou `execution_key=null` nos bloqueios sem dados suficientes; nos casos em que a chave pôde ser calculada, ela foi preservada no ledger durante a prova e removida seletivamente no cleanup.

## 12. Limitações e dívidas

A principal limitação é a ausência de uma cadeia N13 → N14 → N15 artificialmente válida que possa ser produzida sem fabricar evidência ou decisão. Isso impede declarar a prova viva positiva do executor como PASS.

Também foi observado que alguns assessments produzidos pelo fluxo oficial não carregaram `proof_run_id` diretamente no metadata N13/N15. A rastreabilidade operacional foi mantida pelos quatro `candidate_id` artificiais e pelo escopo temporal da prova, permitindo cleanup seletivo, mas a propagação explícita do `PROOF_RUN_ID` para todos os assessments permanece uma dívida de observabilidade para revisão futura.

A dívida D-1 permanece: `getCandidate()` não distingue not-found de erro de infraestrutura e o N16 trata ambos fail-closed.

A dívida D-2 permanece: o egress do Render bloqueia scraping de marketplaces e não deve ser contornado pelo N16.

A dívida D-3 permanece: credenciais Shopee não fazem parte do N16 e continuam sob N17.

O provider real permanece deliberadamente desconectado e exige autorização e prova separadas.

## 13. Resultado final

Não houve incidente de segurança, publicação real, alteração de catálogo, chamada a provider real, chamada a N17–N20, Telegram, scheduler, agents ou job_queue.

Todos os gates fail-closed aplicáveis passaram. Os cenários que dependiam de N13 PASS, N14 válido e N15 APPROVED foram corretamente marcados como `SKIPPED — DEPENDÊNCIA EXTERNA`, nunca convertidos artificialmente em PASS.

FASE 2 N16 CONCLUÍDA COM LIMITAÇÕES — GATES FAIL-CLOSED PASS — AGUARDANDO FASE 3
