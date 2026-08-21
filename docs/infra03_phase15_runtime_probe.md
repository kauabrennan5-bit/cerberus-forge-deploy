# INFRA-03 — FASE 15 — VALIDAÇÃO REAL NO RUNTIME

```text
PROOF_RUN_ID=INFRA03_PHASE15_RUNTIME_PROBE_20260820T0437Z
STATUS=BLOCKED — SOURCE COVERAGE
DECISION=price permaneceu UNKNOWN; nenhuma promoção comercial foi autorizada.
```

## 1. Escopo e autorização

A Fase 15 foi executada para disponibilizar temporariamente uma probe administrativa read-only no runtime Render e permitir uma única chamada real da operação oficial já existente `productOfferV2`, incluindo o campo `price` previamente adicionado ao selection set local.

A probe não foi conectada a N3/research, N13, N14, N15, N16 ou N17+. Também não usou o adapter de aquisição, `acquireAffiliateLink` ou `generateShortLink`. Nenhuma entidade foi persistida e nenhuma publicação foi executada.

A probe temporária foi removida imediatamente após a chamada real. O endpoint removido respondeu HTTP 404 no SHA final.

## 2. Implementação temporária

A implementação temporária consistiu em uma rota administrativa autenticada, com payload fechado para o único par permitido:

```text
POST /api/admin/shopee/readonly-product-offer
item_id=23794344926
shop_id=1530442944
```

A rota chamou somente `lookupProduct({ itemId, shopId })`, que utiliza a operação oficial `productOfferV2` sem retry. A resposta pública da probe foi sanitizada e retornou apenas status, identidade, título, preço, timestamp, digest seguro e categoria de erro. O corpo GraphQL bruto, credenciais, Authorization, Signature e qualquer campo secreto não foram retornados.

A probe foi adicionada no commit `da24d5735ceb332bc601567bf03b9c652ebaa6e7`, enviado e servido pelo Render apenas durante a janela da prova. Após a coleta, foi removida no commit `305683c97af0f518ec3279a6044e250084db8042`, que é o SHA final servido.

## 3. Preflight

O serviço Render respondeu `/health` com HTTP 200 antes e depois da prova. O SHA temporário foi servido corretamente durante a prova e o SHA de remoção foi servido após o cleanup.

A chamada real retornou `client_status=found`. Isso confirma que o runtime Render conseguiu construir o cliente oficial e autenticar a chamada usando as credenciais efetivas configuradas no serviço. Os nomes e valores das variáveis não foram expostos.

No runtime local, as variáveis Shopee não estavam disponíveis. Por isso, a prova não foi executada localmente nem desviada para uma chamada alternativa.

## 4. Única chamada real

```text
Quantidade de chamadas Shopee: 1
Operação: productOfferV2, por meio de lookupProduct do cliente oficial existente
Endpoint: endpoint oficial configurado no cliente Shopee
generateShortLink: NÃO EXECUTADO
acquireAffiliateLink: NÃO EXECUTADO
N3/research: NÃO EXECUTADO
```

Resposta sanitizada observada:

```text
HTTP status efetivo: 200
client_status: found
requested_item_id: 23794344926
returned_item_id: 23794344926
requested_shop_id: 1530442944
returned_shop_id: 1530442944
identity_confirmed: true
title: Porta Talher Madeira Nobre Vidro Organizador Multiuso Robusto Mesa Posta Decoraçao Cozinha Hotelaria
price: UNKNOWN
observed_at: 2026-08-20T04:37:23.634Z
response_digest: 6375f8ae8c82c371cdc58108c4921c250fb263cddd1bc41a4463eec2b4aa6b56
error_kind: null
```

O item e a loja retornados coincidiram exatamente com os identificadores solicitados. O título foi observado e registrado como dado real da resposta. O campo `price` não foi retornado em forma observável pelo parser do cliente e, portanto, permaneceu `UNKNOWN`.

