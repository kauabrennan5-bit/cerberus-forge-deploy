# N17 — Fase 23 — Auditoria do fluxo operacional básico (A–E)

Contexto: usuário parou a linha Seller/2ª dimensão. Novo objetivo imediato: validar ponta a ponta
SHOPEE AFFILIATE API → produto real → affiliate link → Telegram → decisão manual PUBLICAR/DESCARTAR.
Restrições: NÃO N14/N15, NÃO seller API, NÃO publicação automática, NÃO commit/push/deploy sem autorização.

## A) Endpoint/operation Affiliate já disponível (server/commercial/affiliate/shopeeApiClient.ts)

- `lookupProduct({shopId, itemId})` — query oficial `productOfferV2(itemId, shopId, limit:1) { nodes { itemId shopId productName price productLink offerLink } }`.
  Retorna: shopId, itemId, name, priceMinorUnits (string decimal normalizada), productLink, httpStatus.
  Já em produção (deploy ce31323, Fase 20). identity confirmada via matchNode estrito.
- `acquireAffiliateLink({shopId, itemId})` — parseia o mesmo `offerLink` do nó (fonte oficial do link de afiliado).
  Fallback: mutation oficial `generateShortLink(input: { originUrl, subIds }) { shortLink longLink }` quando offerLink ausente.
  Usado pelo N8 (authority: AffiliateLinkAcquirer) — mas pode ser chamado SEM N15? Verificar: o provider N8 tem
  whitelist de host e exige N15 approval em acquisitionService. Para o teste ponta a ponta "sem aquisição irreversível":
  o TESTE pode usar lookupProduct (read-only) + offerLink do nó (retornado pela mesma query, sem mutation).
- `generateShortLink` — mutation oficial; subIds customizáveis (ex.: "shopee_test").

## B) Discovery atual (server/commercial/discovery/)

- `research.ts startResearch({candidate_id, url, ...})` → N3: resolveShopeeIdentity extrai (shop_id, item_id) da URL
  (padrões /product/{shopid}/{itemid}, /i.{shopid}.{itemid}, etc.), chama lookupProduct (via createDefaultShopeeClient),
  persiste candidate_evidence (price KNOWN, title KNOWN, demais UNKNOWN), SEM tocar products/afiliate_links.
- Já rodado em produção na Fase 15/20: /api/commercial/discovery/create e /api/commercial/research/:candidateId (admin, x-admin-password).
- Discovery de lote (batch) existe mas não necessário: uma URL real basta (ex.: https://shopee.com.br/product/1530442944/23794344926).

## C) Affiliate link gerado/obtido

- Via `offerLink` do nó `productOfferV2` (retornado junto com o produto — mesma chamada, read-only quando se usa lookup).
- Via mutation `generateShortLink` (link curto oficial; exige subIds).
- Ambos dentro de `shopeeAffiliateProvider.ts` (createShopeeAffiliateProvider) e acquisitionService.ts (autoridade N8).
- O provider já retorna `affiliateUrl` + `response_digest` + provenance n8:api.

## D) Telegram — como já recebe/publica produtos

- `server/services/telegramBot.ts` (1621 linhas): bot webhook, TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_USER_IDS (default "1976526372").
- Já possui infra de REVISÃO MANUAL: `PendingReview` (telegramRepository.ts: savePendingReview/getPendingReview/deletePendingReview + userState).
- `productAutomation.ts extractProductForReview(url)` (hoje usa scraper+Gemini — NÃO usar na rota nova).
- Card de revisão pronto: `buildReviewCardText(review)` e `buildMainReviewKeyboard(reviewId)` com botões:
  ✅ Confirmar & Publicar (confirm_pub:reviewId), 💰 Alterar Preço, 📁 Alterar Categoria, 🔎 Ver detalhes, ❌ Rejeitar (cancel_rev:reviewId).
- Estados do review: pending | published | cancelled | expired | rejected | error.
- ATENÇÃO: "Confirmar & Publicar" HOJE dispara publicação automática no site (productAutomation publishProduct?). Regra do usuário: PUBLICAR não deve publicar automaticamente — apenas registrar decisão ou encaminhar para fluxo manual.
- Bot expõe admin menu com lista de produtos (botões product_view/product_edit/product_toggle).

## E) Menor alteração necessária para conectar SHOPEE → AFFILIATE LINK → TELEGRAM

Fluxo proposto (fail-closed, sem tocar N14/N15/N16/N17/N8 authority, sem scraping):
1. NOVA rota admin `/api/commercial/preview-telegram` (x-admin-password): recebe {url} → resolveShopeeIdentity →
   lookupProduct (1 chamada oficial read-only) → se offerLink/shortLink disponível, monta payload e envia
   card ao Telegram via função existente do bot (sendMessage + inline_keyboard), registrando PendingReview
   com status "pending" e source "affiliate_preview".
2. Payload do card (dados reais da Affiliate API): nome (productName), imagem (NONE na API oficial — images N/A, informar "não fornecido pela Affiliate API"),
   preço (string original, rotulado "R$? NÃO — preservar escala UNVERIFIED: exibir como valor numérico com nota "escala não verificada"),
   URL produto (productLink), link afiliado (offerLink), item_id + shop_id (auditoria).
   NOTA: o node não traz imagem — informar ausente, não inventar.
3. Ações Telegram: [✅ PUBLICAR] → handler confirma callback e marca review como "published" no registro PendingReview
   (apenas decisão registrada / encaminha para publicação manual; NÃO chamar publishProduct).
   [❌ DESCARTAR] → cancel_rev → "cancelled".
4. Nenhuma alteração em N14/N15/thresholds; sem mutation write na Shopee além do opcional generateShortLink
   (que é leitura-para-aquisição; na 1ª fase usar só offerLink do nó — se ausente, card informa "link de afiliado não elegível").
5. Persistência: PendingReview existente (telegramRepository) — sem tabela nova.
6. Sem commit/push/deploy até autorização explícita.

## Pendências a esclarecer na proposta

- O handler confirm_pub atual dispara publicação automática → criar caminho alternativo (ex.: callback "approve_only:reviewId") ou adaptar o handler
  para o source "affiliate_preview" apenas registrar a decisão.
- Imagem ausente na API oficial: card Telegram mostrará placeholder textual; usuário deve autorizar isso.
- Preço: unidade string_price_unscaled — exibir o número com aviso de escala UNVERIFIED (o backend já normaliza para number;
  a semântica de unidade segue desconhecida — não rotular como R$).
