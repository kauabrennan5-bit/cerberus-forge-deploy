# Fase 12 — Evidências externas persistentes

Data: 2026-08-20.

## Shopee Affiliate BR

URL acessada: https://affiliate.shopee.com.br/

A página oficial pública do programa de Afiliados Shopee BR foi aberta no navegador. O carregamento terminou em redirecionamento para `https://shopee.com.br/verify/traffic/error?...` com HTTP 403 Forbidden. Nenhum schema privado, contrato autenticado, campo comercial, token, cookie, conteúdo de conta ou configuração de afiliado foi exposto. Não houve login, takeover, submissão de formulário, scraping ou bypass.

Conclusão: a sessão de navegador disponível não tornou verificável um contrato autenticado de `productOfferV2`.

## Shopee Open Platform / Seller API

URL oficial consultada: https://open.shopee.com/developer-guide/16

A documentação é da Open API v2 e seus domínios de Seller/Open Platform, não uma especificação pública do GraphQL Affiliate `productOfferV2`.

URL oficial consultada: https://open.shopee.com/documents/v2/v2.product.get_item_base_info?module=89&type=1

A documentação oficial de `v2.product.get_item_base_info` descreve uma operação Seller/Open API distinta, com campos de preço em `price_info` (`currency`, `original_price`, `current_price`) e estoque em `stock_info_v2.summary_info.total_available_stock`, além de requisitos de autorização da loja/conta correspondente. Esses campos não foram tratados como fonte afiliada geral nem integrados, porque o ambiente não apresentou credenciais OAuth Seller, escopo de autorização, vínculo de propriedade da loja ou prova de identidade cross-market para o mesmo `source_product_id/source_shop_id`.

Conclusão: Seller/Open API v2 é uma fonte oficial alternativa potencial apenas para uma fase separada, com acesso legítimo à loja correspondente. Não resolve por si só `commission`, `competition` ou `market` e não autoriza fallback nesta Fase 12.

## Código e snapshot anexado

O ZIP `/home/ubuntu/upload/cerberus-forge-deploy-main10.zip` foi extraído somente para auditoria em `/home/ubuntu/phase12_attachment/cerberus-forge-deploy-main`. O snapshot não contém configuração Seller/Open API, OAuth Seller, `price_info`, `stock_info`, `product.get_item` ou contrato de comissão/competição/mercado. Ele contém apenas o cliente Affiliate e a operação `productOfferV2` já conhecida.

Fontes não oficiais, Seller API de outra conta, Mercado Livre, scraping, inferência visual e documentação comunitária não são autoridade para promover sinais comerciais de uma oportunidade Shopee.