O `response_digest` foi calculado somente sobre o resultado sanitizado. Nenhum segredo participou da resposta pública ou do relatório.

## 5. Proveniência

```text
source_type=api
provider=affprv-shopee
operation=productOfferV2
collection_method=API
source_url=endpoint oficial Shopee Affiliate API BR configurado no cliente
identity=(shop_id=1530442944,item_id=23794344926)
observed_at=2026-08-20T04:37:23.634Z
persistence=none
```

A observação foi uma leitura controlada e não foi convertida em `candidate_evidence`, assessment, link, produto, job ou publicação.

## 6. Critério de sucesso

A chamada real foi executada, o selection set com `price` foi aceito pelo endpoint, e o match exato de `item_id` e `shop_id` foi confirmado.

O critério completo de sucesso não foi satisfeito porque `price` não foi efetivamente observado. De acordo com o protocolo fail-closed, o resultado final é `BLOCKED — SOURCE COVERAGE`, não `SUCCESS`.

Nenhum valor foi inferido a partir do título, do link, de fontes alternativas, de fixtures ou de qualquer convenção de preço. `UNKNOWN` não foi convertido em zero e não foi promovido para `KNOWN`.

## 7. Cleanup e baseline

A probe foi removida do código, o commit de remoção foi enviado ao branch `main`, e o Render passou a servir o SHA `305683c97af0f518ec3279a6044e250084db8042`. A rota temporária respondeu HTTP 404 após o deploy final.

Baseline somente leitura antes e depois:

```text
products:               13 -> 13
candidates:              0 -> 0
candidate_evidence:      0 -> 0
candidate_assessment:    0 -> 0
affiliate_links:         0 -> 0
job_queue:               0 -> 0
publication_executions:  0 -> 0
commercial_cycles:       0 -> 0
```

Não houve necessidade de DELETE, pois a probe não persistiu dados.

## 8. Gates

```text
npm test: PASS — 1358/1358
npx tsc --noEmit: PASS
npm run build: PASS
git diff --check: PASS
secret scan material: PASS
probe temporária remanescente no código final: NÃO
health final: HTTP 200
SHA final servido: 305683c97af0f518ec3279a6044e250084db8042
```

Os testes específicos da probe também passaram antes do deploy temporário: 5/5. Após a remoção da probe, o conjunto final permaneceu íntegro com 1358/1358 testes aprovados.

## 9. N-series e publicação

```text
N13: NÃO EXECUTADO
N14: NÃO EXECUTADO
N15: NÃO EXECUTADO
N16: NÃO EXECUTADO
N17+: NÃO EXECUTADO
publicação: NÃO EXECUTADA
Telegram: NÃO TOCADO
scheduler: NÃO TOCADO
agentes: NÃO TOCADOS
```

## 10. Decisão final

```text
FASE 15=ENCERRADA
DECISÃO=BLOCKED — SOURCE COVERAGE
price=UNKNOWN
IDENTIDADE=CONFIRMED
CHAMADAS_REAIS=1
PERSISTÊNCIA=0
PROBE_REMOVIDA=SIM
BASELINE_RESTAURADO=SIM
DEPLOY_FINAL=305683c97af0f518ec3279a6044e250084db8042
N13_PLUS=PARADO
```

A Fase 15 termina aqui. Não há autorização implícita para iniciar N13, N14, N15, N16 ou N17+.

## Referências operacionais

1. Cliente oficial e selection set: `server/commercial/affiliate/shopeeApiClient.ts`.
2. Contratos e parser: `server/commercial/affiliate/shopeeClientContracts.ts`.
3. Commit temporário da probe: `https://github.com/kauabrennan5-bit/cerberus-forge-deploy/commit/da24d5735ceb332bc601567bf03b9c652ebaa6e7`.
4. Commit final de remoção: `https://github.com/kauabrennan5-bit/cerberus-forge-deploy/commit/305683c97af0f518ec3279a6044e250084db8042`.
