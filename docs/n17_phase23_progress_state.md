# N17 Fase 23 — Estado de Progresso (snapshot interno, atualizado)

## IMPLEMENTAÇÃO CONCLUÍDA E GATES PASSADOS
Tudo já está implementado e validado localmente:
1. `server/routes/previewTelegramRoutes.ts` (NOVO, ~370 linhas):
   - `POST /api/commercial/preview-telegram` (admin auth via x-admin-password).
   - URL → `extractShopeeIdentifiers` → `client.acquireAffiliateLink` (1 chamada oficial READ-ONLY productOfferV2) → price do raw via `extractOfferNodes` (exportado) → persiste PendingReview (categoria=affiliate_preview, status=pending, existingProduct.source=affiliate_preview, priceScaleVerified=false) → card Telegram com inline_keyboard `[✅ PUBLICAR → approve_only:{reviewId}]`, `[❌ DESCARTAR → cancel_rev:{reviewId}]`.
   - Idempotência por URL (registry 1h, com `setTestPreviewRegistryForTests`).
   - Fail-closed: sem credenciais → 503 `affiliate_auth_unavailable`; link não elegível → 424 `affiliate_link_not_available` (sem card, sem review); Telegram falha → 503 `telegram_send_failed` (review PERSISTIDO para auditoria).
   - Preço: `formatPreviewPrice` → string decimal com vírgula + nota "(escala não verificada — não tratar como moeda)". Jamais "R$".
   - Imagem: linha informando que a API de Afiliados não inclui imagens.
2. `server/commercial/affiliate/shopeeApiClient.ts`: `extractOfferNodes` exportado.
3. `server/services/telegramBot.ts`: handler `approve_only:{reviewId}` antes de `confirm_pub:` — valida review, status→"published", descricao += `approved_by=approve_only · approved_at=ISO`, deleteUserState, feedback "✅ PREVIEW APROVADO — DECISÃO REGISTRADA ... Nenhuma publicação, aquisição ou mutation foi executada", logTelegramEvent("approve_only",...).
4. `server.ts`: import + `setupPreviewTelegramRoutes({ app, requireAdminAuth })` logo após registerCommercialBrainRoutes.
5. `server/repositories/telegramRepository.ts`: hooks de teste `setTestSavePendingReview` / `setTestGetPendingReview` (padrão setXForTests).
6. `tests/previewTelegramRoutes.test.ts` (NOVO, 17 testes, node:test + supertest, fake fetch global + hooks oficiais).

## GATES — TODOS PASSARAM
```
npm test: 1447 testes, 1447 pass, 0 fail (~64s)
npx tsc --noEmit: OK
npm run build: OK
git diff --check: OK
secret scan: NO SECRETS IN DIFF (mock-app-id/mock-app-secret são placeholders legítimos de teste, não credenciais reais)
```

## FILES ALTERADOS (git diff --stat)
```
server.ts: +6
server/commercial/affiliate/shopeeApiClient.ts: +8/-1
server/repositories/telegramRepository.ts: +28
server/services/telegramBot.ts: +30
server/routes/previewTelegramRoutes.ts: novo (~370)
tests/previewTelegramRoutes.test.ts: novo (17 testes)
docs/n17_phase23_progress_state.md: novo (este arquivo)
```

## PRÓXIMO PASSO ATUAL: TESTE E2E COM CREDENCIAIS REAIS
O sandbox NÃO tem credenciais Shopee (SHOPEE_APP_ID/SECRET ausentes no env/.env). As credenciais existem SOMENTE no Render `srv-d9tq9sh42hec738skftg` (serviço cerberus-forge-deploy-backend, Node, Virginia, Deployed há 59min).
- Navegador já logado no Render; Shell aberto em `https://dashboard.render.com/web/srv-d9tq9sh42hec738skftg/shell` (página carregou, prompt de shell no navegador — clicar em "Instance z4qtv" ou digitar comandos).
- Problema: as alterações locais (previewTelegramRoutes.ts etc.) AINDA NÃO estão publicadas no Render — o Shell do Render roda o código do deploy atual (main). Para rodar a rota nova no Render, seria preciso commit/push/deploy — PROIBIDO sem autorização do usuário.
- ALTERNATIVA AUTORIZADA para o teste E2E local (sandbox): montar um servidor Express local com a rota nova + mock do cliente Shopee... mas isso não testa as credenciais reais.
- Opções para o E2E real sem commit: (a) pedir ao usuário autorização para executar a rota contra o ambiente Render DEPLOYANDO a correção; (b) executar um script de prova E2E no sandbox usando curl com credenciais que o usuário cole — PORÉM o usuário PROIBIU compartilhar credenciais em chat; (c) usar o webhook path do Telegram local.
- URL real de teste: https://shopee.com.br/product/1530442944/23794344926 (item 23794344926, shop 1530442944).

## SITUAÇÃO DO WEB SHELL RENDER (23:10)
O Web Shell no navegador do sandbox NÃO conecta: a página carrega, o botão "Instance z4qtv" é clicado, mas o terminal permanece em branco ("Connecting..." / vazio) após >1min de tentativas (Enter, clique, input). Console sem erros. A conexão WebSocket do Web Shell provavelmente exige sessão interativa real ou está bloqueada na automação.
Opções para o E2E real sem commit/push/deploy:
(a) Entregar o diff completo e pedir autorização ao usuário para commit+push+deploy; o teste E2E real (com credenciais do Render) só é possível contra o runtime publicado, pois as credenciais SHOPEE_APP_ID/SECRET só existem lá.
(b) Pedir ao usuário para executar manualmente no Shell Render: `cd /opt/render/project/src && npx tsx -e "require('./dist/server/routes/previewTelegramRoutes')"` — NÃO FUNCIONA pois a rota nova não existe no deploy atual.
(c) PROVA LOCAL SEM CREDENCIAIS: rodar o server Express local com a rota nova e simular a Shopee — isso não testa credenciais reais, só o wiring (já coberto pelos 17 testes).
DECISÃO: entregar relatório com gates + diff + limitação, e instruir o usuário sobre o único caminho autorizado para o E2E com credenciais reais: autorizar commit+push+deploy.

## REGRA FINAL
Não fazer commit/push/deploy sem autorização explícita. Entregar diff + gates + resultado da prova E2E.
