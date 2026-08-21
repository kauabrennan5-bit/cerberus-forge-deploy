# N17/N14 — Fase 13 — Resolução prática do bloqueio comercial

**PROOF_RUN_ID:** `N17_PHASE13_FINAL_20260820`

**Status final:** `BLOCKED`

**Decisão:** a Fase 13 não encontrou uma fonte comercial oficial já autorizada que possa fornecer as dimensões necessárias para a mesma oportunidade Shopee e provar simultaneamente `source_product_id + source_shop_id`. Nenhuma evidência foi fabricada, nenhum `UNKNOWN` foi promovido a `KNOWN`, nenhum threshold ou policy foi relaxado e N18 permanece proibido.

## 1. Objetivo e escopo executado

A investigação foi limitada ao repositório ativo, ao snapshot anexado, ao GitHub selecionado, ao Supabase, ao runtime Render, ao navegador autenticado disponível, ao cliente Affiliate Shopee já existente e à documentação oficial Shopee acessível. Foram preservadas as fronteiras entre N2/N3, N13, N14, N15, N17/N8/N6, N16 e N18+.

Não foi usado scraping, Mercado Livre, inferência visual, proxy, endpoint privado, fonte de terceiros ou autorização N15 artificial. Não houve alteração funcional, migration, commit, push ou deploy.

## 2. Dimensões exigidas pelo N14

O motor atual do N14 mantém a política existente e exige dimensões comerciais conhecidas com proveniência verificável para alcançar `SUFFICIENT`. A ausência de sinais não é convertida em zero e não existe fallback permissivo. A análise confirmou que a existência de uma dimensão em um fixture ou em outro marketplace não substitui a observação da mesma oportunidade Shopee.

A entrada N2/N3 não transporta duas dimensões comerciais Shopee comprovadas que possam ser promovidas legitimamente. Campos de catálogo, rating, texto, reviews ou sinais de discovery não foram reinterpretados como preço, disponibilidade, comissão, mercado ou competição.

## 3. Fonte Affiliate Shopee examinada

O cliente oficial local utiliza o endpoint GraphQL:

`https://open-api.affiliate.shopee.com.br/graphql`

A operação utilizada é `productOfferV2`. A prova real anterior, registrada em `docs/infra03_phase17_price_shape_probe.md`, observou HTTP 200, item e loja com identidade exata e `price_present=true` com `price_type=string`. O valor bruto não foi preservado ou exposto. A unidade monetária, moeda, escala decimal, separadores, regra de arredondamento e semântica de minor units não foram comprovadas por contrato oficial acessível.

Consequentemente, `price` permanece `UNKNOWN`. Não foi implementada coerção de string, conversão por heurística ou normalização permissiva.

A auditoria do parser, do contrato TypeScript e do Evidence Bridge não encontrou outro campo Affiliate já observado e contratualmente suficiente para preencher `availability`, `commission`, `market` ou `competition`. Campos não comprovados continuam `UNKNOWN` ou `NOT_AVAILABLE` conforme o contrato local.

## 4. Fonte oficial alternativa examinada

Foi examinada a operação oficial Seller/Open API v2:

`https://open.shopee.com/documents/v2/v2.product.get_item_base_info?module=89&type=1`

A documentação descreve `price_info`, incluindo `currency`, `original_price` e `current_price`, e `stock_info_v2`, incluindo `total_available_stock`.[1]

Esses campos pertencem à família Seller/Open API v2, não ao contrato Affiliate GraphQL `productOfferV2`. A operação exige `shop_id`, `item_id`, assinatura e `access_token` associado à autorização da loja correspondente.[1]

A fonte não pode ser usada nesta fase porque o ambiente não possui adapter Seller/Open API, OAuth ou access token Seller já autorizado, nem prova de que o operador controla o mesmo `source_shop_id` da oportunidade Affiliate. Também não fornece contrato para `commission`, `market` ou `competition` da mesma oportunidade Affiliate.

A utilização de Seller/Open API para preencher uma oportunidade de afiliado de terceiro sem vínculo de identidade e autorização violaria proveniência, autoridade e o requisito explícito da Fase 13. Por isso, nenhum adapter alternativo foi criado.

## 5. Provider e runtime

O provider existente foi confirmado como `affprv-shopee`, com estado `ACTIVE`, `provenance=admin:manual` e método de resolução manual. As credenciais existentes continuam sem seus valores serem lidos ou expostos. O runtime público permaneceu saudável, sem publicação adicional da Fase 13.

O repositório anexado e o repositório ativo não contêm uma integração Seller/Open API/OAuth Shopee reutilizável que possa ser conectada sem introduzir uma nova dependência de autorização. Não foi criada superfície HTTP nova para contornar essa ausência.

## 6. Campos examinados e motivo de não utilização

`price`: observado como string no Affiliate, mas sem unidade, moeda ou escala oficialmente comprovadas. Não pode ser promovido a `KNOWN`.

