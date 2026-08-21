# INFRA-03 — FASE 25 — CONSOLIDAÇÃO DE COBERTURA COMERCIAL SHOPEE

**PROOF_RUN_ID:** `INFRA03_PHASE25_SHOPEE_COMMERCIAL_COVERAGE_20260820T062504Z`  
**Data:** 2026-08-20 UTC  
**Status:** `READY FOR REVIEW — NO CODE CHANGE`

## Objetivo e escopo

Esta fase consolida os resultados das Fases 18–24 para a integração oficial Shopee Affiliate BR baseada em `productOfferV2`. O escopo foi somente documental e local: `price`, `availability`, `commission`, `competition` e `market`.

Não foi realizada chamada real à Shopee. Não houve alteração de selection set, parser, contratos, Evidence Bridge, N13, N14, N15, N16, N17+, banco ou pipeline. Não houve commit, push ou deploy.

A consolidação usa a separação obrigatória entre **observação**, **contrato**, **normalização**, **evidência KNOWN**, **sinal UNKNOWN** e **decisão**. A capacidade genérica do N14 não é prova de que a fonte Shopee forneça o dado.

## Estados usados

`AVAILABLE` significa que existe contrato oficial suficiente e caminho técnico atual para consumo seguro. Nenhuma das cinco dimensões alcançou esse estado.

`KNOWN` significa um valor efetivamente observado e normalizado sob contrato comprovado. Nenhuma das cinco dimensões possui um valor comercial Shopee KNOWN no caminho real consolidado nesta fase.

`UNKNOWN` significa que há ausência de valor utilizável ou que a observação não sustenta semântica/normalização segura. A Fase 17 observou somente o shape de `price` como string; isso não tornou o preço KNOWN.

`NOT AVAILABLE` significa que a integração atual não possui campo/proxy Shopee comprovado e consumível para a dimensão.

`BLOCKED — CONTRACT UNSPECIFIED` significa que a promoção está impedida pela ausência de especificação oficial suficiente. Esse estado não deve ser convertido em zero, score, PASS ou KNOWN.

## Superfície local consolidada

O selection set atual de `productOfferV2` solicita somente `itemId`, `shopId`, `productName`, `price`, `productLink` e `offerLink` [1]. O contrato interno expõe identidade, título, preço normalizado, links e status, mas não expõe campos tipados para `availability`, `commission`, `competition` ou `market` [1].

O Evidence Bridge possui slots genéricos para alguns sinais de evidência, mas isso não equivale a suporte Shopee-specific. Sem campo de origem comprovado, os slots permanecem `UNKNOWN`/`null` e não podem ser promovidos pelo N14 [1].

## Matriz consolidada por dimensão

### 1. price

**Classificação:** `UNKNOWN` no caminho real atual; `BLOCKED — CONTRACT UNSPECIFIED` para qualquer conversão da string.

**Evidência real existente:** a Fase 17 fez uma única chamada oficial controlada e observou `price_present=true`, `price_type=string` e `price_keys=[]`. O valor monetário não foi preservado nem divulgado. A evidência prova o shape, não a unidade nem a semântica [2].

**Contrato oficial comprovado:** não existe especificação oficial localizada para tipo contratual, moeda, unidade, escala decimal, separadores, locale, arredondamento ou transformação de `productOfferV2.price` string em `priceMinorUnits` [3].

**Suporte no cliente:** parcial. O selection set solicita `price`, e o parser preserva o comportamento numérico existente; entradas não numéricas resultam em `priceMinorUnits=null` [2].

**Suporte no Evidence Bridge:** parcial e fail-closed. Um número finito compatível pode seguir o caminho existente; a string real observada permanece `UNKNOWN` e não é convertida [2].

**Consumo atual pelo N14:** não para a observação real string. O N14 poderia consumir somente um preço numérico já coberto pelo contrato local, mas não há autorização para afirmar que a string real representa major units, minor units ou outra escala [3].

**Decisão:** `price` não sustenta atualmente score comercial Shopee quando retornado como string. Deve permanecer `UNKNOWN`.

### 2. availability

**Classificação:** `NOT AVAILABLE` + `BLOCKED — CONTRACT UNSPECIFIED`.

