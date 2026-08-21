# INFRA-03 — FASE 20 — AUDITORIA DE COBERTURA COMERCIAL

**PROOF_RUN_ID:** `INFRA03_PHASE20_COMMERCIAL_COVERAGE_20260820T054320Z`  
**Data da auditoria:** 2026-08-20 05:43:20 UTC  
**Status:** `READY FOR REVIEW — AUDITORIA LOCAL CONCLUÍDA`

## Escopo e limites

A auditoria verificou, exclusivamente por inspeção local e documental, se a integração oficial Shopee Affiliate BR baseada em `productOfferV2` possui cobertura comercial adicional para `availability`, `seller`, `commission`, `competition` ou `market`.

Nenhuma chamada real à Shopee foi realizada. Não houve scraping, proxy, browser como mecanismo de aquisição, introspection, endpoint alternativo, criação de probe, escrita em banco, alteração de código, alteração de N3/N13/N14/N15/N16/N17, commit, push ou deploy.

A decisão da Fase 19 sobre `price` permanece intacta: o `price` string continua `UNKNOWN` e não pode ser convertido sem contrato oficial de unidade, moeda, escala e arredondamento.

## Evidência do payload atualmente solicitado

O cliente local constrói a query `productOfferV2` com o selection set fechado:

```graphql
productOfferV2(itemId, shopId, limit: 1) {
  nodes {
    itemId
    shopId
    productName
    price
    productLink
    offerLink
  }
}
```

A implementação está em `server/commercial/affiliate/shopeeApiClient.ts:189-200`. O contrato interno `ShopeeProductLookupResult`, em `server/commercial/affiliate/shopeeClientContracts.ts:115-127`, expõe somente `status`, `shopId`, `itemId`, `name`, `priceMinorUnits`, `productLink`, `httpStatus`, `raw` e `error`.

Consequentemente, a resposta atualmente consumida pelo Evidence Bridge não possui campos tipados para `availability`, `seller`, `commission`, `competition` ou `market`.

`offerLink` é tratado como resultado de elegibilidade/aquisição de afiliado, não como sinal comercial. `productLink` é referência de produto. `itemId`, `shopId` e `productName` sustentam identidade/título, não cobertura das cinco dimensões auditadas.

## Matriz final de cobertura

A classificação abaixo usa exatamente os estados solicitados. `LOCAL_ONLY` significa que o motor ou os contratos locais possuem forma genérica para o sinal, mas não existe contrato oficial suficiente nem caminho Shopee atual que permita promovê-lo como evidência comercial.

### 1. availability — `LOCAL_ONLY`

**Suporte local:** o contrato N14 define `IN_STOCK`, `OUT_OF_STOCK`, `UNAVAILABLE` e `UNKNOWN`; `normalizeAvailability` converte somente estados comprovados em `1`, `0` ou `null`. O catálogo local de evidências também reserva o campo `availability`.

**Contrato Shopee atual:** `ShopeeProductLookupResult` não possui availability. O selection set atual não solicita esse campo. O Evidence Bridge preenche `observed_fields.availability=null` e gera `UNKNOWN` para ele, mesmo no caminho de sucesso.

**Contrato oficial:** as páginas oficiais consultadas descrevem a Open API v2.0, APIs seller e superfícies AMS, mas não documentam um campo availability de `productOfferV2` Affiliate BR com tipo e semântica utilizáveis. Não é permitido transportar um status de outro endpoint para esta operação.

**Normalização segura:** nenhuma normalização Shopee pode ser implementada nesta fase. Seria necessário um campo oficial documentado, com enumeração e semântica explícitas, além de inclusão controlada no contrato interno e no Bridge.

**Impacto N14:** potencialmente relevante, pois availability possui peso baseline de `0.15`, mas permanece `UNKNOWN` e não participa do score.

### 2. seller — `LOCAL_ONLY`

**Suporte local:** o contrato N14 define seller como rating/status com proveniência; `normalizeRating` aceita rating no domínio `0–5` e review count não negativo. O catálogo de evidências possui `seller`, `rating` e `review_count`.

