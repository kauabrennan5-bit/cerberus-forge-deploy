# INFRA-03 — FASE 21 — AUDITORIA DOCUMENTAL DE AVAILABILITY

**PROOF_RUN_ID:** `INFRA03_PHASE21_AVAILABILITY_CONTRACT_20260820T055210Z`  
**Autor:** Manus AI  
**Escopo:** investigação documental oficial, somente leitura, restrita a `availability` no contexto da operação Shopee Affiliate BR `productOfferV2`.

## STATUS

**BLOCKED — CONTRACT UNSPECIFIED**

## OBJETIVO E CRITÉRIO

O objetivo foi verificar se existe documentação oficial que defina, para a operação Affiliate BR GraphQL `productOfferV2`, um campo `availability` com nome, tipo, semântica e regra de interpretação suficientes para ser promovido a evidência comercial pelo N14.

A decisão `AVAILABLE` exigiria um contrato oficial específico da operação-alvo. Documentação de Seller/Open API, AMS, campanhas, terceiros ou exemplos comunitários não foi considerada substituta do contrato Affiliate BR.

## EVIDÊNCIA OFICIAL ENCONTRADA

A documentação oficial geral da Shopee Open Platform informa que o guia consultado se aplica às chamadas da **Shopee Open API v2.0** e descreve APIs públicas, de loja e de merchant.[1] Essa superfície é distinta da operação GraphQL Affiliate BR `productOfferV2` usada pelo Cerberus.

> “This guide only applies to making API calls for Shopee Open API v2.0.” — Shopee Open Platform, API calls.[1]

A documentação oficial `v2.product.get_item_base_info` pertence à API Seller/Open API REST e não constitui o contrato de `productOfferV2`.[2] Eventuais campos de estoque, status ou listagem encontrados nessa superfície não podem ser transportados por analogia para a operação Affiliate.

A documentação oficial AMS e a operação `v2.ams.get_open_campaign_added_product` também são superfícies distintas, voltadas à gestão de campanhas e produtos em campanha.[3] [4] Elas não definem um campo `availability` para `productOfferV2` Affiliate BR.

O portal oficial de afiliados BR foi acessado em `https://affiliate.shopee.com.br/api`, mas não disponibilizou, no acesso realizado, um schema textual público verificável para `productOfferV2`. A rota oficial `/open_api` também não produziu documentação pública extraível no ambiente de investigação. Essa limitação foi registrada como ausência de evidência, não como prova positiva de qualquer semântica.

As buscas restritas a domínios oficiais por `productOfferV2 availability`, `productOfferV2 stock` e variações correlatas retornaram páginas gerais da Open Platform e APIs Seller/AMS, mas nenhuma especificação oficial específica do campo `availability` em Affiliate BR `productOfferV2`.

## CAMPO, TIPO E SEMÂNTICA

Para o contrato oficial específico de `productOfferV2` Affiliate BR:

- **Nome do campo:** não comprovado.
- **Tipo:** não comprovado.
- **Semântica:** não comprovada.
- **Unidade:** não aplicável/não especificada.
- **Domínio de valores:** não comprovado.
- **Mapeamento para estoque disponível, indisponível, pausado ou status de anúncio:** não comprovado.
- **Regra de conversão para `IN_STOCK`, `OUT_OF_STOCK` ou `UNAVAILABLE`:** inexistente no material oficial localizado.

Não foi feita inferência a partir de nomes possíveis, campos de outras APIs, comportamento visual de marketplace, fixtures, exemplos não oficiais ou observações de chamadas anteriores.

## COMPARAÇÃO COM O CONTRATO LOCAL

O cliente local atual solicita e extrai um conjunto fechado de propriedades de `productOfferV2` que inclui identidade, nome, preço e links; `availability` não faz parte do selection set nem do parser local.[5]

O contrato interno `ShopeeProductLookupResult` também não possui uma propriedade tipada `availability`.[6] O Evidence Bridge mantém uma posição genérica para campos de evidência, inclusive `availability`, mas essa posição não cria um contrato Shopee-specific nem define tipo ou semântica para a operação Affiliate.[7]

