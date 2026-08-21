# N17 — Fase 22 — Verificação de Autorização Seller / Última Rota Prática

**PROOF_RUN_ID:** `N17_PHASE22_SELLER_AUTHORIZATION_20260820`
**Data:** 20 de agosto de 2026
**Execução:** exclusivamente auditoria do ambiente autenticado (nomes de credenciais, conectores, documentação do projeto). **Sem chamadas à Shopee, sem probes GraphQL, sem leitura de valores sensíveis, sem código, sem commit/push/deploy, sem N2–N18.**

## Resultado solicitado

```text
SELLER_AUTHORIZATION=ABSENT
AUTHORIZED_SHOP_ID=NONE
TARGET_SHOP_ID=1530442944
TARGET_ITEM_ID=23794344926
IDENTITY_BINDING=FAILED (SELLER_AUTHORIZATION=ABSENT → sem vínculo possível)
AVAILABLE_OFFICIAL_FIELDS=nenhum (sem credencial → sem acesso à v2.product.get_item_base_info)
SECOND_DIMENSION_CANDIDATE=nenhum
CONTRACT_STATUS=BLOCKED — EXTERNAL_AUTHORIZATION_REQUIRED
NEXT_MINIMAL_EXTERNAL_ACTION=obter autorização Seller/Open API legítima da loja do
  shop_id 1530442944 (owner da loja ou aprovação no Shopee Open Platform), que forneça
  access_token com escopo de produto/estoque para o mesmo (shop_id, item_id)
```

## Evidências da verificação

A investigação cobriu as quatro superfícies onde uma autorização Seller poderia existir no ambiente autorizado.

| Superfície | Verificação | Resultado |
| --- | --- | --- |
| Environment do serviço Render `srv-d9tq9sh42hec738skftg` | Auditoria anterior (infra03 render env check) listou **somente por nome**: `SHOPEE_AFFILIATE_APP_ID` PRESENT, `SHOPEE_AFFILIATE_APP_SECRET` PRESENT; `SHOPEE_APP_ID`, `SHOPEE_APP_SECRET`, `SHOPEE_AFFILIATE_API_BASE_URL` ABSENT | Nenhum par de credenciais Seller/Open Platform (que exigiria `SELLER_*/OPEN_API_*` ou `SHOPEE_APP_SECRET` com OAuth Seller) |
| Código do projeto | Varredura por `SELLER_API`, `sellerApi`, `get_item_base_info`, `OpenApi`, OAuth Seller em `server/`, `scripts/` | **Nenhuma implementação, adapter ou intenção** de Seller API no repositório |
| Configuração de conectores do workspace | Lista completa de conectores habilitados/possíveis | Nenhum conector Render/Shopee com token de acesso ao ambiente; a única API key Render utilizável nesta sessão (FindBot) não foi registrada completa em nenhuma fonte acessível |
| Auditorias documentais anteriores (Fases 12–13) | `n17_phase12_external_evidence.md` e `n17_phase13_external_findings.md` já haviam investigado `v2.product.get_item_base_info` na documentação oficial da Shopee | Conclusão já registrada: "o ambiente não apresentou credenciais OAuth Seller, escopo de autorização, vínculo de propriedade da loja ou prova de identidade cross-market" |

O ponto contratual relevante já foi registrado na Fase 12 e permanece válido: a operação oficial `v2.product.get_item_base_info` (documentação [open.shopee.com][1]) fornece exatamente as dimensões que faltam — `stock_info_v2.summary_info.total_available_stock` (estoque → **availability**) e `price_info` (`currency`, `original_price`, `current_price` → escala/moeda do preço) — mas **exige** `access_token` vinculado à autorização OAuth da loja correspondente, com `shop_id` e `item_id` do mesmo produto.

## Classificação final

> **SELLER_AUTHORIZATION = ABSENT.** Não existe conta Shopee Seller oficialmente conectada ao ambiente autenticado, nem credencial, conector, adapter ou documento de autorização que ligue a operação deste projeto à loja do `shop_id 1530442944`.

Consequentemente:

- **IDENTITY_BINDING_STATUS = FAILED** — o binding não é "POSSIBLE" a partir do ambiente atual, porque não existe ponto de partida (nenhuma autorização Seller de **nenhuma** loja foi encontrada). Se houvesse uma autorização Seller de uma loja **diferente**, a classificação correta seria `FAILED / SELLER_SHOP_MISMATCH` conforme regra D do prompt; como não há autorização alguma, a rota Seller inteira depende de aquisição externa.
- **Condição adicional documentada**: mesmo que uma autorização Seller de outra loja existisse, o prompt (regra D) proíbe usá-la — o binding exige **exatamente** `shop_id = 1530442944`.
- **Campos oficiais que a rota Seller ofereceria, se autorizada** (contratualmente documentados, não inferidos): `stock_info_v2.summary_info.total_available_stock` (availability), `price_info.currency/current_price` (escala/moeda do price — que também resolveria `SCALE_UNVERIFIED`), e dados do vendedor da mesma listagem. `commission`, `market` e `competition` **não** são fornecidos nem pela Seller API para essa oportunidade — seguiriam BLOCKED.

## Conclusão objetiva

O bloqueio de N14 (`MIN_DIMENSIONS_KNOWN=2`, cobertura real 1/6) **não é mais resolúvel por trabalho interno do projeto**: a plataforma bloqueia campos adicionais na Affiliate API (policy global `10010`, provada na Fase 14 com 25 campos extras) e o ambiente não possui nenhuma autorização Seller. A única via restante é **externa**: a autorização OAuth Seller da loja do `shop_id 1530442944`, obtida pelo owner da loja ou aprovada no Shopee Open Platform, com escopo de produto/estoque. Com essa autorização, a operação `v2.product.get_item_base_info` forneceria a 2ª dimensão (availability via estoque) e ainda a semântica de escala do price, em um só vínculo.

Nenhum campo, código ou baseline foi alterado nesta fase. N15 permanece corretamente `BLOCKED` para oportunidades Shopee até a dependência externa ser obtida.

[1]: https://open.shopee.com/documents/v2/v2.product.get_item_base_info?module=89&type=1
