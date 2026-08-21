# N17/N14 — Fase 12 — Desbloqueio Definitivo de Cobertura Comercial

**Autor:** Manus AI  
**Data:** 2026-08-20  
**Status:** `BLOCKED — CONTRACT UNSPECIFIED / NO AUTHORIZED SOURCE`  
**Decisão:** não houve alteração funcional, publicação, aquisição ou avanço para N18.

## 1. Escopo e precondições

A fase auditou o projeto anexado, o repositório ativo, o provider `affprv-shopee`, o cliente oficial Affiliate BR `productOfferV2`, as evidências reais já observadas no ambiente Render, a documentação oficial acessível e a existência de fonte alternativa oficial já autorizada. A auditoria não alterou thresholds, pesos, score, policy N15, TTL, N16, N17, credenciais ou autoridade técnica de aquisição.

O repositório ativo permaneceu na linha publicada do projeto `kauabrennan5-bit/cerberus-forge-deploy`. O snapshot ZIP anexado não continha um adapter ou contrato comercial Shopee adicional que não estivesse presente no repositório ativo. Também não foi encontrado OAuth, access token de Seller/Open API, adapter Seller ou configuração reutilizável para consultar dados de uma loja Shopee específica.

## 2. Provider e runtime

A leitura somente do provider confirmou:

```text
provider_id=affprv-shopee
provider_code=shopee
status=ACTIVE
marketplace=Shopee
provenance=admin:manual
resolution_method=MANUAL
```

O runtime público permaneceu saudável:

```text
health=HTTP 200
version=cf7225e6cd1d37f64ab164a56ffa65a66ce1fefe
```

A auditoria local não encontrou credenciais Shopee no sandbox:

```text
SHOPEE_APP_ID=ABSENT
SHOPEE_APP_SECRET=ABSENT
SHOPEE_AFFILIATE_APP_ID=ABSENT
SHOPEE_AFFILIATE_APP_SECRET=ABSENT
SHOPEE_AFFILIATE_API_BASE_URL=ABSENT
```

Isso não contradiz a verificação anterior de que as credenciais Affiliate estavam presentes no processo Render publicado. Nenhum valor de credencial foi lido, impresso ou persistido nesta fase.

## 3. Evidência real do Affiliate `productOfferV2`

A evidência real autorizada anteriormente foi reutilizada sem nova chamada externa. O cliente oficial executou uma chamada `productOfferV2` read-only para `item_id=23794344926` e `shop_id=1530442944`. A resposta foi HTTP 200, `client_status=found`, com correspondência exata de identidade. O campo `price` existia no shape observado, mas era `string`. O valor não foi exposto nem convertido.

```text
http_status=200
client_status=found
identity_confirmed=true
price_present=true
price_type=string
price_classification=PRICE_SHAPE_CONFIRMED_NON_NUMERIC
priceMinorUnits=UNKNOWN
commission=UNKNOWN
availability=UNKNOWN
market=UNKNOWN
competition=UNKNOWN
```

O contrato local do cliente Affiliate solicita somente `itemId`, `shopId`, `productName`, `price`, `productLink` e `offerLink`. Não existe no cliente ativo um campo adicional comprovado que forneça simultaneamente moeda, escala, disponibilidade, comissão, mercado e competição. O Evidence Bridge e o N14 mantêm os campos ausentes como `UNKNOWN`; nenhuma dimensão foi promovida artificialmente a `KNOWN`.

## 4. Contrato oficial e fonte alternativa

A documentação pública oficial do programa de afiliados Shopee BR foi acessada, mas não expôs um schema técnico autenticado de `productOfferV2`. A sessão do navegador terminou em uma página de verificação/403; isso foi tratado como ausência de evidência, não como prova de que a API não possui outros campos.

A documentação oficial da Shopee Open Platform encontrada para a família Open API v2 descreve uma superfície distinta da Affiliate GraphQL `productOfferV2`.[1] A operação oficial `v2.product.get_item_base_info` documenta `price_info`, incluindo `currency`, `original_price` e `current_price`, e `stock_info_v2`, incluindo `total_available_stock`.[2] Contudo, essa operação é Seller/Open API: exige `shop_id`, `item_id`, assinatura e `access_token` associado à loja/autorização correspondente. O ambiente autorizado desta fase não possui esse access token, nem um vínculo comprovado de que o operador controla o `shop_id=1530442944` usado na prova Affiliate.

Portanto, essa operação não pode ser usada como fallback para uma oportunidade Affiliate Shopee de terceiro. Usá-la exigiria uma nova credencial/autorização e uma prova adicional de identidade e escopo. Isso constituiria uma integração externa nova, proibida nesta fase. Também não há, nessa fonte alternativa documentada, contrato suficiente para `commission`, `market` e `competition` aplicáveis ao mesmo candidato Affiliate.

A integração Mercado Livre existente foi auditada e preservada como trabalho anterior. Ela não possui vínculo de identidade com o `source_product_id/source_shop_id` Shopee e não foi usada como fonte alternativa.

## 5. Matriz textual de cobertura