O N14 possui suporte genérico para disponibilidade. A taxonomia local aceita `IN_STOCK`, `OUT_OF_STOCK`, `UNAVAILABLE` e `UNKNOWN`, com proveniência obrigatória para estados conhecidos.[8] O serviço N14 deriva sinal conhecido somente quando recebe `observed_availability` em um estado explicitamente mapeável; estados ausentes, diferentes ou não comprovados permanecem sem sinal comercial conhecido.[9]

Portanto, a capacidade genérica do N14 não é evidência de que a Shopee fornece `availability` nesse contrato. O caminho local está preparado para receber uma futura evidência, mas a fonte Affiliate BR não está contratualmente habilitada para alimentar essa dimensão.

## DECISÃO

**DECISION: NOT AVAILABLE**

`availability` não pode ser usado atualmente como evidência comercial proveniente de Shopee Affiliate BR `productOfferV2`.

A razão não é uma falha de normalização local. A dependência bloqueadora é a ausência de uma especificação oficial que estabeleça o campo, seu tipo e sua semântica na operação correta. A classificação operacional é, portanto:

> **BLOCKED — CONTRACT UNSPECIFIED**

Até que a Shopee publique ou forneça uma especificação oficial específica para essa operação, o Cerberus deve preservar `availability` como `UNKNOWN` para essa fonte e não deve ampliar o selection set, o parser, o Evidence Bridge ou o N14 por inferência.

## IMPACTO NO N14

O impacto é **nenhuma nova cobertura comercial Shopee em availability**. A dimensão continua disponível apenas para fontes que apresentem observação com semântica verificável, valor dentro do domínio fechado e proveniência adequada.

Se futuramente existir contrato oficial que defina um valor equivalente a estoque disponível e um valor equivalente a indisponibilidade, será necessária uma etapa posterior e autorizada para revisar o contrato local, mapear os valores de forma determinística, adicionar testes e somente então avaliar a conexão com o Evidence Bridge e o N14. Essa etapa não foi iniciada nesta Fase 21.

## ALTERAÇÕES E EXECUÇÃO

- Código alterado: **não**.
- Testes alterados: **não**.
- Banco alterado: **não**.
- Chamada real à Shopee: **não**.
- Scraping, proxy, browser como aquisição, introspection e endpoint alternativo: **não**.
- N13/N14/N15/N16/N17+: **não executados**.
- Commit: **não realizado**.
- Push: **não realizado**.
- Deploy: **não realizado**.

## GATES

Os gates não foram executados, pois a Fase 21 não autorizou alteração de código e nenhuma alteração funcional foi feita. Não houve necessidade de validar build ou testes para esta investigação exclusivamente documental.

## CONCLUSÃO

A investigação termina em **BLOCKED — CONTRACT UNSPECIFIED**. Não há evidência oficial suficiente para classificar `availability` como `AVAILABLE`, nem para definir nome, tipo, semântica ou normalização segura em `productOfferV2` Affiliate BR.

**N13+ permanecem não executados. Não avançar para outra dimensão nesta etapa.**

## REFERÊNCIAS

[1]: https://open.shopee.com/developer-guide/16 "API calls — Shopee Open Platform"
[2]: https://open.shopee.com/documents/v2/v2.product.get_item_base_info?module=89&type=1 "v2.product.get_item_base_info — Shopee Open Platform"
[3]: https://open.shopee.com/developer-guide/702 "Shopee AMS API Integration Guide"
[4]: https://open.shopee.com/documents/v2/v2.ams.get_open_campaign_added_product?module=127&type=1 "v2.ams.get_open_campaign_added_product — Shopee Open Platform"
[5]: ../server/commercial/affiliate/shopeeApiClient.ts "Cliente local Shopee Affiliate"
[6]: ../server/commercial/affiliate/shopeeClientContracts.ts "Contrato interno do cliente Shopee"
[7]: ../server/commercial/sources/shopee/contracts.ts "Contrato local do Shopee Evidence Bridge"
[8]: ../server/commercial/commercialBrain/contract.ts "Contrato de sinais do N14"
[9]: ../server/commercial/commercialBrain/service.ts "Serviço do N14 e derivação de availability"