`currency`: não foi comprovado como campo contratual utilizável no retorno Affiliate da operação atual. Não pode ser preenchido a partir da Seller/Open API sem o vínculo de identidade e autorização correspondentes.

`availability`: não há contrato Affiliate acessível e suficiente para transformar a ausência atual em um estado comercial verificável. O estoque Seller/Open API é de outra família e exige autorização da loja.

`commission`: não há campo Affiliate contratualmente comprovado no fluxo atual com unidade, domínio e transformação compatíveis com o N14.

`market`: não há campo ou proxy Affiliate contratualmente comprovado. Vendas, reviews, ranking, preço ou origem regional não foram usados como substitutos.

`competition`: não há campo Affiliate contratualmente comprovado com domínio, semântica ou transformação determinística para o N14.

`rating`, reviews, título e outros sinais de discovery: podem ser observações de conteúdo ou qualidade, mas não foram tratados como dimensões comerciais exigidas pelo N14.

## 7. Menor alteração arquitetural necessária

A menor solução legítima para preço e disponibilidade seria adicionar um adapter oficial Seller/Open API v2 que receba autorização Seller válida, consulte a mesma combinação `shop_id + item_id`, preserve a resposta observada, registre método, timestamp, origem e digest, e só então publique os campos `price_info` e `stock_info_v2` como evidência vinculada ao mesmo item/loja. Isso ainda não resolveria `commission`, `market` e `competition`.

Para eliminar completamente o bloqueio atual, também seria necessário um contrato oficial e uma fonte autorizada para as demais dimensões, ou uma alteração de escopo formal que definisse quais dimensões são suficientes para a oportunidade específica sem alterar thresholds ou policy. Nenhuma dessas autorizações existe no ambiente desta fase.

A alteração não pode ser implementada agora com segurança porque faltam o access token Seller, a autorização da loja correspondente e o contrato Affiliate necessário para as dimensões restantes. Adicionar credenciais, OAuth ou uma nova integração seria uma nova dependência externa e exigiria autorização própria.

## 8. Fluxo operacional e parada fail-closed

A correção não foi implementada porque não houve dado real e contratualmente utilizável para normalizar. Sem correção legítima e sem nova fonte autorizada, não foi executado um novo fluxo persistente N2→N3→N13→N14→N15 nesta fase; repetir a mesma prova produziria o mesmo `N14=INSUFFICIENT` e criaria dados de prova sem ganho informacional.

Como não houve `N15=APPROVED / ACQUIRE_AFFILIATE` com `authorization_ref`, `assessment_id`, `candidate_id` e `expires_at` válidos, N17→N8→N6, replay, conflito e resolução N16 não foram executados. N16 não publicou nada. N18 não foi iniciado.

## 9. Gates e estado de alteração

`npm test`: PASS — 1407/1407.

`npx tsc --noEmit`: PASS.

`npm run build`: PASS.

`git diff --check`: PASS.

Secret scan: `REVIEW`, com alertas sanitizados associados a fixtures/placeholders e documentação previamente existente; nenhum valor de credencial foi exibido. Não houve segredo novo nem alteração funcional relacionada à Fase 13.

Arquivos funcionais alterados pela Fase 13: nenhum.

Artefatos documentais da auditoria: `docs/n17_phase13_external_findings.md`, `docs/n17_phase13_report.md` e notas de auditoria externas associadas. Nenhum desses artefatos foi publicado em produção.

## 10. Baseline e decisão final

A auditoria foi somente leitura no Supabase e não criou candidate, evidence, assessment, affiliate link, job ou execução de publicação. O baseline operacional permaneceu sem alterações da Fase 13.

`N14=INSUFFICIENT`.

`N15=BLOCKED`.

`N17=NOT_OPERATIONAL`.

`READY_FOR_N18=NO`.

**Causa objetiva do bloqueio:** o Affiliate `productOfferV2` não fornece, no contrato acessível, semântica suficiente para `price` e não fornece cobertura contratualmente verificável para `availability`, `commission`, `market` e `competition`; a alternativa oficial Seller/Open API possui preço/estoque, mas não está autorizada nem vinculada de forma comprovável à mesma loja/item e não cobre comissão/mercado/competição.

## Referências

[1]: https://open.shopee.com/documents/v2/v2.product.get_item_base_info?module=89&type=1 — Shopee Open Platform, `v2.product.get_item_base_info`.

[2]: https://open-api.affiliate.shopee.com.br/graphql — endpoint oficial Affiliate GraphQL utilizado pelo cliente local.

[3]: https://open.shopee.com/developer-guide/16 — documentação oficial Open API v2 consultada para distinguir a família Seller/Open API do contrato Affiliate.

[4]: https://open.shopee.com/developer-guide/702 — documentação oficial Shopee consultada durante a auditoria; não foi tratada como contrato Affiliate sem confirmação de escopo.
