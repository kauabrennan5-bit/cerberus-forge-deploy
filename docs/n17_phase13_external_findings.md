# Fase 13 — Achados externos e contratuais

## Shopee Affiliate BR

Fonte oficial do endpoint usado pelo cliente local:
`https://open-api.affiliate.shopee.com.br/graphql`

Operação: `productOfferV2`.

A prova real anterior, registrada em `docs/infra03_phase17_price_shape_probe.md`, observou HTTP 200, identidade exata para item/shop consultados e `price_present=true` com `price_type=string`. O valor bruto não foi preservado nem exposto; unidade, moeda e escala não foram comprovadas.

## Shopee Open API v2 — fonte alternativa oficial

Fonte: `https://open.shopee.com/documents/v2/v2.product.get_item_base_info?module=89&type=1`

A documentação oficial da operação Seller/Open API `v2.product.get_item_base_info` descreve campos de `price_info`, incluindo `currency`, `original_price` e `current_price`, e de `stock_info_v2`, incluindo `total_available_stock`. A operação pertence à família Seller/Open API v2, não ao contrato Affiliate GraphQL `productOfferV2`. O uso exige `shop_id`, `item_id`, assinatura e `access_token` associado à autorização correspondente da loja.

Limitação decisiva: o ambiente autorizado da Fase 13 não possui adapter, OAuth/access token Seller ou prova de que o operador controla o mesmo `source_shop_id` da oportunidade Affiliate. Não é permitido usar a operação Seller/Open API para preencher uma oportunidade Affiliate de terceiro sem vínculo de identidade e autorização. A documentação consultada também não fornece contrato para `commission`, `market` ou `competition` da mesma oportunidade Affiliate.

## Estado da operação

Nenhum campo adicional do schema Affiliate foi promovido sem observação e contrato. `UNKNOWN` permanece `UNKNOWN`. N17/N8/N6 não foram chamados sem `N15 APPROVED / ACQUIRE_AFFILIATE`.
