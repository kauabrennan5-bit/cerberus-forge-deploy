# INFRA-03 — FASE 9 — VALIDAÇÃO CONTROLADA N13 → N14 → N15 → N16

## STATUS

**PARTIAL / READY FOR REVIEW — N13 BLOCKED por dependência legítima de proveniência.**

A prova real confirmou a cadeia Shopee API → Evidence Bridge → N3. O N13 consumiu as nove evidências reais, mas bloqueou de forma fail-closed porque o candidato não possuía uma proveniência reconhecida pelo contrato de curadoria. Não foi fabricado PASS, score, APPROVED, autorização ou publicação.

## PROOF_RUN_ID

`INFRA03_PHASE9_20260820T030000Z`

## SHA

`9bbb7776a1b74dd8b3f737f614e64e8767890a94`

O runtime de produção estava saudável no SHA publicado. Nenhuma alteração de código foi feita durante a Fase 9.

## AUDITORIA PRÉVIA

O N14 é o Commercial Brain e depende do gate N13. O N15 é a autoridade única para `APPROVED` e autorização. O N16 executa somente a ação de publicação e possui provider controlado/fake gated por `proof_run_id` no bootstrap, mas essa etapa só é legítima depois de um `APPROVED` real. N17 permanece proibido.

A rota N16 foi apenas auditada; não foi chamada. Não houve alteração em N14, N15, N16, N17, publicação, Telegram, scheduler, agentes ou catálogo.

## CANDIDATO E N3

Um único candidato Shopee foi criado pela rota oficial de registro, com `candidate_id=can-c0f4e9e6b05405de99de1cb0`, `external_listing_id=23794344926`, `shop_id=1530442944` e a URL oficial do item. O candidato permaneceu em `DISCOVERED` / `INTAKE`.

A única pesquisa N3 foi concluída com `research_id=rs-sha256:b36e2299de91d5ae3`. Foram criados nove registros temporários de evidência: uma sessão e oito campos. O título foi `KNOWN`, com `source_type=api` e `collection_method=API`; preço, imagens, seller, rating, review_count, availability e category permaneceram `UNKNOWN`. Nenhum valor foi inventado.

## N13

A primeira avaliação retornou `outcome=evaluated` e `verdict=BLOCKED`, com confiança `0.88`. O critério bloqueador foi `c_provenance_valid`: `provenance ausente no candidato`. O digest foi `sha256:fa02b5cb8a4bdde94b37e90372b5b9f6a913890c691c4692640d18343307ed61`.

O replay idêntico retornou `outcome=identical_duplicate`, com o mesmo veredicto e o mesmo digest. A idempotência do N13 foi confirmada.

A causa não foi convertida artificialmente em PASS. A rota oficial de intake não expõe um campo top-level de proveniência reconhecido pela curadoria, e não existe rota PATCH/PUT autorizada para completar esse atributo depois da criação. O `identity_source` e o `proof_run_id` armazenados em `metadata` não satisfizeram o critério canônico de proveniência do N13.

## N14

**NÃO EXECUTADO.** O N13 não produziu PASS; portanto, o N14 não era elegível. Não há score, confidence, assessment_id ou digest N14 a reportar.

## N15

**NÃO EXECUTADO.** Sem resultado elegível do N14, não houve autorização para N15. Não foi criado `APPROVED` nem `authorization_id`.

## N16

**NÃO EXECUTADO.** O modo controlado/fake foi auditado no código, mas a chamada foi corretamente impedida pela ausência de N15 `APPROVED`. Não houve publicação externa, affiliate link, Telegram, job, scheduler ou ação irreversível.

## N17

**NÃO EXECUTADO.** Nenhum agente de publicação foi acionado.

## BANCO E CLEANUP

Baseline antes da prova:

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

Estado durante a prova:

```text
products=13
candidates=1
candidate_evidence=9
candidate_assessment=1
affiliate_links=0
job_queue=0
publication_executions=0
commercial_cycles=0
```

O cleanup foi seletivo, com `RETURNING`, na ordem governada: `publication_executions` → `candidate_assessment` → `candidate_evidence` → `candidates`. Foram removidos exatamente um assessment, nove evidências e um candidato. Nenhum `publication_execution` existia para a prova.

Baseline depois da prova:

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

O catálogo permaneceu inalterado.

## IDEMPOTÊNCIA

O replay do N13 foi `identical_duplicate`, preservando veredicto e digest. O candidato foi criado uma única vez com chave de idempotência; não foi feito replay adicional da criação porque o N13 já estava bloqueado e nenhuma chamada externa adicional era necessária.

## GATES

```text
npm test: PASS — 1354/1354
npx tsc --noEmit: PASS
npm run build: PASS
git diff --check: PASS
secret scan: PASS
commit scope: PASS
working tree tracked changes: 0
```

## PRODUÇÃO

```text
código alterado na Fase 9: NÃO
commit adicional na Fase 9: NÃO
push adicional na Fase 9: NÃO
deploy adicional na Fase 9: NÃO
SHA live observado: 9bbb7776a1b74dd8b3f737f614e64e8767890a94
health: PASS
```

## DECISÃO FINAL

A classificação correta é **PARTIAL / READY FOR REVIEW**, não PASS CONTROLADO. A integração Shopee → Evidence Bridge → N3 foi validada com dados reais e o N13 demonstrou fail-closed e idempotência, porém a cadeia não avançou porque o candidato não tinha proveniência reconhecida. N14, N15 e N16 não foram chamados; N17 continua não iniciado.

Próximo passo mínimo: revisar e autorizar uma alteração contratual mínima para que a proveniência oficial do candidato seja registrada e reconhecida pelo N13. Depois disso, a Fase 9 deve ser repetida desde um novo proof run, sem fabricar estados e sem iniciar N17.

**PARAR.**

