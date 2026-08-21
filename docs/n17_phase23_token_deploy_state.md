# N17 FASE 23 — ESTADO APÓS TOKEN + DEPLOY

- Commit Fase 23: 1ca4d3727a5482cd3fbfc7d1aa3232fe40b70ecb (preview-telegram)
- Commit correção callbacks: cdaf1bc1ddd61902d0f086b8a5947ee5a3b707f3 (deploy dep-da3p1v0jo6nc73egefb0, LIVE às 11:43 PM UTC)
- TELEGRAM_BOT_TOKEN atualizado no Render via painel (Opção B): <TELEGRAM_BOT_TOKEN_ROTACIONADO> (novo token; o anterior foi revogado pelo usuário)
- TELEGRAM_ALLOWED_USER_IDS = 1976526372 (intacto)
- Logs Render: server up porta 3000, Supabase conectado, bot webhook ativo, service live

## Próximo: prova E2E final
- POST https://cerberus-forge-deploy-backend.onrender.com/api/commercial/preview-telegram
  - body: {"url":"https://shopee.com.br/product/1530442944/23794344926"}
  - header: x-admin-password = cerberus1607
- Aguardar deploy SHA cdaf1bc servido em /health
- Usuário testa os botões: ❌ DESCARTAR e ✅ PUBLICAR (approve_only, sem publicação)
- Depois: cleanup do PendingReview de prova (affprev-124vbe6-mt25c9wy, arquivo telegram_reviews.json no Render FS)
- Report final com: SHA, HTTP status, reviewId, resultado dos 2 callbacks
