# N17 Fase 23 — Notas de implementação (preview-telegram)

## Estado autorizado
Usuário autorizou implementar localmente o escopo A–E (rote preview-telegram), gates completos,
teste ponta a ponta local SEM commit/push/deploy. Linha Seller pausada. Não tocar N14/N15/contract/engine/weights/governança.

## Fatos contratuais coletados (para implementação)

### Client oficial (server/commercial/affiliate/shopeeApiClient.ts)
- `createShopeeApiClient({appId, secret, baseUrl})` retorna `ShopeeApiClient` com: lookupProduct, acquireAffiliateLink, generateShortLink.
- `lookupProduct({shopId?, itemId?})` → `ShopeeProductLookupResult { status:"found"|..., shopId, itemId, name, priceMinorUnits:number|null, productLink, httpStatus, raw, error }`.
  priceMinorUnits é a string decimal normalizada (escala UNVERIFIED).
- `acquireAffiliateLink({shopId, itemId})` → faz SOMENTE a query productOfferV2 (read-only) e parseia offerLink do nó:
  status "link_acquired" { affiliateUrl, productLink, shopId, itemId, name, raw } ou "not_eligible"/"not_found"/erro.
  → É a função perfeita para a rota: 1 chamada oficial read-only + link de afiliado da conta do app.
- `extractShopeeIdentifiers(publicUrl)` (exported, shopeeClientContracts.ts) → {shopId, itemId} extritos de URL (padrões /product/{s}/{i}, /i.{s}.{i}, /loja/s/i, /loja/slug/s/i).
- Credenciais: process.env.SHOPEE_APP_ID ?? SHOPEE_AFFILIATE_APP_ID; SHOOPEE_APP_SECRET ?? SHOPEE_AFFILIATE_APP_SECRET.

### Rota de referência (server/routes/discoveryRoutes.ts)
- `setupDiscoveryRoutes({app, requireAdminAuth})`; `app.post("/api/commercial/discover", requireAdminAuth, ...)`.
- Registro no server.ts: `setupDiscoveryRoutes({ app, requireAdminAuth });` (~linha 1045). Padrão de deps: `{ app, requireAdminAuth }` com type inline.
- requireAdminAuth: middleware existente (x-admin-password / Bearer / body / query), já passado em setupXxxRoutes.
- Registro de rotas acontece em server.ts via `import { setupDiscoveryRoutes } from "./server/routes/discoveryRoutes";` e chamada dentro da function main (~linha 1000-1100), após bootstrap N8.

### Telegram (server/services/telegramBot.ts)
- exports: isUserAllowed(userId), sendTelegramMessage(chatId, text, replyMarkup?), sendTelegramPhoto(...), editTelegramMessageText/Caption, answerCallbackQuery(callbackId, text?, showAlert?).
- PendingReview interface: { id, chatId, senderId, firstName, username, createdAt, expiresAt?, produto, categoria, preco:number, imagens:string[], normalizedUrl, descricao?, status?"pending"|"published"|"cancelled"|"expired"|"rejected"|"error", cardMessageId?, existingProduct?, lifecycle? }.
- telegramRepository.ts exports: savePendingReview, getPendingReview, deletePendingReview, listPendingReviews, setUserState, getUserState, deleteUserState.
- Callbacks existentes: confirm_pub: (publica automaticamente — NÃO usar), cancel_rev: (rejeita).
- Usuário autorizado default: TELEGRAM_ALLOWED_USER_IDS="1976526372".
- Bot usa webhook (startTelegramPolling preservado). Webhook registrado em server.ts (telegramBot setup).
- ATENÇÃO: o handler de callback do bot precisa registrar o NOVO callback "approve_only:{reviewId}" — o bot já faz dispatch por data.startsWith; adicionar handler análogo (sem pipeline.publish: apenas savePendingReview com status "published", resposta "decisão registrada, encaminhado à publicação manual").

### Chat ID destino
- Usar TELEGRAM_ALLOWED_USER_IDS (primeiro) como chatId do card.

### Teste ponta a ponta
- URL real autorizada: https://shopee.com.br/product/1530442944/23794344926 (oportunidade usada nas Fases 15/20).
- Executar localmente com node envs: usar dotenv do projeto (npm test já carrega) — rodar script via tsx que chama a rota via HTTP local (rodar servidor com porta aleatória? Melhor: invocar diretamente o handler ou usar supertest).
- Verificar tests/discovery.test.ts linha 364: setupDiscoveryRoutes({app, requireAdminAuth}) — padrão de teste com express app mock.

## Plano de arquivos (menor alteração)
1. NOVO: server/routes/previewTelegramRoutes.ts — setupPreviewTelegramRoutes({app, requireAdminAuth}):
   POST /api/commercial/preview-telegram {url} → extrair ids → acquireAffiliateLink → PendingReview (source meta "affiliate_preview") → sendTelegramMessage card + keyboard [✅ PUBLICAR (approve_only:)] [❌ DESCARTAR (cancel_rev:)] → retorna ok+reviewId+affiliateUrlStatus.
2. MODIFICAR: server/services/telegramBot.ts — adicionar handler callback approve_only (linha ~1082, junto a confirm_pub): validar callback, getPendingReview, answerCallbackQuery, setStatus published (sem publish), mensagem de confirmação "encaminhado à publicação manual".
3. MODIFICAR: server.ts — import + registro setupPreviewTelegramRoutes({ app, requireAdminAuth }); (após setupDiscoveryRoutes).
4. NOVO: tests/previewTelegramRoutes.test.ts — unit tests: url inválida (não-shopee), produto não encontrado, not_eligible (offerLink ausente), sucesso (mock acquireAffiliateLink), callback approve_only (mock repo), cancel_rev reutilizado.
5. Sem novas tabelas; sem mutation Shopee; PendingReview existente.

## Preços no card
- Exibir "preço (escala não verificada)" com número priceMinorUnits; NUNCA "R$".
- Se price null: "Preço não retornado pela fonte oficial".
- Imagem: "Imagem não fornecida pela fonte oficial" (API não retorna imagem).
- Campos do card: produto (name), preço UNVERIFIED, link produto (productLink), link afiliado (affiliateUrl), item_id/shop_id, observação de auditoria (provenance).

## Gates exigidos
npm test; npx tsc --noEmit; npm run build; git diff --check; secret scan (grep -ri "SHOPEE_AFFILIATE_APP_SECRET\|rnd_\|Token:" tests/ server/routes/previewTelegramRoutes.ts).

## Entrega final (sem commit/push/deploy)
1. resultado do teste real; 2. identificação da mensagem Telegram (messageId/resultado sendTelegramMessage); 3. comportamento dos 2 callbacks; 4. diff completo; 5. gates; 6. arquivos alterados; 7. limitações (sem imagem, escala UNVERIFIED, sem publicação automática).