**Contrato Shopee atual:** `ShopeeProductLookupResult` não possui seller, rating ou review count. O selection set atual não solicita esses campos. O Evidence Bridge deixa `seller`, `rating` e `review_count` como `null`/`UNKNOWN`.

**Contrato oficial:** não foi localizada especificação oficial da operação Affiliate BR `productOfferV2` que defina seller, rating ou review count, seus tipos, escopo ou semântica. Documentação seller de `v2.shop.get_shop_info` é uma operação distinta e não pode ser usada como contrato substituto.

**Normalização segura:** não permitida. Um rating visual, um nome de loja ou um identificador de seller não pode ser reinterpretado como reputação comercial sem contrato da operação alvo.

**Impacto N14:** potencialmente relevante, pois seller possui peso baseline de `0.20`, mas permanece `UNKNOWN`.

### 3. commission — `LOCAL_ONLY`

**Suporte local:** o contrato e o normalizador N14 aceitam comissão como fração numérica no intervalo `0–1`, com proveniência obrigatória. A dimensão possui peso baseline de `0.25`.

**Contrato Shopee atual:** não existe campo de comissão no `ShopeeProductLookupResult`, no selection set de `productOfferV2` ou no Evidence Bridge Shopee. A integração atual não extrai nem persiste commission.

**Contrato oficial:** a documentação oficial AMS consultada menciona `commission rate` em uma operação de Open Campaign distinta, `v2.ams.get_open_campaign_added_product`. Esse fato não prova que `productOfferV2` Affiliate BR retorne comissão, nem define se o valor seria seller commission, platform commission, total commission, percentual ou unidade monetária.

**Normalização segura:** nenhuma. Não é permitido copiar a semântica da API AMS para a operação Affiliate GraphQL nem converter um percentual sem definição do denominador, escopo e momento de validade.

**Impacto N14:** potencialmente o maior entre as dimensões auditadas, pois commission possui peso baseline de `0.25`, mas permanece `UNKNOWN` no caminho Shopee.

### 4. competition — `LOCAL_ONLY`

**Suporte local:** N14 possui normalizador para um valor numérico de competição com proveniência real. O contrato exige evidência comprovada; na ausência, o sinal é `UNKNOWN`. A dimensão possui peso baseline `0.00`, portanto não altera o score baseline atual.

**Contrato Shopee atual:** não existe campo de competição no cliente Shopee, no selection set, no contrato de resultado ou no Evidence Bridge.

**Contrato oficial:** não foi encontrada especificação oficial de `productOfferV2` que defina competição, ranking competitivo, número de concorrentes, posição, share ou qualquer proxy equivalente.

**Normalização segura:** nenhuma. Ranking, visualizações, vendas presumidas ou número de ofertas não podem ser convertidos em competição sem semântica oficial e sem regra de observação.

**Impacto N14:** nenhum no peso baseline atual, embora a dimensão continue auditável no contrato e possa ser usada somente após evidência real e proveniente.

### 5. market — `LOCAL_ONLY`

**Suporte local:** N14 aceita proxies de mercado comprovados, como `review_count` ou `sales_report` de API oficial, sempre com proveniência. O normalizador rejeita ausência, valores inválidos e ausência de proveniência.

**Contrato Shopee atual:** não existe campo de market, sales report, review count ou proxy de demanda no resultado Shopee usado pelo Bridge. `review_count` aparece apenas como slot fechado de evidência, preenchido com `null`.

**Contrato oficial:** não foi localizada especificação oficial de `productOfferV2` Affiliate BR para review count, sales, demand, ranking ou outro proxy de mercado com tipo e semântica suficientes. A documentação de endpoints seller/AMS não autoriza transportar esses campos para o Affiliate product offer.

**Normalização segura:** nenhuma. Não é permitido inferir demanda de preço, título, ranking, disponibilidade, comissão, reviews ausentes ou posição de busca.

