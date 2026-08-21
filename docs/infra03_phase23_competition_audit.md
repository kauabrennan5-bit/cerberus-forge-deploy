# INFRA-03 — FASE 23 — AUDITORIA DOCUMENTAL DE COMPETITION

**PROOF_RUN_ID:** `INFRA03_PHASE23_COMPETITION_AUDIT_20260820T060921Z`  
**Autor:** Manus AI  
**Escopo:** investigação documental oficial, somente leitura, restrita a `competition` no contexto da operação Shopee Affiliate BR GraphQL `productOfferV2`.

## STATUS

**BLOCKED — CONTRACT UNSPECIFIED**

**competition=NOT AVAILABLE**

## OBJETIVO E CRITÉRIO

A auditoria procurou uma especificação oficial da Shopee que, para a operação correta — Affiliate BR `productOfferV2` — prove simultaneamente a existência de um campo de competição, seu nome exato, tipo, semântica, domínio de valores, unidade ou escala quando aplicável, e uma transformação determinística para a representação aceita pelo N14.

Documentação de Seller API, AMS, campanhas ou outras operações foi considerada somente para delimitar superfícies. Nenhuma dessas superfícies foi reutilizada como contrato do Affiliate GraphQL.

## EVIDÊNCIA OFICIAL ENCONTRADA

O guia geral da Shopee Open Platform descreve a Shopee Open API v2.0 e suas próprias categorias de API.[1] Ele não publica o schema da operação Affiliate BR GraphQL `productOfferV2` nem define um campo `competition` para essa operação.

> “This guide only applies to making API calls for Shopee Open API v2.0.” — Shopee Open Platform, API calls.[1]

A documentação oficial AMS descreve campanhas abertas e direcionadas, dashboards de desempenho e sugestões de otimização. Ela menciona conceitos como `competitiveness scores` em sugestões de produtos/campanhas, incluindo sugestões para produtos com pontuação de competitividade inferior a um percentil da categoria.[2] Essa evidência pertence à superfície AMS/campaign e não prova o nome, tipo, semântica, domínio ou unidade de um campo `competition` em Affiliate BR `productOfferV2`.

A mesma documentação AMS lista operações específicas para campanhas, recomendações, comissões, períodos promocionais e métricas de desempenho.[2] Nenhuma delas é a operação GraphQL Affiliate BR alvo. Portanto, o conceito de competitividade no AMS não pode ser promovido a contrato de `productOfferV2`.

O portal público oficial do programa de afiliados BR foi acessado em `https://affiliate.shopee.com.br/`, mas o conteúdo retornado exigiu JavaScript e não disponibilizou schema textual verificável de `productOfferV2` ou `competition` no ambiente da auditoria.[3] Essa limitação foi registrada como ausência de evidência, não como prova positiva.

As buscas restritas a domínios oficiais por `productOfferV2 competition`, `productOfferV2 competition field` e variações retornaram o guia geral Open Platform, documentação Seller/Open API e AMS, mas nenhuma especificação oficial específica publicou `competition` para Affiliate BR `productOfferV2`.

## RESULTADO POR ELEMENTO CONTRATUAL

Para o alvo oficial Affiliate BR GraphQL `productOfferV2`:

- **Existência do campo:** não comprovada.
- **Nome exato:** não comprovado.
- **Tipo:** não comprovado.
- **Semântica:** não comprovada; não é possível distinguir competitividade de oferta, posição, concorrência, demanda, recomendação ou outro score interno.
- **Domínio de valores:** não comprovado.
- **Unidade ou escala:** não comprovada.
- **Regra de arredondamento ou normalização:** não encontrada.
- **Transformação segura para o N14:** não existe com base em contrato oficial do alvo.

Não foi inferido significado a partir de nomes semelhantes, métricas AMS, exemplos externos, páginas de marketplace, fixtures locais ou resultados de busca.

## COMPARAÇÃO COM O CONTRATO LOCAL