**Evidência real existente:** nenhuma evidência real nova ou valor de availability foi produzido nas Fases 18–24. Não houve chamada real nesta consolidação.

**Contrato oficial comprovado:** não foi encontrado contrato oficial específico da Shopee Affiliate BR `productOfferV2` definindo existência, nome, tipo, enumeração ou semântica de availability [4]. Contratos Seller/Open API ou AMS não foram reutilizados.

**Suporte no cliente:** inexistente no caminho atual. `availability` não está no selection set nem no resultado tipado do cliente [1].

**Suporte no Evidence Bridge:** somente slot genérico sem origem Shopee comprovada; o Bridge mantém o campo ausente/`UNKNOWN`. Isso não é suporte suficiente para promoção.

**Consumo atual pelo N14:** não disponível para a fonte Shopee. O N14 possui enumeração genérica, mas sem observação e provenance da operação alvo não pode consumir o sinal.

**Decisão:** não utilizar availability no N14 para Shopee.

### 3. commission

**Classificação:** `NOT AVAILABLE` + `BLOCKED — CONTRACT UNSPECIFIED`.

**Evidência real existente:** nenhuma. As Fases 18–24 não realizaram chamada real para obter commission.

**Contrato oficial comprovado:** não foi encontrado contrato oficial específico de `productOfferV2` que defina campo, percentual ou unidade monetária, denominador, escopo, validade, domínio ou arredondamento [5]. A referência oficial AMS sobre commission rate pertence a operação distinta e não é contrato da Affiliate GraphQL alvo.

**Suporte no cliente:** inexistente. `commission` não está no selection set nem no `ShopeeProductLookupResult` [1] [5].

**Suporte no Evidence Bridge:** inexistente como mapeamento Shopee-specific. O Bridge não recebe valor de commission para promover.

**Consumo atual pelo N14:** não disponível. Embora o N14 aceite genericamente uma fração numérica em `0..1` com provenance, isso não autoriza copiar a semântica AMS nem inferir uma comissão Shopee.

**Decisão:** commission não sustenta score N14 para Shopee.

### 4. competition

**Classificação:** `NOT AVAILABLE` + `BLOCKED — CONTRACT UNSPECIFIED`.

**Evidência real existente:** nenhuma. Não existe observação real de competition nas fases consolidadas.

**Contrato oficial comprovado:** não foi localizada especificação oficial de `competition` em `productOfferV2`, nem de ranking competitivo, número de concorrentes, posição, share ou proxy equivalente [6]. Materiais AMS sobre competitiveness pertencem a superfície diferente.

**Suporte no cliente:** inexistente. O campo não é solicitado nem parseado [1] [6].

**Suporte no Evidence Bridge:** inexistente como evidência Shopee-specific. Qualquer slot genérico permanece sem valor comprovado.

**Consumo atual pelo N14:** não disponível. O N14 exige valor numérico finito, fonte e provenance verificáveis. O peso baseline atual de competition ser `0.00` não transforma ausência em dado nem autoriza inferência.

**Decisão:** competition não sustenta score N14 para Shopee.

### 5. market

**Classificação:** `NOT AVAILABLE` + `BLOCKED — CONTRACT UNSPECIFIED`.

**Evidência real existente:** nenhuma observação real de market ou proxy oficial foi produzida nas Fases 18–24.

**Contrato oficial comprovado:** não foi localizado campo ou proxy oficial de market em `productOfferV2` Affiliate BR com nome, tipo, semântica, domínio, janela temporal e regra de agregação suficientes [7]. Não foram aceitos como proxy vendas, reviews, ranking, preço, disponibilidade, posição de busca ou qualquer outra métrica sem contrato explícito.

**Suporte no cliente:** inexistente. O cliente não solicita nem parseia market, `sales_report`, `review_count` ou outro proxy de demanda para o resultado Shopee atual [1] [7].

**Suporte no Evidence Bridge:** somente slots genéricos sem evidência de origem Shopee; não há promoção segura.

**Consumo atual pelo N14:** não disponível. O N14 aceita proxies somente quando comprovados, provenientes e contextualizados. Nenhum proxy Shopee desta operação atende a esses requisitos.

**Decisão:** market não sustenta score N14 para Shopee.

## Resultado KNOWN versus UNKNOWN

