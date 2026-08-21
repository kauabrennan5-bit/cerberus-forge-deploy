# INFRA-03 — Fase 11 — Consolidação, Deploy e Validação Controlada da Provenance

## Status final

**PASS CONTROLADO.** A correção mínima da Fase 10 foi consolidada no commit autorizado, publicada em `origin/main`, disponibilizada no Render e validada em produção com uma única prova real Shopee até N13. A prova foi encerrada após N13 e seu replay. N14, N15, N16 e N17 não foram executados.

## SHA antes e depois

O SHA de produção antes da consolidação era `9bbb7776a1b74dd8b3f737f614e64e8767890a94`. O commit da correção foi `7fd48567753bec51186db1ceb423fbc726931c51`.

Após o deploy automático, `/health` retornou `status=ok` e o campo `version` correspondeu exatamente a `7fd48567753bec51186db1ceb423fbc726931c51`. O SHA live foi confirmado antes da prova real.

## Commit e escopo

Commit criado com a mensagem `fix(infra03): persist canonical discovery provenance`.

O commit contém exclusivamente:

- `server/commercial/discovery/discover.ts`
- `tests/discovery.test.ts`
- `tests/curationPipelineN13.test.ts`

A alteração de produção é somente a persistência de `metadata.provenance="n10:discovery"` no candidato criado pelo fluxo de discovery. Nenhuma regra do N13 foi alterada. N14, N15, N16, N17, catálogo, `products`, Telegram, scheduler, agents, `job_queue` e credenciais não foram alterados.

Relatórios e artefatos locais permaneceram fora do commit.

## Proof run

`PROOF_RUN_ID=INFRA03_PHASE11_20260820T032800Z`

Foi executada uma única prova real usando o cliente Shopee oficial, o Evidence Bridge existente e o fluxo N2/N3 de discovery. Foi reutilizado o item previamente validado:

- `item_id=23794344926`
- `shop_id=1530442944`

A identidade retornada coincidiu com a identidade solicitada. A resposta oficial de `productOfferV2` retornou HTTP 200.

O `response_digest` observado nas evidências foi `sha256:4a71b09f0da9f905cc2afb09fb2c945184d0760ca0017cc5d5e8e96394133a5e`. Nenhum segredo foi persistido ou exposto.

## Candidate e provenance

O candidato temporário foi criado pelo mecanismo oficial e apresentou:

- `candidate_id=can-8643d0f70d4620801279e959`
- `external_listing_id=shopee-1530442944-23794344926`
- `metadata.provenance="n10:discovery"`
- `metadata.source="marketplace_page"`
- `metadata.discovery_block="N2"`

A prova confirmou especificamente a presença de `metadata.provenance`, que é o campo lido pelo N13. `metadata.source`, `source_type` e `collection_method` não foram tratados como substitutos de provenance.

## Candidate evidence

A execução criou oito evidências de campo e uma evidência de sessão, totalizando nove registros temporários em `candidate_evidence`.

As oito evidências de campo Shopee apresentaram `source_type=api`, `collection_method=API`, `observed_at` em UTC, operação `productOfferV2`, HTTP 200 e o mesmo `response_digest` sanitizado.

O título foi persistido como `KNOWN` porque foi realmente observado pela resposta oficial. Preço, imagens, seller, rating, review_count, availability e category permaneceram `UNKNOWN` quando não foram retornados. Nenhum valor foi inventado.

A evidência de sessão N3 permaneceu semanticamente distinta e registrou `collection_method=SCRAPE` apenas como metadado da sessão de pesquisa; as evidências Shopee de campo foram API. Isso não substitui nem altera `metadata.provenance` do candidato.

## N13

N13 consumiu o candidato e as nove evidências e retornou:

- `verdict=PASS`
- `assessment_id=cur-88fcad17de93d022ccd7185e509608981c00924d`
- `idempotency_key=sha256:01ccb268e008bd7ed7c5c68088fcad17de93d022ccd7185e509608981c00924d`
- `classification=INSUFFICIENT`
- `recommendation=INVESTIGATE_FURTHER`
- `is_actionable=false`

O resultado confirma que N13 não bloqueou pelo critério `c_provenance_valid`. O `PASS` é estrutural e não constitui autorização comercial, aprovação N15 ou autorização de publicação.

O replay controlado do mesmo candidato e das mesmas evidências retornou `identical_duplicate`, com o mesmo verdict e o mesmo digest/idempotency key. Nenhuma nova chamada Shopee foi feita no replay.

## N14–N17 e publicação

N14 não foi executado. N15 não foi executado. N16 não foi executado. N17 não foi iniciado.

Não houve publicação, `affiliate_link`, Telegram, scheduler, agent ou escrita em `job_queue`. Nenhum `publication_execution` foi criado.

## Baseline

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

Durante a prova:

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

Após o cleanup:

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

O baseline final coincidiu exatamente com o baseline inicial.

## Cleanup

O cleanup foi executado seletivamente, na ordem governada:

```text
publication_executions → candidate_assessment → candidate_evidence → candidates
```

Todas as operações usaram seleção limitada e `RETURNING`. Foram removidos um assessment, nove evidências e um candidato. A etapa de `publication_executions` retornou conjunto vazio, confirmando que nenhuma execução de publicação existia.

## Gates finais

```text
npm test: PASS
npx tsc --noEmit: PASS
npm run build: PASS
git diff --check: PASS
secret scan: PASS
/health: PASS
SHA live = commit: PASS
scope do commit: PASS
working tree rastreada: CLEAN
```

A suíte completa permaneceu aprovada no estado da Fase 10, com 1358 testes passando; os gates pós-prova retornaram código de saída zero.

## Decisão final e limitações

A Fase 11 está **PASS CONTROLADO**. A correção de provenance está live, a chamada oficial Shopee respondeu, o Evidence Bridge criou evidências reais, o candidato carregou `metadata.provenance="n10:discovery"`, N13 reconheceu a provenance, o replay foi idempotente e o baseline foi restaurado.

A prova não valida N14, N15, N16 ou N17. O resultado N13 `PASS` não autoriza qualquer etapa comercial posterior. N15 continua sendo a única autoridade para `APPROVED` e N16 continua sendo o executor exclusivo de publicação.

A execução deve parar neste ponto. Nenhuma Fase 12, N14, N15, N16 ou N17 deve ser iniciada automaticamente.
