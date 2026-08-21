# FASE 24 — CALIBRAÇÃO DO FAKE DO TESTE (notas técnicas)
Data: 2026-08-20/21

## Problema resolvido
O teste `tests/previewTelegramRoutes.test.ts` usa o SCRAPER REAL (`extractProductForReview`).
O fake antigo do fetch só interceptava `open-api.affiliate.shopee.com.br` e
`api.telegram.org`; qualquer URL Shopee caía no fallback de rede real →
scraper falhava → 424 em TODOS os testes de sucesso (12/18 passavam por não
chegar ao scraper ou por callback-only).

## Fake funcionando (já aplicado ao teste)
- `buildFakeShopeeHtml({title, price, hashes, empty})` gera HTML mínimo:
  JSON-LD Product (name/image/offers.price) + `<title>` + `<div>"images": [...]</div>`
  (hashes CDN Shopee de 20+ chars → `extractShopeeCdnImages` produz
  `https://down-br.img.susercontent.com/file/<hash>`).
- NOVO: fake fetch também intercepta URLs contendo `shopee.com.br` ou
  `shope.ee` (exceto a Affiliate, que vem primeiro no if) e retorna
  `new Response(html, {status:200, headers:{"content-type":"text/html; charset=utf-8"}})`
  (MUST usar Response real com body; objeto plano com `body:null` NÃO funciona —
  `readHtmlWithLimit` retorna "" e o scraper falha).
- Hook `setTestFindExistingProduct` ADICIONADO em
  `server/services/productAutomation.ts` (padrão setXForTests da codebase,
  igual telegramRepository): substitui findExistingProduct em teste para
  evitar Supabase real. Usado via `installFakeFindExistingProduct()` no
  beforeEach + installFakeTelegramRepo + restore no afterEach.
- GEMINI_API_KEY não setada nos testes → curadoria Gemini pulada, dados brutos
  do scraper usados (título extraído do JSON-LD).

## Detalhes do scraper usados no fake
- `parseJsonLd`: regex `/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi`,
  título=item.name, imagens=item.image (string|arr|obj), preço=item.offers[].price.
- `extractShopeeCdnImages`: regex `/(?:\"images\"|\"image_list\"|\"imageList\"|\"image_ids\")\s*:\s*\[([^\]]+)\]/`
  com hashes `"([a-zA-Z0-9_\-]{20,50})"`. Bloco >1 imagem retorna direto.
- `extractCorrectPrice` lê `price_min` (minor units) no SSR; se jsonLd retornar
  price, usa. Fake price 79.9 → preço final 79.9.
- `isGenericTitle` rejeita "shopee brasil", "account verification", "403 forbidden", etc.
  → o <title> fake inclui o nome do produto antes de "| Shopee Brasil" (ok).
- `hasInvalidTitle || hasNoImages → success:false, error "Não foi possível extrair..."`.
- `findExistingProduct` é chamado por `extractProductForReview` (linha ~474).

## Comportamento da rota (Fase 24 implementada)
- `enrichWithExistingScraper`: chama extractProductForReview(productLink oficial);
  exceção → failureReason `scraper_unexpected_error`; !result.success →
  `scraper_extraction_failed`; identidade (extractCanonicalShopeeIds vs
  officialShopId/ItemId) divergente → `scraper_identity_mismatch`; sem productLink →
  `affiliate_no_product_link`.
- Rota: enriched.ok=false → 424 `scraper_enrichment_failed` (failureReason,
  affiliateUrl, sem card, sem review).
- Card: `buildPreviewCardText` com priceSource ("scraper_observacional" |
  "affiliate_api"), imageUrl=image[0] (null → sendMessage), imageCount.
- `sendPreviewCard`: imageUrl → sendTelegramPhoto (caption+inline_keyboard),
  fallback sendMessage.
- `persistPreviewReview`: enriched.images/scrapperPrice/curatedTitle/Category/
  Description; preco=scraperPrice quando >0 senão affiliate raw;
  priceScaleVerified=false sempre; descricao com "scraper_observacional".
- Response JSON: ok, reviewId, affiliateStatus, affiliateUrl, name, price
  (=parsedPrice raw affiliate), priceScaleVerified=false, productLink, shopId,
  itemId, cardSent, cardMessageId (sem enriched no JSON).
- displayPrice no review: hasScrapedPrice = scraperPrice !== null/undefined &&
  isFinite && > 0.

## Identidade da rota
- `extractCanonicalShopeeIds(data.normalizedUrl)` — mesma normalização
  /product/{shop}/{item} e i.{shop}.{item}.
- URL canônica do produtoLink do teste:
  https://shopee.com.br/Camiseta-i.1530442944.23794344926
  → normalized: https://shopee.com.br/product/1530442944/23794344926 (IDENTITY OK).
