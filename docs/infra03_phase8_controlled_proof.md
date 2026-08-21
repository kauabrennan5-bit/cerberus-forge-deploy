# INFRA-03 — Fase 8 — Prova Controlada Pós-Consolidação

## Status

**STATUS: PASS CONTROLADO — SHOPEE → EVIDENCE BRIDGE → N3 → N13**.

A integração validada localmente na Fase 6 foi consolidada somente nos dois arquivos autorizados, publicada no `origin/main` e disponibilizada no Render. Foi executada uma única prova real controlada com um item Shopee válido. O fluxo foi encerrado em N13; nenhuma etapa N14, N15, N16 ou N17 foi executada.

## Identificação

`PROOF_RUN_ID`: `INFRA03_PHASE8_PROOF_20260820T024600Z`

`SHA`: `9bbb7776a1b74dd8b3f737f614e64e8767890a94`

`SHA base`: `0ba60f2ad925109159f0daa924d8b9ca50d1f928`

O endpoint `/health` confirmou `status=ok` e o SHA live `9bbb7776a1b74dd8b3f737f614e64e8767890a94` após o deploy automático.

## Consolidação e escopo

O commit foi criado com a mensagem `feat(infra03): connect Shopee evidence bridge to research` e contém exatamente:

- `server/commercial/discovery/research.ts`
- `tests/researchService.test.ts`

Nenhum arquivo de N13, N14, N15, N16, N17, publicação, Telegram, scheduler, agents, catálogo canônico ou Mercado Livre foi alterado pelo commit. Relatórios e artefatos locais não rastreados permaneceram fora do commit.

## Prova real

Foi usado o anúncio Shopee com identidade direcionada `shop_id=1530442944` e `item_id=23794344926`. A API oficial retornou HTTP 200 e a operação observada foi `productOfferV2`.

A identidade foi confirmada exatamente:

- `item_id` solicitado: `23794344926`
- `item_id` retornado: `23794344926`
- `shop_id` solicitado: `1530442944`
- `shop_id` retornado: `1530442944`
- `response_digest`: presente, no formato `sha256:<digest>`, sem credenciais
- `observed_at`: timestamps UTC presentes nas evidências

O título foi persistido somente porque foi realmente observado pela resposta oficial. O preço permaneceu `UNKNOWN`, pois não foi retornado pela operação utilizada. Os demais campos ausentes permaneceram `UNKNOWN`, sem preenchimento inventado.

## Evidence bridge e candidate_evidence

A execução de N3 retornou HTTP 201 e criou uma sessão de pesquisa mais oito evidências de campo, totalizando nove registros vinculados ao candidato temporário.

As evidências de campo Shopee apresentaram `source_type=api`, `collection_method=API`, `observed_at` em UTC, `response_digest` e os metadados de identidade retornada. Os campos sem observação oficial permaneceram `field_state=UNKNOWN` com a nota `UNKNOWN_NOT_RETURNED_BY_OFFICIAL_SHOPEE_OPERATION`.

A sessão `RESEARCH_SESSION` preserva a semântica própria da sessão de pesquisa e foi registrada como `source_type=scrape` e `collection_method=SCRAPE` pelo contrato histórico da sessão; isso não altera a classificação das evidências de campo, que foram criadas pelo branch oficial Shopee com `source_type=api` e `collection_method=API`.

## Resultado N13

A rota de curadoria foi executada uma vez para o candidato temporário e retornou HTTP 200 com `outcome=evaluated`.

O veredicto real foi `PASS`, com `confidence=1`. A avaliação reconheceu nove evidências vinculadas, ausência de contradições, proveniência `n10:admin:manual`, estado de entrada `DISCOVERED/INTAKE`, identidade externa presente e URL Shopee válida.

O digest da avaliação foi produzido pelo sistema e não foi alterado ou fabricado. A curadoria foi estrutural e read-only em relação ao catálogo: nenhum produto, link ou publicação foi criado ou alterado.

## N14–N17 e ações proibidas

N14, N15, N16 e N17 não foram executados. Não houve score comercial, autorização N15, execução de publicação N16, affiliate link, Telegram, scheduler, agents, job_queue ou qualquer publicação real.

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

Durante a prova, os únicos registros temporários observados foram um candidato, nove evidências e uma avaliação. Produtos permaneceram em 13; affiliate links, job queue, publication executions e commercial cycles permaneceram em 0.

Baseline depois do cleanup:

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

## Cleanup

O cleanup foi seletivo e executado na ordem governada:

1. `publication_executions`: nenhum registro encontrado para o candidato da prova; nenhum registro removido.
2. `candidate_assessment`: avaliação N13 da prova removida com `RETURNING`.
3. `candidate_evidence`: nove evidências da prova removidas com `RETURNING`.
4. `candidates`: candidato temporário removido com `RETURNING`.

Não foi usado `TRUNCATE` nem DELETE amplo. O baseline pós-cleanup confirmou que não restou dado da prova.

## Gates

Todos os gates pré-commit e pós-prova passaram:

```text
npm test: PASS — 1354/1354
npx tsc --noEmit: PASS
npm run build: PASS
git diff --check: PASS
secret scan: PASS
health: PASS — status=ok
live SHA: PASS — 9bbb7776a1b74dd8b3f737f614e64e8767890a94
```

## Encerramento

A prova real controlada foi concluída com identidade Shopee confirmada, evidência de API preservada, campos ausentes mantidos como `UNKNOWN`, N13 consumindo a evidence e baseline restaurado. O código está consolidado e publicado no SHA informado. N17 permanece explicitamente não iniciado.

Não há commit, push ou deploy adicional pendente para esta etapa; nenhuma ação posterior de N14–N17 deve ser iniciada sem autorização específica.