Não há uma dimensão comercial Shopee atualmente `KNOWN` no sentido exigido para sustentar N14 sem inferência.

A única observação real das dimensões auditadas é o shape string de `price`. Ela permanece `UNKNOWN`, porque a observação não documenta unidade, moeda ou escala. `availability`, `commission`, `competition` e `market` permanecem `NOT AVAILABLE` e bloqueadas por ausência de contrato oficial específico.

Os campos de identidade e referência, como `itemId`, `shopId`, `productName`, `productLink` e `offerLink`, não são dimensões comerciais adicionais desta matriz. `offerLink` também não é comissão nem evidência de receita; é resultado de elegibilidade/aquisição de afiliado [1].

## Decisão explícita sobre o N14

**Não existe, neste momento, nenhuma das cinco dimensões comerciais Shopee suficientemente comprovada para sustentar o N14 sem inferência.**

A integração pode fornecer observações estruturais de identidade/título/link e pode preservar preço numérico quando já coberto pelo contrato local. Porém, no shape real observado para `price`, o valor permanece `UNKNOWN`. Nenhuma dimensão adicional pode ser convertida em `KNOWN`, zero ou score por aproximação.

A ausência de cobertura comercial suficiente é um resultado válido e não deve ser mascarada por sucesso parcial. N13 PASS, N14 score, N15 APPROVED, digest, provenance de avaliação ou artefato de publicação não foram fabricados.

## Validação de escopo e estado do repositório

A Fase 25 não alterou código funcional, selection set, parser, contratos, Evidence Bridge, N13, N14, N15, N16 ou N17+. A verificação local encontrou uma alteração de teste já existente da Fase 18 em `tests/shopeeAffiliateIntegration.test.ts` e relatórios não commitados de fases anteriores; esses artefatos não foram modificados pela Fase 25.

Não houve escrita no banco, nova chamada real, limpeza, migration ou execução de pipeline. O estado funcional de produção não foi alterado.

## Gates

Como não houve alteração de código na Fase 25:

```text
npm test: NOT REQUIRED
npx tsc --noEmit: NOT REQUIRED
npm run build: NOT REQUIRED
git diff --check: NOT REQUIRED
secret scan: NOT REQUIRED
```

Os gates da Fase 18 permanecem registrados como PASS no relatório correspondente; eles não são reexecutados nem reinterpretados como gates desta consolidação [2].

## Governança e parada

```text
Chamada real Shopee nesta fase: NÃO REALIZADA
Código alterado nesta fase: NÃO
Banco alterado: NÃO
N13: NOT EXECUTED
N14: NOT EXECUTED
N15: NOT EXECUTED
N16: NOT EXECUTED
N17+: NOT EXECUTED
Commit: NOT PERFORMED
Push: NOT PERFORMED
Deploy: NOT PERFORMED
```

**Fase encerrada em READY FOR REVIEW.** Nenhuma implementação especulativa foi proposta ou executada. A próxima ação, caso autorizada em fase separada, dependerá de contrato oficial específico ou de decisão explícita de produto que não substitua a evidência da fonte.

## Referências

[1]: [Fase 20 — Auditoria de cobertura comercial](./infra03_phase20_commercial_coverage_audit.md) — selection set, contratos locais, Evidence Bridge e N14.
[2]: [Fase 18 — Correção fail-closed do parser de price](./infra03_phase18_price_parser_correction.md) — observação real do shape string, regra de não conversão e gates.
[3]: [Fase 19 — Especificação contratual do price](./infra03_phase19_price_contract.md) — ausência de moeda, unidade, escala, locale e arredondamento.
[4]: [Fase 21 — Auditoria documental de availability](./infra03_phase21_availability_contract.md) — ausência de contrato oficial específico.
[5]: [Fase 22 — Auditoria documental de commission](./infra03_phase22_commission_audit.md) — distinção entre AMS commission e Affiliate productOfferV2.
[6]: [Fase 23 — Auditoria documental de competition](./infra03_phase23_competition_audit.md) — ausência de campo e semântica oficial.
[7]: [Fase 24 — Auditoria documental de market](./infra03_phase24_market_audit.md) — ausência de campo/proxy oficial e rejeição de inferências.
