# INFRA-03 — FASE 24 — AUDITORIA DOCUMENTAL DE MARKET

**PROOF_RUN_ID:** `INFRA03_PHASE24_MARKET_AUDIT_20260820T061308Z`  
**Autor:** Manus AI  
**Escopo:** investigação documental oficial, somente leitura, restrita a `market` no contexto da operação Shopee Affiliate BR GraphQL `productOfferV2`.

## STATUS

**BLOCKED — CONTRACT UNSPECIFIED**

**market=NOT AVAILABLE**

## OBJETIVO E CRITÉRIO

A auditoria procurou uma especificação oficial da Shopee que, para a operação correta — Affiliate BR `productOfferV2` — prove a existência de um campo ou proxy de mercado, seu nome exato, tipo, semântica, domínio de valores, unidade ou escala quando aplicável, e transformação determinística para a representação aceita pelo N14.

A investigação também verificou se vendas, reviews, comentários, ranking, views, preço, posição ou outra métrica poderiam ser usados como proxy oficial de `market`. Nenhum proxy foi aceito sem documentação específica da operação alvo.

## EVIDÊNCIA OFICIAL ENCONTRADA

O guia geral da Shopee Open Platform descreve a Shopee Open API v2.0 e suas próprias categorias de API.[1] Ele não publica o schema da operação Affiliate BR GraphQL `productOfferV2` nem define um campo ou proxy `market` para essa operação.

> “This guide only applies to making API calls for Shopee Open API v2.0.” — Shopee Open Platform, API calls.[1]

A documentação oficial `v2.product.search_item` pertence à Seller/Open API e descreve a operação REST `/api/v2/product/search_item`.[2] Sua existência não comprova que a operação Affiliate BR `productOfferV2` retorne um campo de mercado, ranking, vendas, views ou qualquer métrica equivalente.

A documentação oficial `v2.product.get_comment` também pertence à Seller/Open API e descreve a operação REST `/api/v2/product/get_comment`, voltada à obtenção de comentários por `shop_id`, `item_id` ou `comment_id`.[3] Comentários ou reviews dessa API não constituem proxy oficial de `market` para o Affiliate BR `productOfferV2`; não foi realizada qualquer transformação entre as superfícies.

O portal público oficial do programa de afiliados BR foi acessado em `https://affiliate.shopee.com.br/`, mas o conteúdo retornado exigiu JavaScript e não disponibilizou schema textual verificável de `productOfferV2`, `market`, vendas, reviews, ranking, views ou outro proxy no ambiente da auditoria.[4] Essa limitação foi registrada como ausência de evidência, não como prova positiva.

As buscas restritas a domínios oficiais por `productOfferV2 market`, `productOfferV2 market proxy`, `productOfferV2 sales reviews ranking` e variações retornaram o guia geral Open Platform, endpoints Seller/Open API e o portal Affiliate BR, mas nenhuma especificação oficial específica publicou `market` ou um proxy de mercado para Affiliate BR `productOfferV2`.

## RESULTADO POR ELEMENTO CONTRATUAL

Para o alvo oficial Affiliate BR GraphQL `productOfferV2`:

- **Existência de campo `market`:** não comprovada.
- **Existência de proxy oficial de mercado:** não comprovada.
- **Nome exato:** não comprovado.
- **Tipo:** não comprovado.
- **Semântica:** não comprovada; não é possível distinguir demanda, popularidade, vendas, tendência, ranking, concorrência, visibilidade ou outra grandeza.
- **Domínio de valores:** não comprovado.
- **Unidade ou escala:** não comprovada.
- **Janela temporal:** não comprovada.
- **Regra de agregação, arredondamento ou normalização:** não encontrada.
- **Transformação segura para o N14:** não existe com base em contrato oficial do alvo.

Não foi inferido `market` a partir de vendas, reviews, ranking, views, comentários, preço, posição, popularidade visual, páginas de marketplace ou qualquer outro proxy não documentado.

## COMPARAÇÃO COM O CONTRATO LOCAL

O cliente local Shopee Affiliate atual solicita no selection set de `productOfferV2` apenas `itemId`, `shopId`, `productName`, `price`, `productLink` e `offerLink`. Não há campo `market` nem proxy de mercado na query, no tipo interno `OfferNode` ou no parser.[5]

O contrato local do Evidence Bridge possui uma lista fechada de campos de evidência que inclui `title`, `price`, `images`, `seller`, `rating`, `review_count`, `availability` e `category`, mas não inclui `market`.[6]

Essa ausência local é coerente com a decisão fail-closed: a integração não deve criar uma superfície de mercado sem contrato oficial da fonte, sem definição de janela/semântica e sem uma regra de normalização autorizada.

