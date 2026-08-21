# N17/N14 Fase 11 — notas de auditoria web

## 2026-08-20 — Shopee Open Platform developer-guide/702

A URL oficial `https://open.shopee.com/developer-guide/702` foi aberta no navegador. A página permaneceu em estado de carregamento, sem elementos interativos ou conteúdo textual extraído. O título observado foi `Shopee Open Platform`. Não foi possível confirmar, por esta página, se o conteúdo se refere à API de Afiliados BR, AMS, Seller API ou outra superfície. Nenhum campo comercial foi promovido a contrato com base nesta visita.

Estado da evidência: `INCONCLUSIVE`.

## Evidência oficial adicional — Shopee AMS

Fonte oficial consultada: `https://open.shopee.com/developer-guide/702`.

A página identifica-se como `Shopee AMS` e descreve a Affiliate Marketing Solutions para vendedores, incluindo Open Campaigns, Targeted Campaigns, configurações de comissão, analytics e relatórios de conversão. Ela informa que as APIs listadas são AMS Open APIs e que exigem aplicações do tipo Affiliate Marketing Solution Management e autorização válida de loja. O texto não documenta a operação GraphQL de afiliados BR `productOfferV2` nem estabelece que os campos AMS possam ser usados como contrato dessa operação. Portanto, commission/analytics/validation desse documento não foram promovidos para cobertura de `productOfferV2`.

Classificação para o contrato `productOfferV2`: `OUT_OF_SCOPE_AS_CONTRACT` / não utilizável como prova direta da operação de Afiliados BR sem vínculo contratual oficial explícito.

## Busca oficial específica de Affiliate BR

A pesquisa por documentação oficial específica da Affiliate Open API BR encontrou a página pública do programa em `https://affiliate.shopee.com.br/`, mas não encontrou uma referência oficial pública que defina o schema e a semântica comercial de `productOfferV2`. Também foram encontrados resultados da Open Platform de Seller/AMS, que não foram tratados como contrato da Affiliate API. Resultados de terceiros foram rejeitados como autoridade contratual.

Estado atual da evidência documental: `BLOCKED — AFFILIATE PRODUCTOFFER V2 CONTRACT NOT LOCATED`.

## Página pública de Afiliados BR — observação direta

Fonte: `https://affiliate.shopee.com.br/`.

A página pública carregada no navegador identifica-se como `Programa de Criadores e Afiliados Shopee`, oferece seleção de idioma/país e expõe um link `Centro de Educação` para `https://drive.google.com/file/d/1vrS5rHMBFMsP8652IGtDBZ-7GYRGceL4/view`. Nenhum schema GraphQL, contrato da operação `productOfferV2`, tipo/unidade de `price`, disponibilidade, commission, market ou competition foi exposto no conteúdo público observado. A página foi tratada somente como portal informativo; não houve login, navegação autenticada ou chamada de API.

Classificação: `NO_PUBLIC_PRODUCTOFFER_V2_SCHEMA_OBSERVED`.

## Centro de Educação oficial — acesso limitado

Link encontrado na página oficial de Afiliados BR: `https://drive.google.com/file/d/1vrS5rHMBFMsP8652IGtDBZ-7GYRGceL4/view`.

A abertura redirecionou para a tela de autenticação do Google Drive, com solicitação de login/CAPTCHA. Nenhum conteúdo do material foi acessado. Não foi solicitado takeover nem inserida informação pessoal. O material permanece `NOT_VERIFIABLE_IN_CURRENT_SESSION`; não sustenta qualquer normalização.

## Runtime Render — snapshot público

Endpoint consultado: `https://cerberus-forge-deploy-backend.onrender.com/health`.

Observação: `HTTP=200`, `status=ok`, `service=cerberus-forge-deploy`, SHA servido `cf7225e6cd1d37f64ab164a56ffa65a66ce1fefe`. O timestamp observado foi registrado apenas como momento do health check; nenhuma variável de ambiente, credencial ou header sensível foi consultado.

## Open Platform Developer Guide — escopo distinto

Fonte oficial consultada: `https://open.shopee.com/developer-guide/16`.

A página abriu como `Shopee Open Platform` e não expôs conteúdo textual no primeiro carregamento. A busca que levou a ela a descreveu como guia de chamadas da Shopee Open API v2 e resultados relacionados a operações de produto Seller/Open Platform, não como documentação pública do schema Affiliate GraphQL `productOfferV2`. Sem conteúdo contratual verificável para a operação alvo, nenhum campo comercial foi promovido.