**Impacto N14:** potencialmente relevante, pois market possui peso baseline de `0.15`, mas permanece `UNKNOWN`.

## Campos efetivamente utilizáveis hoje

No caminho Shopee Affiliate BR auditado, nenhum dos cinco campos solicitados é `AVAILABLE`.

A cobertura efetiva de dados observáveis permanece limitada aos campos já suportados pelo contrato atual: identidade `itemId`/`shopId`, título `productName`, referência `productLink`, elegibilidade por `offerLink` e `price` somente quando já vier em forma numérica compatível. O `price` string observado continua deliberadamente bloqueado pela decisão fail-closed da Fase 19.

No Evidence Bridge, `title` e preço numérico podem ser promovidos quando presentes e provenientes. `images`, `seller`, `rating`, `review_count`, `availability` e `category` permanecem `UNKNOWN`; as cinco dimensões desta auditoria não recebem promoção adicional.

## Dimensão prioritária recomendada

A próxima investigação documental prioritária deve ser `availability`, sem implementação automática. Ela possui semântica mais estreita que commission, market e competition, já tem enumeração canônica no N14 e possui peso de `0.15`. Se a Shopee publicar um campo oficial de disponibilidade específico da operação Affiliate BR, a verificação de tipo e enumeração poderá ser feita com menor risco sem inventar unidade monetária ou proxy de mercado.

A recomendação é apenas de ordem de investigação. Ela não autoriza alterar o selection set, o parser, o Evidence Bridge ou o N14.

## Gates e estado de alteração

Os gates foram executados localmente sem alteração funcional nesta fase:

```text
npm test: PASS, exit 0
npx tsc --noEmit: PASS, exit 0
npm run build: PASS, exit 0
git diff --check: PASS, exit 0
secret scan de alta confiança: nenhum match
```

A contagem integral anterior confirmada na Fase 18 permanece `1362/1362`; a execução desta auditoria foi registrada por códigos de saída sanitizados.

A única alteração produzida pela Fase 20 é este relatório documental. As alterações de teste da Fase 18 e o relatório da Fase 19 não foram modificados.

## Estado de governança

```text
chamada real Shopee: NÃO REALIZADA
scraping/proxy/browser/introspection: NÃO UTILIZADOS COMO MECANISMO DE AQUISIÇÃO
banco: nenhuma escrita
N13: NÃO EXECUTADO
N14: NÃO EXECUTADO
N15: NÃO EXECUTADO
N16: NÃO EXECUTADO
N17+: NÃO EXECUTADO
commit: NÃO REALIZADO
push: NÃO REALIZADO
deploy: NÃO REALIZADO
```

## Conclusão

A auditoria termina sem qualquer campo adicional `AVAILABLE` para a operação oficial Shopee Affiliate BR `productOfferV2`.

A conclusão operacional é: as cinco dimensões possuem suporte genérico no motor N14, mas são `LOCAL_ONLY` no estado atual, porque o contrato oficial específico da operação alvo não comprova sua existência e semântica e o cliente/Bridge atuais não as extraem. Portanto, nenhuma dimensão adicional pode aumentar legitimamente a cobertura do N14 nesta fase.

## Referências

[1]: https://open.shopee.com/developer-guide/16 "Shopee Open Platform — API calls"
[2]: https://open.shopee.com/developer-guide/4 "Shopee Open Platform — What is Shopee Open Platform?"
[3]: https://open.shopee.com/documents/v2/v2.shop.get_shop_info?module=92&type=1 "Shopee Open Platform — v2.shop.get_shop_info"
[4]: https://open.shopee.com/documents/v2/v2.ams.get_open_campaign_added_product?module=127&type=1 "Shopee Open Platform — v2.ams.get_open_campaign_added_product"
[5]: https://affiliate.shopee.com.br/ "Criadores e Afiliados Shopee BR"
[6]: https://open-api.affiliate.shopee.com.br/graphql "Shopee Affiliate API BR GraphQL endpoint configured by the project"