## IMPACTO NO N14

O contrato do N14 descreve `market` como proxy de mercado somente quando houver evidência real e proveniente, com exemplos como `review_count` comprovado ou `sales_report` de API oficial.[7] Esses exemplos são requisitos conceituais do N14 e não constituem prova de que a Shopee Affiliate BR `productOfferV2` forneça qualquer um deles.

O normalizador local aceita somente valor numérico finito maior ou igual a zero, acompanhado de fonte e proveniência válidas; entradas inválidas ou sem proveniência permanecem `UNKNOWN` e não são convertidas em zero.[8]

O serviço N14 não deriva `market` de observações genéricas do candidato. A política exige evidência comercial real e proveniente para `commission`, `market` e `competition`, impedindo inferência automática a partir de candidato, reviews não vinculados, ranking, preço ou similaridade.[9]

O motor de scoring possui transformação interna para um sinal de market já validado, mas isso não resolve a semântica da fonte: uma função matemática sobre um número não documentado não cria contrato, unidade, janela temporal ou proveniência.[10] O peso do market no N14 é secundário à validação da origem e da semântica, e não autoriza a promoção de qualquer proxy.[11]

Consequentemente, `market` proveniente de Shopee Affiliate BR permanece indisponível. O N14 somente poderia consumir essa dimensão no futuro se uma especificação oficial da operação alvo definisse um campo/proxy, sua semântica, domínio e período, e se o valor chegasse com proveniência verificável e transformação determinística.

## DECISÃO

**STATUS=BLOCKED — CONTRACT UNSPECIFIED**

**market=NOT AVAILABLE**

Não existe documentação oficial suficiente para provar o contrato necessário. Vendas, reviews, comentários, ranking, views, preço e outras métricas de Seller/Open API não podem ser reutilizados como proxy de `market` em Affiliate BR `productOfferV2`.

## FONTES NÃO OFICIAIS REJEITADAS

Documentação comunitária, sites de terceiros, Stack Overflow, Apify, YouTube, Scribd, Facebook, Similarweb e `affiliateshopee.com.br` foram rejeitados como autoridade contratual. Podem conter relatos, analytics ou material auxiliar, mas não são a especificação oficial da operação Affiliate BR alvo.

## ALTERAÇÕES E CONTROLES

- Código alterado: **não**.
- Selection set alterado: **não**.
- Parser alterado: **não**.
- Evidence Bridge alterado: **não**.
- N13/N14/pipeline alterados: **não**.
- Banco alterado: **não**.
- Chamada real à Shopee: **não**.
- Scraping, proxy, introspection e endpoint alternativo: **não**.
- Commit: **não realizado**.
- Push: **não realizado**.
- Deploy: **não realizado**.

## GATES

**NÃO NECESSÁRIOS E NÃO EXECUTADOS**, pois não houve alteração de código, conforme autorização da fase.

## N13+

**N13+=NOT_EXECUTED**

N13, N14, N15, N16, N17 e qualquer publicação permaneceram fora da execução. A auditoria não iniciou N15.

## CONCLUSÃO E PRÓXIMO PASSO

A Fase 24 encerra em **BLOCKED — CONTRACT UNSPECIFIED**. Nenhuma implementação de `market` está autorizada ou tecnicamente sustentada. O estado correto permanece `NOT AVAILABLE` para Shopee Affiliate BR `productOfferV2`.

A investigação não deve avançar automaticamente para N15, para outra dimensão ou para qualquer alteração de integração.

## REFERÊNCIAS

[1]: https://open.shopee.com/developer-guide/16 "API calls — Shopee Open Platform"
[2]: https://open.shopee.com/documents/v2/v2.product.search_item?module=89&type=1 "v2.product.search_item — Shopee Open Platform"
[3]: https://open.shopee.com/documents/v2/v2.product.get_comment?module=89&type=1 "v2.product.get_comment — Shopee Open Platform"
[4]: https://affiliate.shopee.com.br/ "Shopee Affiliate Program BR"
[5]: ../server/commercial/affiliate/shopeeApiClient.ts "Cliente local Shopee Affiliate"
[6]: ../server/commercial/sources/shopee/contracts.ts "Contrato local do Shopee Evidence Bridge"
[7]: ../server/commercial/commercialBrain/contract.ts "Contrato de sinais do N14"
[8]: ../server/commercial/commercialBrain/normalizers.ts "Normalizador local de market do N14"
[9]: ../server/commercial/commercialBrain/service.ts "Política de derivação de sinais do N14"
[10]: ../server/commercial/commercialBrain/engine.ts "Motor de scoring do N14"
[11]: ../server/commercial/commercialBrain/weights.ts "Pesos do Commercial Brain"