O cliente local Shopee Affiliate atual solicita no selection set de `productOfferV2` apenas `itemId`, `shopId`, `productName`, `price`, `productLink` e `offerLink`. Não há campo `competition` na query, no tipo interno `OfferNode` ou no parser.[4]

O contrato local do Evidence Bridge possui uma lista fechada de campos de evidência que inclui `title`, `price`, `images`, `seller`, `rating`, `review_count`, `availability` e `category`, mas não inclui `competition`.[5]

Essa ausência local é coerente com a decisão fail-closed: a integração não deve criar uma superfície de competição sem contrato oficial da fonte, sem semântica identificável e sem uma regra de normalização autorizada.

## IMPACTO NO N14

O contrato do N14 trata `competition` como dimensão comercial de primeira classe, mas somente quando baseada em evidência real e proveniente.[6] O normalizador local aceita apenas valor numérico finito maior ou igual a zero, acompanhado de fonte e proveniência válidas; entradas inválidas ou sem proveniência permanecem `UNKNOWN` e não são convertidas em zero.[7]

O serviço N14 não deriva `competition` da observação genérica do candidato. A política explícita exige evidência comercial real e proveniente para `commission`, `market` e `competition`, impedindo inferência automática a partir de candidato ou similaridade.[8]

Os pesos atuais atribuem `competition` peso `0.00`; quando desconhecida, a dimensão é excluída do score e `UNKNOWN` não equivale a zero.[9] Essa regra reduz o impacto numérico imediato, mas não transforma a ausência de contrato Shopee em evidência disponível nem autoriza qualquer implementação.

Consequentemente, `competition` proveniente de Shopee Affiliate BR permanece indisponível. O N14 somente poderia consumir essa dimensão no futuro se uma especificação oficial da operação alvo definisse o campo e sua semântica, e se o valor chegasse com proveniência verificável e transformação determinística.

## DECISÃO

**STATUS=BLOCKED — CONTRACT UNSPECIFIED**

**competition=NOT AVAILABLE**

Não existe documentação oficial suficiente para provar o contrato necessário. O conceito de `competitiveness score` encontrado na documentação AMS não é contrato de `productOfferV2` e não pode ser reutilizado para alimentar o N14.

## FONTES NÃO OFICIAIS REJEITADAS

Documentação comunitária, sites de terceiros, Stack Overflow, Apify, YouTube, Scribd, Facebook e `affiliateshopee.com.br` foram rejeitados como autoridade contratual. Podem conter relatos ou material auxiliar, mas não são a especificação oficial da operação Affiliate BR alvo.

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

A Fase 23 encerra em **BLOCKED — CONTRACT UNSPECIFIED**. Nenhuma implementação de `competition` está autorizada ou tecnicamente sustentada. O estado correto permanece `NOT AVAILABLE` para Shopee Affiliate BR `productOfferV2`.

A investigação não deve avançar automaticamente para N15, para outra dimensão ou para qualquer alteração de integração.

## REFERÊNCIAS

[1]: https://open.shopee.com/developer-guide/16 "API calls — Shopee Open Platform"
[2]: https://open.shopee.com/developer-guide/702 "Shopee AMS API Integration Guide"
[3]: https://affiliate.shopee.com.br/ "Shopee Affiliate Program BR"
[4]: ../server/commercial/affiliate/shopeeApiClient.ts "Cliente local Shopee Affiliate"
[5]: ../server/commercial/sources/shopee/contracts.ts "Contrato local do Shopee Evidence Bridge"
[6]: ../server/commercial/commercialBrain/contract.ts "Contrato de sinais do N14"
[7]: ../server/commercial/commercialBrain/normalizers.ts "Normalizador local de competition do N14"
[8]: ../server/commercial/commercialBrain/service.ts "Política de derivação de sinais do N14"
[9]: ../server/commercial/commercialBrain/weights.ts "Pesos do Commercial Brain"
