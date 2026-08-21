# INFRA-03 — Fase 14 — Validação real do campo `price`

**PROOF_RUN_ID:** `INFRA03_PHASE14_PRICE_VALIDATION_20260820T0419Z`

**STATUS:** `SKIPPED — DEPENDÊNCIA EXTERNA`

## Objetivo e escopo

A fase foi delimitada à validação de uma única chamada real da operação existente `productOfferV2`, usando o item Shopee `item_id=23794344926` e `shop_id=1530442944`, para verificar se o campo `price` é aceito e efetivamente retornado.

O escopo proibiu persistência em `candidates`, `candidate_evidence` ou `candidate_assessment`, execução de N13–N17, publicação, `generateShortLink`, nova operação GraphQL, introspection, scraping, proxy, cookies, User-Agent spoofing, commit, push e deploy.

## Preflight

O SHA servido pelo backend foi `7fd48567753bec51186db1ceb423fbc726931c51`.

O endpoint primário `/health` respondeu HTTP 200 no preflight. Durante o gate final, o hostname primário apresentou uma falha transitória de TLS (`HTTP 000`); a verificação pelo domínio alternativo oficial do mesmo serviço respondeu HTTP 200. Nenhuma conclusão sobre o campo `price` foi extraída do health check.

O SHA servido é o commit consolidado anterior. A inclusão de `price` permanece somente no working tree local da Fase 13 e não foi commitada nem deployada. Portanto, uma chamada ao endpoint de produção neste momento não validaria o selection set local que inclui `price`.

As variáveis foram verificadas somente por presença no runtime local autorizado para a execução:

`SHOPEE_APP_ID=ABSENT`

`SHOPEE_APP_SECRET=ABSENT`

`SHOPEE_AFFILIATE_APP_ID=ABSENT`

`SHOPEE_AFFILIATE_APP_SECRET=ABSENT`

`SHOPEE_AFFILIATE_API_BASE_URL=ABSENT`

Nenhum valor de credencial, assinatura ou header de autorização foi impresso.

A configuração disponível não ofereceu um connector Render habilitado nem um mecanismo autorizado para executar o cliente modificado dentro do runtime de produção. Não foi feita alteração de connector.

## Request planejado

A chamada planejada seria exatamente uma invocação read-only de `ShopeeApiClient.lookupProduct()` para:

`item_id=23794344926`

`shop_id=1530442944`

A operação interna usa o endpoint oficial configurado e a query GraphQL existente `productOfferV2`, com `price` incluído no selection set local pela alteração da Fase 13.

A chamada não foi executada. Consequentemente, não houve HTTP status da API Shopee, `client status`, item retornado, shop retornado, identidade, título, preço, `response_digest` ou `observed_at` provenientes de uma observação real nesta fase.

## Razão do bloqueio

A dependência externa é dupla e objetiva:

1. O runtime local autorizado não possui as credenciais Shopee.
2. O runtime de produção saudável ainda serve o SHA anterior, sem a alteração local do selection set, e não existe uma rota read-only autorizada que exponha diretamente `lookupProduct()` sem persistir evidência ou acionar o caminho de aquisição.

Usar a rota N3/research violaria o escopo porque persiste `candidate_evidence`. Usar a rota de aquisição poderia entrar em semântica de aquisição e `generateShortLink`, também proibida. Fazer deploy para disponibilizar a mudança no Render foi explicitamente proibido.

Por essas razões, não seria legítimo fabricar uma chamada, redirecionar a prova para outro fluxo ou declarar `price=UNKNOWN` como se tivesse sido observado. `price=UNKNOWN` só pode ser registrado para uma resposta real que não contenha o campo; neste caso o estado correto é `NOT_OBSERVED — CALL_SKIPPED`.

## Proveniência

Não houve observação externa nesta fase.

O único artefato técnico local foi a query já modificada na Fase 13, em:

`server/commercial/affiliate/shopeeApiClient.ts`

A proveniência potencial da futura observação, caso a prova seja autorizada e o runtime esteja disponível, será:

`source_type=api`

`collection_method=API`

`operation=productOfferV2`

`marketplace=Shopee`

`identity=(shop_id=1530442944,item_id=23794344926)`

`price=KNOWN` somente se o valor estiver efetivamente presente e normalizado pelo cliente.

Nenhum valor foi promovido para `KNOWN` nesta fase. Nenhum digest foi calculado para uma resposta inexistente.

## Gates

`npm test`: PASS — 1358 testes, 1358 pass, 0 fail, 0 skipped.

`npx tsc --noEmit`: PASS.

`npm run build`: PASS. O build obteve 13 produtos da projeção canônica e gerou os artefatos locais.

`git diff --check`: PASS.

`secret scan material`: PASS. O fixture conhecido previamente classificado foi excluído somente da heurística ampla; nenhum segredo foi exibido ou alterado.

`/health`: PASS no preflight pelo hostname primário, HTTP 200. No final, hostname primário teve falha transitória de TLS; domínio alternativo oficial do mesmo serviço respondeu HTTP 200.

## Baseline somente leitura

Baseline antes da prova:

`products=13`

`candidates=0`

`candidate_evidence=0`

`candidate_assessment=0`

`affiliate_links=0`

`job_queue=0`

`publication_executions=0`

`commercial_cycles=0`

Baseline depois da prova/gates:

`products=13`

`candidates=0`

`candidate_evidence=0`

`candidate_assessment=0`

`affiliate_links=0`

`job_queue=0`

`publication_executions=0`

`commercial_cycles=0`

Não houve INSERT, UPDATE ou DELETE.

## N13–N17 e publicação

N13: `NÃO EXECUTADO`.

N14: `NÃO EXECUTADO`.

N15: `NÃO EXECUTADO`.

N16: `NÃO EXECUTADO`.

N17+: `NÃO EXECUTADO`.

Publicação: `NÃO EXECUTADA`.

`generateShortLink`: `NÃO EXECUTADO`.

## Decisão final

`DECISION=SKIPPED — DEPENDÊNCIA EXTERNA`

`REAL_PRODUCT_OFFER_V2_CALL=0`

`PRICE=NOT_OBSERVED — CALL_SKIPPED`

`IDENTITY=NOT_OBSERVED`

`RESPONSE_DIGEST=NOT_APPLICABLE`

`PROVENANCE=NOT_APPLICABLE_FOR_REAL_OBSERVATION`

A Fase 14 foi encerrada após o preflight, sem tentativa alternativa e sem avanço automático. Não houve commit, push ou deploy. Nenhuma fase posterior deve ser iniciada sem nova autorização explícita e sem disponibilizar um runtime autorizado que contenha as credenciais e execute exatamente o cliente oficial com a alteração de `price`.

## Referências operacionais

[1]: https://open.shopee.com/developer-guide/16 "Shopee Open Platform Developer Guide"
[2]: https://shopee.com.br/product/1530442944/23794344926 "Item Shopee usado como identidade controlada da prova"
