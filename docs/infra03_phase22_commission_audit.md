# INFRA-03 — FASE 22 — AUDITORIA DOCUMENTAL DE COMMISSION

**PROOF_RUN_ID:** `INFRA03_PHASE22_COMMISSION_AUDIT_20260820T055810Z`  
**Autor:** Manus AI  
**Escopo:** investigação documental oficial, somente leitura, restrita a `commission` no contexto da operação Shopee Affiliate BR GraphQL `productOfferV2`.

## STATUS

**BLOCKED — CONTRACT UNSPECIFIED**

**commission=NOT AVAILABLE**

## OBJETIVO E CRITÉRIO

A investigação procurou uma especificação oficial da Shopee que, para a operação correta — Affiliate BR `productOfferV2` — prove simultaneamente a existência do campo `commission`, seu tipo, unidade ou escala, eventual moeda ou percentual, semântica de negócio, domínio de valores e transformação determinística para a representação aceita pelo N14.

A documentação oficial de Seller API, AMS, campanhas ou outras operações não foi reutilizada como contrato do Affiliate GraphQL. A existência de conceitos de comissão nessas superfícies é insuficiente para autorizar qualquer mapeamento para `productOfferV2`.

## EVIDÊNCIA OFICIAL ENCONTRADA

O guia geral da Shopee Open Platform informa que se aplica às chamadas da **Shopee Open API v2.0** e descreve os tipos e parâmetros dessa plataforma.[1] Ele não publica o schema da operação Affiliate BR GraphQL `productOfferV2` nem define um campo `commission` para essa operação.

> “This guide only applies to making API calls for Shopee Open API v2.0.” — Shopee Open Platform, API calls.[1]

A documentação oficial AMS descreve uma superfície diferente, voltada à gestão de campanhas e parcerias de afiliados. Ela menciona `commission rate` em operações de Open Campaign, inclusive ao adicionar produtos, editar configurações e consultar produtos de campanha.[2] Essa evidência confirma apenas que AMS possui seus próprios conceitos e campos de comissão; não prova o nome, tipo, unidade, percentual, domínio ou semântica de `commission` no Affiliate BR `productOfferV2`.

A documentação oficial `v2.ams.get_open_campaign_added_product` também descreve uma operação AMS distinta, cujo resultado de campanha inclui status da campanha, commission rate e período de promoção.[3] Por estar vinculada a Open Campaign/AMS, ela foi usada somente para delimitar a fronteira de autoridade e não foi transportada para o contrato Affiliate.

O portal público oficial do programa de afiliados BR foi acessado em `https://affiliate.shopee.com.br/`, mas o conteúdo retornado exigiu JavaScript e não disponibilizou schema textual verificável de `productOfferV2` ou `commission` no ambiente da auditoria.[4] Essa limitação foi registrada como ausência de evidência, não como prova positiva.

As buscas restritas a domínios oficiais por `productOfferV2 commission`, `productOfferV2 commission rate` e variações retornaram o guia geral Open Platform, documentação Seller/Open API e documentação AMS, mas nenhuma especificação oficial específica publicou `commission` para Affiliate BR `productOfferV2`.

## RESULTADO POR ELEMENTO CONTRATUAL

Para o alvo oficial Affiliate BR GraphQL `productOfferV2`:

- **Existência do campo:** não comprovada.
- **Nome exato:** não comprovado.
- **Tipo:** não comprovado.
- **Unidade ou escala:** não comprovada.
- **Moeda:** não comprovada e potencialmente não aplicável se a comissão for percentual; a documentação do alvo não resolve essa questão.
- **Percentual ou fração:** não comprovado.
- **Semântica:** não comprovada; não é possível distinguir taxa do afiliado, taxa do vendedor, comissão promocional, valor fixo ou outra grandeza.
- **Domínio de valores:** não comprovado.
- **Regra de arredondamento:** não encontrada.
- **Transformação segura para o N14:** não existe com base em contrato oficial do alvo.

Não foi inferido significado a partir de nomes parecidos, taxas observadas em páginas, exemplos não oficiais, contratos de Seller API/AMS ou fixtures locais.

## COMPARAÇÃO COM O CONTRATO LOCAL

O cliente local Shopee Affiliate atual solicita no selection set de `productOfferV2` apenas `itemId`, `shopId`, `productName`, `price`, `productLink` e `offerLink`. Não há campo `commission` na query, no tipo interno `OfferNode` ou no parser.[5]

O contrato interno `ShopeeProductLookupResult` também não expõe `commission`.[6] O contrato atual do Evidence Bridge possui uma lista fechada de campos de evidência que inclui title, price, images, seller, rating, review_count, availability e category, mas não inclui commission.[7]

