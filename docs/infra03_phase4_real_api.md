# INFRA-03 — FASE 4 — PRIMEIRA PROVA REAL SHOPEE

## PROOF_RUN_ID

`INFRA03_SHOPEE_REAL_20260820T023000Z`

## Status final

**SUCCESS — SHOPEE API REAL VALIDADA**

A chamada real ao `ShopeeApiClient` retornou uma observação compatível com `productOfferV2`, com identidade exata para o par `item_id`/`shop_id` conhecido. Esta conclusão comprova somente a coleta pela fonte oficial Shopee e a resolução do item pelo cliente; não representa aprovação de N13, pontuação N14, decisão N15 ou publicação N16.

## Ambiente da prova

Serviço Render: `srv-d9tq9sh42hec738skftg`.

SHA live: `44a31d687ae06d2398e6651ad1009eacfbeefbd`.

O cliente foi executado no Shell do serviço Render após a confirmação de que as credenciais estavam visíveis ao runtime. Nenhum valor de credencial foi exibido.

## Pré-tentativa sem chamada de rede

A primeira versão do script temporário tentou importar a ponte `server/commercial/sources/shopee/adapter.ts` pelo caminho do SHA live. A execução terminou antes de qualquer request com `ERR_MODULE_NOT_FOUND`, porque esse diretório não está presente no SHA live.

Essa pré-tentativa não contou como chamada Shopee. Não houve request, persistência ou geração de link nessa execução.

A ausência da ponte no SHA live é uma divergência de consolidação: a ponte existe no working tree local não consolidado, mas não está disponível no artefato publicado. Nenhuma correção foi feita nesta prova.

## Única chamada real

Foi executada exatamente **uma** chamada de rede pelo `ShopeeApiClient.lookupProduct` do SHA live.

A operação lógica foi `productOfferV2` no endpoint GraphQL oficial BR padrão:

`https://open-api.affiliate.shopee.com.br/graphql`

O script não chamou `generateShortLink`, não chamou rota de aquisição e não persistiu nenhum link.

### Request observacional

`item_id`: `23794344926`

`shop_id`: `1530442944`

### Resultado observacional

`client_status`: `found`

`http_status`: `UNKNOWN` no resultado exposto pelo cliente live. O caminho de sucesso do cliente publicado não retornou o campo HTTP status; nenhum status foi inventado ou convertido em 200.

`returned_item_id`: `23794344926`

`returned_shop_id`: `1530442944`

`item_id_exact`: `true`

`shop_id_exact`: `true`

`identity_confirmed`: `true`

`title`: `Porta Talher Madeira Nobre Vidro Organizador Multiuso Robusto Mesa Posta Decoraçao Cozinha Hotelaria`

`price_minor_units`: `UNKNOWN`/`null`, pois não foi retornado pelo cliente nessa resposta.

`product_link`: `https://shopee.com.br/product/1530442944/23794344926`

`api_call_count`: `1`

`client_error`: `null`

## Provenance

A ponte existente foi executada localmente, sem rede, sobre a resposta observacional já capturada. Isso permitiu verificar a normalização determinística sem repetir a chamada Shopee e sem persistir a evidência.

`source_type`: `api`

`collection_method`: `API`

`marketplace`: `SHOPEE`

`external_listing_id`: `23794344926`

`shop_id`: `1530442944`

`observed_at`: `2026-08-20T01:35:46.000Z`, timestamp de observação usado na normalização local a partir do registro de execução do Shell. O cliente live não emitiu timestamp de wire separado.

`http_status`: `UNKNOWN`/`null`, conforme retorno do cliente no caminho de sucesso.

`endpoint`: `affiliate_graphql`

`operation`: `productOfferV2`

`field_state`: `KNOWN` para a evidência normalizada, com os campos efetivamente observados preservados e os demais não retornados mantidos como `null`.

## Response digest

A ponte gerou, em memória e sem persistência, o seguinte digest seguro sobre os dados observacionais normalizados:

`sha256:b5449a992a26d8df39de9f57dd9e8bbd4a3eaf08d6e38b2983f6e699e54e38d0`

O digest não contém App ID, App Secret, Authorization, Signature, tokens, headers sensíveis ou payload secreto bruto.

## Resultado da ponte

`state`: `SUCCESS`

A evidência foi apenas construída em memória para validação. Não foi executado INSERT, UPDATE ou DELETE. Nenhum `candidate_id` ou `research_id` real foi criado ou utilizado para persistência; os identificadores do script de normalização foram marcadores descartáveis de prova.

A ponte normalizou oito campos observacionais. O título e o product link foram observados; preço, imagens, seller, rating, review_count, availability e category permaneceram `null` quando não foram retornados.

## Banco — somente leitura

Baseline pós-prova:

`products=13`

`candidates=0`

`candidate_evidence=0`

`candidate_assessment=0`

`affiliate_links=0`

`job_queue=0`

`publication_executions=0`

`commercial_cycles=0`

Nenhuma operação de escrita foi executada.

## Isolamento e integridade

N13 não foi acionado.

N14 não foi acionado.

N15 não foi acionado.

N16 não foi acionado.

N17 não foi iniciado.

Nenhum candidato, assessment, evidence persistida, affiliate link, publicação ou job foi criado.

Nenhum produto canônico foi alterado.

Nenhum commit, push ou deploy foi executado.

Os scripts temporários no Shell Render foram removidos ao final da prova.

## Pendência técnica explicitamente registrada

O SHA live não contém `server/commercial/sources/shopee/adapter.ts` nem os contratos da ponte da Fase 2. Portanto, a chamada real validou o cliente oficial publicado, enquanto a ponte foi validada de forma pura e local sobre a observação real capturada. A integração da ponte no artefato publicado permanece pendente de consolidação autorizada e não foi feita nesta fase.

## Critério de parada

A Fase 4 foi encerrada após uma única chamada real. Não iniciar Fase 5, não conectar ao N13, não alterar código, não fazer commit/push/deploy e não iniciar N17.
