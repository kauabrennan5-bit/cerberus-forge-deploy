# N17 Fase 25C — Relatório do Commit 2: Orquestrador `/shopee N`

**Data:** 2026-08-20 · **Escopo:** Commit isolado #2 da Fase 25 (Fase 25C) · **Deploy atual em produção:** SHA `8d825a9` (Commit 1 — painel read-only)

## A. Objetivo

Transformar o Telegram no ponto de partida do fluxo operacional Shopee, permitindo o comando `/shopee N [termo]`, que dispara discovery via connector Shopee existente, aquisição oficial de link de afiliado (Affiliate API), enriquecimento pelo scraper existente (imagens e preço observacional), criação de PendingReview com TTL de 24h e envio de cards individuais com decisão humana obrigatória.

## B. Arquivos alterados (novo, não commitado)

| Arquivo | Papel |
| --- | --- |
| `server/services/shopeeCommand.ts` (619 linhas, novo) | Núcleo do orquestrador: parse, descoberta única por lote, aquisição oficial por item, enriquecimento scraper, verificação de identidade, PendingReview e card Telegram |
| `server/services/telegramBot.ts` (+dispatcher) | Dispatcher `/shopee` na leitura de mensagens + hooks de teste `setTestTelegramSenders` |
| `server/services/productAutomation.ts` (+hook) | Hook `setTestExtractProductForReview` para mockagem do scraper em testes |
| `tests/shopeeCommand.test.ts` (462 linhas, novo) | Suite completa: 16 testes, 5 sub-suítes |

## C. Fluxo por item (fail-closed)

1. **Descoberta:** UMA busca via `shopeeConnector` por lote (respeita rate limit e circuit breaker compartilhados); itens 2..N reutilizam a mesma página de resultados. Links sem `shop_id/item_id` extraíveis → `discovery_failed` (fail-closed, sem presunção).
2. **Aquisição:** UMA chamada read-only `productOfferV2` por item (Affiliate API é a autoridade para IDs, links e offerLink). Sem elegibilidade → `not_eligible`.
3. **Enriquecimento:** scraper existente (`extractProductForReview`) para imagens e preço observacional. Falha do scraper → `scraper_enrichment_failed`, **sem inventar dados**.
4. **Identidade:** correspondência determinística `shop_id/item_id` entre scraper e Affiliate API. Divergência → `identity_mismatch`, item falha fechado.
5. **PendingReview:** contrato real (mesmo da Fase 23/24), TTL 24h, `status=pending`, `priceScaleVerified=false`, proveniência `scraper_observacional` explicitamente anotada na descrição.
6. **Card Telegram:** `sendPhoto` quando há imagem, `sendMessage` caso contrário; preço sempre rotulado como "escala não verificada", jamais como moeda (sem "R$"); teclas `[✅ PUBLICAR]` (approve_only) e `[❌ DESCARTAR]` (cancel_rev).
7. **Resumo do lote:** card final `🏁 LOTE CONCLUÍDO` com id do lote, ok/falhas e a garantia explícita de que nada foi publicado.

## D. Gates

| Gate | Resultado |
| --- | --- |
| Suite nova (`tests/shopeeCommand.test.ts`) | **16/16 pass** |
| `npm test` (projeto completo) | **1480/1480 pass** |
| `npx tsc --noEmit` | OK, zero erros |
| `npm run build` | OK |
| `git diff --check` | OK |
| Secret scan (arquivos do escopo) | Nenhum secret/credencial hardcoded; credenciais via `process.env` apenas |

## E. Testes implementados (cenários cobertos)

1. Rejeição de contagem inválida / zero.
2. Ambiente incompleto (sem credenciais Affiliate) → zero consultas, `affiliate_auth_unavailable`.
3. Lote completo (N=3): 3 cards enviados como foto, 3 PendingReviews persistidas com `batch=/position=`, preço `79.9`, `priceScaleVerified=false`, teclas `approve_only`/`cancel_rev`.
4. Escala não verificada: card contém "observacional", sem "R$", review registra "preço exibido observacional (scraper_observacional)".
5. `offerLink` oficial preservado na review.
6. Fail-closed por item: discovery sem links → `discovery_failed`; item não elegível → `not_eligible` com notificação; scraper divergente (identidade) → sem card e sem review; falha genérica do scraper → `scraper_enrichment_failed`; lote heterogêneo (item bom passa, item sem identidade NÃO consulta a Affiliate API — verificado interceptando as consultas GraphQL).

## F. Decisões técnicas relevantes

- **Reuso integral de infraestrutura existente:** connector Shopee, `shopeeApiClient.acquireAffiliateLink`, scraper de `productAutomation`, persistência de PendingReview e senders do `telegramBot`. Nenhuma dependência externa nova.
- **Identidade determinada pela URL do listing** (`extractShopeeIdentifiers`) antes da consulta Affiliate — URLs sem `shop_id/item_id` nem consultam a API (comprovado no teste heterogêneo).
- **Preço do card e da review** vem do scraper como observacional; o campo `priceScaleVerified=false` e a proveniência `scraper_observacional` são obrigatórios no contrato.
- **Nenhuma mudança** em N14/N15, thresholds, weights, policy, TTL de governança, aquisição automática ou pipeline de publicação. O comando só cria PendingReviews e aguarda decisão humana.

## G. Limitações conhecidas

- Sem termo de busca → usa busca padrão do connector (mesmo comportamento da Fase 17/18).
- A deduplicação por URL dentro do lote não é explícita além da extração de identidade (listings duplicados na página de resultados geram itens duplicados — aceitável na v1, pode evoluir no Commit 3 se autorizado).
- O scraper observacional continua com `SCALE_UNVERIFIED_CONTRACT_UNSPECIFIED` (política inalterada).

## H. Próximos passos (aguardando autorização)

1. Commit isolado + push para `main`.
2. Deploy no Render (`srv-d9tq9sh42hec738skftg`), aguardar conclusão.
3. Confirmar `/health=200` e SHA servido igual ao commit.
4. Teste real `/shopee 1` no Telegram (produto já comprovado `1530442944/23794344926`) — sem clicar em PUBLICAR.
5. Relatório final com SHA, status HTTP, reviewIds e resultado dos cards.
6. Em seguida (nova autorização): Commit 3 — `/publicar <reviewId>` e unificação da decisão.