## Evidência textual oficial — Developer Guide 16

Fonte: `https://open.shopee.com/developer-guide/16` (última atualização indicada na página: 2025-11-21).

Trechos/observações relevantes:
- O guia declara expressamente: `This guide only applies to making API calls for Shopee Open API v2.0.`
- Lista domínios de produção da Open API (`openplatform.shopee.cn`, `openplatform.shopee.com.br`, `partner.shopeemobile.com`) e descreve APIs Shop, Merchant e Public.
- Define parâmetros comuns `partner_id`, `timestamp`, `sign`, `access_token`, `shop_id` e `merchant_id`, e assinatura HMAC-SHA256 para a Open API v2.
- O conteúdo apresenta exemplos de endpoints `/api/v2/...` Seller/Open API e não apresenta o endpoint GraphQL Affiliate BR nem a operação `productOfferV2`.

Conclusão: esta fonte oficial é útil para delimitar a Open API v2, mas não é contrato do GraphQL de Afiliados `productOfferV2`; os campos comerciais da operação alvo continuam sem especificação pública verificável nesta auditoria.

## Fonte alternativa oficialmente documentada — Seller/Open API v2

Fonte: `https://open.shopee.com/documents/v2/v2.product.get_item_base_info?module=89&type=1`.

Evidência observada:
- Operação oficial distinta: `GET /api/v2/product/get_item_base_info`.
- Descrição oficial: obtém informações básicas de itens por lista de `item_id`.
- O exemplo de resposta documenta `price_info[].currency`, `price_info[].original_price` e `price_info[].current_price`.
- O exemplo também documenta `stock_info_v2.summary_info.total_available_stock`, além de `seller_stock[].stock` e `shopee_stock[].stock`.
- O request utiliza `shop_id`, `access_token`, `partner_id`, `timestamp` e `sign`, indicando a superfície autenticada da Open API v2; a própria página fica sob o catálogo Product/Seller Open API, não sob o GraphQL Affiliate `productOfferV2`.

Classificação para a Fase 11:
- `price`: contrato de tipo/moeda e valor existe nesta operação alternativa; não é contrato do `productOfferV2`.
- `availability`: estoque disponível existe nesta operação alternativa; qualquer enumeração IN_STOCK/OUT_OF_STOCK ainda exigiria regra explícita de normalização e proveniência da consulta.
- `commission`, `market`, `competition`: não comprovados por esta fonte.
- Limitação decisiva: a operação é Seller/Open API autenticada e depende de autorização da loja/conta correspondente. Não é uma fonte pública geral para produtos Shopee de terceiros nem uma substituta automática do Affiliate API. Portanto, não foi integrada nem usada para promover sinais no N14.

## Snapshot operacional da Fase 11

O registro `affprv-shopee` foi confirmado no Supabase como provider único e ativo, com `provider_code=shopee`, `marketplace=Shopee`, `status=ACTIVE`, `provenance=admin:manual` e `resolution_method=MANUAL`. Nenhum campo de credencial foi consultado.

O baseline somente leitura observado foi: `products=14`, `candidates=0`, `candidate_evidence=0`, `candidate_assessment=0`, `affiliate_links=0`, `job_queue=0`, `publication_executions=0` e `commercial_cycles=0`.

O runtime Render respondeu `HTTP 200`, `status=ok`, serviço `cerberus-forge-deploy` e `version=cf7225e6cd1d37f64ab164a56ffa65a66ce1fefe`. O health público não expõe um campo denominado `sha`; o campo público de versão foi usado para identificar o commit servido.

## Decisão de implementação

Não foi implementado adapter ou normalização nesta fase. O contrato Affiliate BR público consultado não comprovou semântica suficiente para promover `price` string, `availability`, `commission`, `market` ou `competition` no `productOfferV2`. A Seller/Open API v2 oferece campos de preço/moeda/estoque em operação distinta, mas exige autorização da loja correspondente e não comprova identidade comercial do mesmo item para oportunidades Shopee de terceiros. Integrá-la como fallback geral violaria proveniência e identidade.

O adapter Mercado Livre presente no working tree também não é uma solução para esta fase: o próprio relatório INFRA-02 registra ausência de credencial real, integração não conectada a N3/N13 e necessidade de fase própria. Além disso, não há prova de identidade cross-market que permita transferir sinais de Mercado Livre para um produto Shopee.
