# INFRA-03 — Fase 16 — Diagnóstico de `price` no parser

**PROOF_RUN_ID:** `INFRA03_PHASE16_PRICE_PARSER_DIAGNOSIS_20260820T0449Z`  
**Status:** `BLOCKED — SOURCE COVERAGE`  
**SHA servido:** `305683c97af0f518ec3279a6044e250084db8042`

## Objetivo e escopo

Esta fase investigou localmente, em modo somente leitura, onde o campo `price` pode desaparecer entre a seleção GraphQL oficial `productOfferV2`, o transporte, o parser do cliente Shopee, os contratos internos e o Evidence Bridge. O escopo não incluiu nova chamada real, alteração de produção, deploy, persistência, N3/research, N13, N14, N15, N16, N17+ ou publicação.

## Sintoma real previamente observado

Na única prova real da Fase 15, a operação retornou `client_status=found`, HTTP 200, `item_id=23794344926` e `shop_id=1530442944` com correspondência exata, além de título observado. O campo `price` foi registrado como `UNKNOWN`. O artefato sanitizado não contém o corpo GraphQL bruto; portanto, ele demonstra o sintoma, mas não permite distinguir omissão do endpoint de incompatibilidade de shape no parser.

## Auditoria por camada

### Selection set GraphQL

A função `offerQueryBody()` solicita `itemId`, `shopId`, `productName`, `price`, `productLink` e `offerLink` dentro de `productOfferV2`. A seleção do campo `price` está presente no código servido pelo SHA desta fase. Isso prova que o cliente pede o campo, mas não prova que a API o retorna nem em qual shape.

### Transporte

O POST GraphQL assinado entrega o objeto JSON recebido diretamente ao parser. Não foi encontrado estágio de transporte que remova ou transforme `price`.

### Parser

`extractOfferNodes()` aceita somente `obj.price` quando `typeof obj.price === "number"`. Ausência do campo, valor string, objeto aninhado ou nome alternativo resultam em `price=null`. O parser localmente provado é, portanto, restrito ao shape numérico top-level.

### Contrato interno

`ShopeeProductLookupResult.priceMinorUnits` é `number | null`. O contrato modela o preço normalizado, mas não documenta shapes alternativos do payload GraphQL e não mantém um campo separado para o preço bruto observado.

### Evidence Bridge

O bridge promove `price` para `KNOWN` somente quando `priceMinorUnits` é número finito. Quando recebe esse número, gera `observed_fields.price`, campo `KNOWN`, unidade `minor_units`, digest e metadados de proveniência. Não há reparseamento do GraphQL no bridge. A evidência local indica que o bridge não é a camada que remove `price`.

### Fixtures e testes

Os testes principais usam `price` numérico top-level. Entretanto, `foundLookup()` fixa `priceMinorUnits=9900` enquanto `officialShopeeOfferBody()` padrão não inclui `price` no corpo GraphQL-shaped anexado. Assim, os fixtures podem simular preço normalizado sem provar que o raw continha `price`. Não há teste local para preço em string, objeto aninhado, nome alternativo ou corpo real redigido.

## Matriz de cobertura

`GRAPHQL_SELECTION_SET`: solicitado, confirmado localmente.  
`TRANSPORT`: JSON entregue ao parser, confirmado localmente.  
`PARSER`: somente número top-level, confirmado localmente.  
`CONTRACT`: `number | null`, confirmado localmente.  
`EVIDENCE_BRIDGE`: preserva número finito como `KNOWN`, confirmado localmente.  
`FIXTURES`: price normalizado pode existir sem price no raw do fixture, confirmado localmente.  
`REAL_RESPONSE_SHAPE`: não observável no artefato sanitizado, dependência externa.  
`PRICE_REAL_KNOWN`: não confirmado.

## Classificação da causa

**CAUSA_EXATA:** `INCONCLUSIVA — BLOCKED BY DEPENDENCY`.

Há três hipóteses compatíveis com os fatos, mas nenhuma deve ser promovida a causa exata: a API pode não ter retornado `price`; a API pode ter retornado `price` em shape diferente do parser; ou o campo pode ter sido retornado com nome/camada não modelados. O relatório não escolhe entre elas sem corpo GraphQL bruto redigido ou documentação oficial do shape efetivamente retornado.

## Decisão de mudança

**NÃO ALTERAR CÓDIGO.** A única alteração comprovada e já presente é solicitar `price` no selection set existente. Ampliar o parser para coerção de strings, objetos ou nomes alternativos seria inferência não autorizada e poderia transformar dado não confirmado em `KNOWN`. Não existe correção local comprovada nesta fase.

## Gates

`npm test`: PASS, 1358/1358.  
`npx tsc --noEmit`: PASS.  
`npm run build`: PASS.  
`git diff --check`: PASS.  
`secret scan`: o scan amplo sinalizou apenas `tests/jobQueueRepository.test.ts`, linha 365, como fixture de teste conhecido; o scan material excluindo esse fixture foi PASS. Nenhum valor foi exibido.  
`/health` primário: HTTP 200, versão `305683c97af0f518ec3279a6044e250084db8042`.  
`/health` alternativo: HTTP 200, mesma versão.

## Baseline somente leitura

### Antes

`products=13`  
`candidates=0`  
`candidate_evidence=0`  
`candidate_assessment=0`  
`affiliate_links=0`  
`job_queue=0`  
`publication_executions=0`  
`commercial_cycles=0`

### Depois

`products=13`  
`candidates=0`  
`candidate_evidence=0`  
`candidate_assessment=0`  
`affiliate_links=0`  
`job_queue=0`  
`publication_executions=0`  
`commercial_cycles=0`

O baseline permaneceu idêntico. Nenhuma mutação de banco foi executada.

## Limitações e próximos dados necessários

A limitação decisiva é a ausência do corpo GraphQL bruto da única prova real. Para resolver a causa em uma fase posterior, será necessário um mecanismo de observabilidade sanitizada, autorizado e sem persistência, que revele apenas a presença e o shape de `price`, nunca credenciais, Authorization ou payload integral. Não se deve fazer nova chamada nesta fase nem procurar outro endpoint/campo como substituição.

## Decisão final

**Fase 16 encerrada como `BLOCKED — SOURCE COVERAGE`.** Nenhuma chamada real foi executada nesta fase. Nenhum commit, push ou deploy foi realizado. N13, N14, N15, N16 e N17+ não foram executados. O trabalho deve parar aqui até autorização explícita de uma fase posterior.
