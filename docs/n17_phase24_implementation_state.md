# FASE 24 REVISADA — ESTADO DA IMPLEMENTAÇÃO (2026-08-21)

## Autorização do usuário (verbatim)
Implementar somente o elo Affiliate API → Scraper → PendingReview → Telegram,
reutilizando scraper e pipeline canônico existentes. Affiliate API = autoridade
para shop_id/item_id/productLink/offerLink. Scraper enriquece imagens+preço com
validação determinística de identidade. NÃO criar scraper novo, rota paralela,
NÃO alterar N14/N15/thresholds/weights/contracts/governança. offerLink preservado.
NÃO commit/push/deploy — entregar diff + relatório. Fail-closed do scraper
explícito em teste/gate. SEM publicação real.

## Implementação concluída até agora
Arquivo: server/routes/previewTelegramRoutes.ts (5 edits aplicados):
1. Header atualizado (Fase 23+24, scraper existente, fail-closed explícito).
2. Imports novos: extractProductForReview (productAutomation), sendTelegramPhoto.
3. extractCanonicalShopeeIds() — extrai shop/item da URL normalizada (mesma
   normalização /product/{shop}/{item} e i.{shop}.{item} do fluxo do bot).
4. sendPreviewCard agora aceita imageUrl opcional → sendTelegramPhoto,
   fallback para sendTelegramMessage (mesmo padrão do telegramBot.ts:1492-1497).
5. persistPreviewReview aceita `enriched` (images, scraperPrice, curatedTitle/
   Category/Description); preco=scraperPrice quando >0 senão affiliate raw;
   imagens=scraper images; descricao com proveniência "scraper_observacional";
   priceScaleVerified=false SEMPRE.
6. enrichWithExistingScraper(): chama extractProductForReview(productLink
   oficial); falha em qualquer exceção/falha → ok:false, failureReason
   ("affiliate_no_product_link","scraper_unexpected_error",
   "scraper_extraction_failed"); identidade divergente → "scraper_identity_mismatch";
   sucesso: retorna imagens/scrapperPrice/curatedTitle/Category/Description.

## STATUS (após integração na rota principal — concluído)
- Rota principal integrada: enrichWithExistingScraper chamado após
  acquisition.status=="link_acquired"; failure → 424 scraper_enrichment_failed
  (failureReason, sem card, sem review, sem idempotência).
- buildPreviewCardText agora recebe priceSource, imageUrl, imageCount; linha de
  imagem mostra count quando observada ou "nenhuma imagem real foi inventada";
  preço sempre com nota de escala não verificada (scraper_observacional ou affiliate_api).
- persistPreviewReview recebe enriched; previewRegistry.set só após card ok.
- Response JSON atual: ok, reviewId, affiliateStatus, affiliateUrl, name, price
  (raw affiliate), priceScaleVerified=false, productLink, shopId, itemId,
  cardSent, cardMessageId — adicionar enrichedPrice/enrichedImages ao JSON
  do response? (opcional — adicionar enriched: {price, images} para auditoria).

## PENDENTE
- Corrigir possíveis TS errors nos testes existentes (17 testes) que chamam
  a rota e esperam o corpo antigo (sendPreviewCard mudou assinatura, mas
  o teste usa a rota completa → body JSON mudou? os testes verificam
  fields ok/reviewId/cardSent — provavelmente ok, mas revisar).
- Adaptar o fake fetch do teste para que o scraper REAL extraia: o fake
  retorna HTML com hashes "images": ["abc123..."] para que extractShopeeCdnImages
  produza imagens CDN reais (down-br.img.susercontent.com/file/...) — URLs reais
  passadas como parâmetro ao Telegram fake, sem requisição de imagem real.
- Novos testes: scraper failure → 424; identity mismatch → 424; imagens
  presentes → card foto + imagemCount.
- Gates: npm test, npx tsc --noEmit, npm run build, git diff --check,
  secret scan.
- Relatório: docs/n17_phase24_revised_implementation_report.md.

## Dados de contexto
- Commit publicado anterior: cdaf1bc (Fase 23 callbacks fix). Health URL:
  https://cerberus-forge-deploy-backend.onrender.com/health
- Suíte atual: 1448 testes passam (17 da previewTelegramRoutes).
- Teste E2E URL usada: https://shopee.com.br/product/1530442944/23794344926
- hooks de teste: setTestPreviewRegistryForTests (rota) + telegramRepository
  (ver nomes exatos com grep ForTests).