```text
price:
  Affiliate real: PRESENT, porém STRING.
  moeda/unidade/escala: não verificadas contratualmente para productOfferV2.
  normalização segura para o N14: NÃO.
  estado final: UNKNOWN / CONTRACT UNSPECIFIED.

currency:
  Affiliate productOfferV2: não comprovada no contrato disponível.
  Seller/Open API get_item_base_info: documentada, mas fora do escopo Affiliate e sem autorização disponível.
  estado final: NOT AVAILABLE para esta oportunidade.

availability:
  Affiliate productOfferV2: não comprovada no contrato disponível.
  Seller/Open API: stock_info_v2 documentado, mas não autorizado nem vinculado ao mesmo vendedor.
  estado final: NOT AVAILABLE para esta oportunidade.

commission:
  Affiliate productOfferV2: nenhum campo contratualmente verificável disponível no cliente/contrato auditado.
  outras famílias Shopee: não reutilizadas como contrato da operação Affiliate.
  estado final: NOT AVAILABLE / CONTRACT UNSPECIFIED.

market:
  Affiliate productOfferV2: nenhum campo ou proxy contratualmente verificável.
  inferência por vendas, avaliações, ranking ou preço: proibida.
  estado final: NOT AVAILABLE / CONTRACT UNSPECIFIED.

competition:
  Affiliate productOfferV2: nenhum campo contratualmente verificável.
  métricas AMS/campaign: pertencem a outra superfície e não são contrato Affiliate.
  estado final: NOT AVAILABLE / CONTRACT UNSPECIFIED.
```

O contrato do N14 exige sinais com valor, status, fonte, `observed_at` e proveniência rastreável; ausência, dúvida ou inconsistência permanece `UNKNOWN` e não equivale a zero.[3] O N14 continua, portanto, sem a cobertura mínima verificável para produzir `SUFFICIENT` nesta oportunidade.

## 6. Alterações e publicação

Nenhum arquivo funcional foi alterado nesta fase. Não foram alterados o cliente Shopee, o Evidence Bridge, os contratos N14, os normalizadores, N13, N15, N16, N17 ou qualquer configuração de produção. Não houve commit, push, deploy, migration, alteração no Supabase ou chamada de aquisição.

Não foi possível adicionar testes de campos novos de forma legítima porque nenhum campo novo, contrato de normalização ou fonte autorizada foi estabelecido. Adicionar testes para um contrato inexistente criaria uma falsa autoridade de cobertura.

## 7. Gates

```text
npm test=PASS — 1407/1407
npx tsc --noEmit=PASS
npm run build=PASS
git diff --check=PASS
secret scan=REVIEW — somente caminhos/linhas de fixtures, documentação e código que contêm nomes ou placeholders de credenciais; nenhum valor secreto foi exposto
```

O build consultou a projeção pública e confirmou 14 produtos; não houve alteração funcional do catálogo nem escrita deliberada no Supabase. As alterações do working tree são artefatos documentais e alterações pré-existentes, incluindo a integração Mercado Livre anterior; nenhum arquivo funcional da Fase 12 foi publicado.

## 8. Fluxo real e parada fail-closed

O fluxo novo `N2→N3→N13→N14→N15` não foi repetido porque a auditoria não produziu qualquer nova fonte comercial autorizada ou correção segura. A execução repetida teria apenas criado nova prova com a mesma lacuna e não poderia gerar `SUFFICIENT` sem violar a regra de não fabricar sinais. A evidência real anterior já demonstrou a identidade Affiliate e o shape `price=string`.

```text
N14=INSUFFICIENT
N15=BLOCKED
N15_APPROVED_ACQUIRE_AFFILIATE=NOT_OBTAINED
N17_ACQUISITION=NOT_EXECUTED
N8=NOT_CALLED
N6=NOT_CALLED
REPLAY=NOT_EXECUTED
CONFLICT=NOT_EXECUTED
N16=NOT_EXECUTED
N18+=PROHIBITED / NOT_EXECUTED
```

A causa objetiva remanescente é a ausência de uma fonte autorizada que forneça, com identidade do mesmo item Shopee, preço semanticamente normalizável e pelo menos as demais dimensões comerciais exigidas pelo N14. A ausência de `commission`, `availability`, `market` e `competition` permanece independente do problema de parsing de `price`.

## 9. Decisão final

```text
STATUS=BLOCKED
REASON=NO_AUTHORIZED_CONTRACTUALLY_VERIFIABLE_COMMERCIAL_SOURCE
N14=INSUFFICIENT
N15=BLOCKED
N17=NOT_OPERATIONAL
READY_FOR_N18=NO
```

Para uma próxima fase, será necessária autorização explícita para uma das seguintes pré-condições: documentação/schema Affiliate autenticado que defina os campos e suas semânticas; ou credencial oficial Seller/Open API vinculada à mesma loja e um desenho de identidade que prove que os dados pertencem ao mesmo `source_product_id/source_shop_id`. Mesmo com essa autorização, `commission`, `market` e `competition` ainda precisarão de contrato específico; não devem ser preenchidos por proxies de outra operação.

## Referências

[1]: https://open.shopee.com/developer-guide/16 "Shopee Open Platform — Developer Guide 16 / Open API v2"

[2]: https://open.shopee.com/documents/v2/v2.product.get_item_base_info?module=89&type=1 "Shopee Open Platform — v2.product.get_item_base_info"

[3]: https://github.com/kauabrennan5-bit/cerberus-forge-deploy/blob/main/server/commercial/commercialBrain/contract.ts "Cerberus Forge — Commercial Brain contract"

[4]: https://affiliate.shopee.com.br/ "Shopee Affiliate BR official portal"