Essa ausência local é compatível com a decisão fail-closed: a integração não deve criar uma superfície de comissão sem um contrato oficial da fonte e sem uma regra de normalização autorizada.

## IMPACTO NO N14

O N14 suporta genericamente `commission` como dimensão comercial, mas com requisitos explícitos. O contrato do N14 descreve commission como percentual de comissão do provedor afiliado com proveniência.[8]

O normalizador local aceita somente um valor numérico finito no intervalo fechado `0..1`, interpretado como fração do preço, com fonte não vazia e proveniência válida. Ausência, valor inválido, valor fora do intervalo ou proveniência ausente permanecem `UNKNOWN`; o normalizador não converte lacunas em zero.[9]

O serviço N14 não deriva commission de observações genéricas do candidato. A dimensão exige evidência comercial real e proveniente, justamente para evitar que uma taxa não documentada seja promovida por analogia.[10]

Consequentemente, a cobertura comercial de commission proveniente de Shopee Affiliate BR permanece nula. O N14 continua capaz de consumir commission de uma fonte futura somente se houver contrato oficial que defina a grandeza, uma transformação determinística para fração `0..1` e proveniência verificável. Nenhuma dessas pré-condições foi satisfeita nesta Fase 22.

## DECISÃO

**STATUS=BLOCKED — CONTRACT UNSPECIFIED**

**commission=NOT AVAILABLE**

Não existe documentação oficial suficiente para provar o contrato necessário. A comissão não pode ser usada como evidência comercial de Shopee Affiliate BR `productOfferV2` e não pode alimentar o N14 por analogia com AMS, Seller API, exemplos externos ou valores visualmente observados.

## FONTES NÃO OFICIAIS REJEITADAS

Documentação comunitária, sites de terceiros, Stack Overflow, Apify, YouTube, Scribd, Facebook e `affiliateshopee.com.br` foram rejeitados como autoridade contratual. Podem conter informação auxiliar ou relatos de uso, mas não são a especificação oficial da operação Affiliate BR alvo e não sustentam uma mudança no contrato interno.

## ALTERAÇÕES E CONTROLES

- Código alterado: **não**.
- Parser alterado: **não**.
- Selection set alterado: **não**.
- Evidence Bridge alterado: **não**.
- N13/N14/pipeline alterados: **não**.
- Banco alterado: **não**.
- Chamada real à Shopee: **não**.
- Scraping, proxy, introspection e endpoint alternativo: **não**.
- Commit: **não realizado**.
- Push: **não realizado**.
- Deploy: **não realizado**.

## GATES

**NÃO EXECUTADOS**, conforme a regra da fase: não houve alteração de código. Não foram necessários `npm test`, `tsc`, build, `git diff --check` ou secret scan para esta investigação exclusivamente documental.

## N13+

**N13+=NOT_EXECUTED**

N13, N14, N15, N16, N17 e qualquer publicação permaneceram fora da execução.

## CONCLUSÃO E PRÓXIMO PASSO

A Fase 22 encerra em **BLOCKED — CONTRACT UNSPECIFIED**. Nenhuma implementação de commission está autorizada ou tecnicamente sustentada. O próximo passo possível depende de uma especificação oficial específica da Shopee Affiliate BR `productOfferV2`; sem ela, o estado correto permanece `NOT AVAILABLE` e `UNKNOWN` no plano comercial.

**Não avançar para N15 nem para outra dimensão nesta fase.**

## REFERÊNCIAS

[1]: https://open.shopee.com/developer-guide/16 "API calls — Shopee Open Platform"
[2]: https://open.shopee.com/developer-guide/702 "Shopee AMS API Integration Guide"
[3]: https://open.shopee.com/documents/v2/v2.ams.get_open_campaign_added_product?module=127&type=1 "v2.ams.get_open_campaign_added_product — Shopee Open Platform"
[4]: https://affiliate.shopee.com.br/ "Shopee Affiliate Program BR"
[5]: ../server/commercial/affiliate/shopeeApiClient.ts "Cliente local Shopee Affiliate"
[6]: ../server/commercial/affiliate/shopeeClientContracts.ts "Contrato interno do cliente Shopee"
[7]: ../server/commercial/sources/shopee/contracts.ts "Contrato local do Shopee Evidence Bridge"
[8]: ../server/commercial/commercialBrain/contract.ts "Contrato de sinais do N14"
[9]: ../server/commercial/commercialBrain/normalizers.ts "Normalizadores de sinais do N14"
[10]: ../server/commercial/commercialBrain/service.ts "Serviço do N14 e derivação de sinais"