- Para identity mismatch: usar hashes/título compatíveis mas... o mismatch é
  por shop_id/item_id na URL; fake deve servir HTML compatível com URL DIFERENTE
  (outro item) OU o affiliate node com outro id.

## Estado dos gates (a validar depois dos testes)
- tsc --noEmit OK após hooks (removi scripts/_scratch_probe*.ts).
- Falta: npm test completo, build, diff --check, secret scan, relatório final.
- Proibido commit/push/deploy sem autorização do usuário.

## Padrão de teste existente (18 testes; 12 passavam antes da correção)
- A) validação de entrada (401/400), A2) sucesso, A3) fail-closed (424/503),
  B) callbacks approve_only/cancel_rev, C) preços decimal/ausente.
- Novos testes planejados (Fase 24):
  1. scraper sucesso → card com imagens (FOTO via sendPhoto) + price observacional 79.9,
     review com imagens preenchidas, priceSource scraper_observacional.
  2. scraper failure (empty HTML) → 424 scraper_enrichment_failed, failureReason
     scraper_extraction_failed, sem card, sem review.
  3. identity mismatch (URL do productLink apontando outro item) → 424
     scraper_identity_mismatch.
  4. preço ausente no HTML → card exibe preço affiliate (99), imageCount=0 mas
     ainda sucesso? NÃO: sem imagens → extractProductForReview success=false
     (hasNoImages) → 424. Ajustar expectativa: o cenário "sem imagens" é
     fail-closed também.
  5. scraper price=0 → displayPrice volta ao affiliate; scraper price ausente → affiliate.

## Dados de referência
- Affiliate API: https://open-api.affiliate.shopee.com.br/graphql (SHA-256).
- Health: https://cerberus-forge-deploy-backend.onrender.com/health
- Commit publicado anterior: cdaf1bc (Fase 23).
- products=14 no catálogo canônico.

## PROGRESSO (2026-08-21 — continuação)
- Fake fetch do teste CORRIGIDO: `new Response(html, {status:200, headers:{content-type:"text/html; charset=utf-8"}})`
  (objeto plano com body:null NÃO funciona; o scraper lê via body.getReader).
- Hook `setTestFindExistingProduct` aplicado: installFakeFindExistingProduct/restoreFindExistingProduct
  no beforeEach/afterEach; 18/18 testes antigos passando.
- Teste "persiste PendingReview" atualizado: categoria agora aceita a curatorial real
  (Acessórios), não mais obrigatório "affiliate_preview".
- NOVOS TESTES Fase 24 adicionados (bloco A2B), 22 testes no total:
  1. "scraper enriquece o card com imagens oficiais e preço observacional" (linha ~440)
  2. "scraper com anúncio bloqueado → fail-closed 424" (~487)
  3. "scraper com item divergente → fail-closed 424 por identidade" (~511)
  4. "scraper sem preço no HTML → card usa o preço oficial da Affiliate API" (~534)
- Diag: `telegramCallBodies` adicionado ao fake (captura init.body JSON das chamadas
  api.telegram.org); `console.log("[DIAG TG] method path:", ...)` na rota do Telegram fake.
- Falhas atuais nos novos testes (a corrigir):
  * T12 (enriquece): caption validado via body (corrigir assert: ler telegramCallBodies
    do sendPhoto; caption contém "imagem(ns) oficial(is)" e "escala não verificada").
    shopee calls = 1 (correto, usar filtro excl. open-api.affiliate).
  * T13 (bloqueado): res.status não é 424 — verificar error/failureReason esperado:
    o corpo deve ser {ok:false, error:"scraper_enrichment_failed", failureReason:"scraper_extraction_failed"}.
  * T15 (sem preço): verificar status/fail.
- Estrutura da resposta 424 na rota: res.status(424).json({ok:false, error:"scraper_enrichment_failed",
  failureReason, affiliateUrl?, productLink?}) — conferir linha exata no handler.
- Estrutura do corpo sendPhoto: {chat_id, photo, caption, parse_mode:"HTML", reply_markup}.
- buildPreviewCardText imageLine (com imageUrl): "🖼️ <b>Imagem:</b> {imageCount} imagem(ns)
  oficial(is) observadas no anúncio (scraper · proveniência do anúncio original)".
- priceSource="scraper_observacional" → note " (observacional — escala não verificada — não tratar como moeda)".
- Após corrigir testes: rodar npm test (suíte completa), tsc --noEmit, npm run build,
  git diff --check, secret scan (grep -rnI -E '(sk-[A-Za-z0-9]{20,}|AIza|ghp_|xoxb-|SHOPEE_AFFILIATE_APP_SECRET)' --
  ou usar o script da codebase se existir; verificar scripts de scan em package.json).
- Entrega: relatório em docs/n17_phase24_revised_implementation_report.md + mensagem final.
- NÃO commitar/pushar/deployar sem autorização.
