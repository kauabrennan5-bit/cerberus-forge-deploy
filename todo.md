# Project TODO

- [x] Remover completamente o fallback de recordProductClick() para data/clicks.json.
- [x] Fazer /api/track-click retornar erro apropriado quando a gravação em public.product_clicks falhar.
- [x] Confirmar que getAnalyticsSummary() e getProductAnalytics() consultam exclusivamente public.product_clicks.
- [x] Validar build/testes e enviar a alteração para a branch main do GitHub.


# Prompt — Analytics Profissional no Telegram

- [x] Implementar getAnalyticsSummary, getProductAnalytics, getProductAnalyticsRanking e paginação no productsRepository.ts usando exclusivamente public.products e public.product_clicks.
- [x] Atualizar o telegramBot.ts com o novo menu principal, visão geral de analytics, lista paginada de produtos, analytics detalhado por produto com períodos, ranking e tratamento de erros sem fallback.
- [x] Preservar integralmente o tracking validado no commit 109d95b e o restante do bot/catálogo.
- [x] Executar build de produção, testes e enviar commit para a branch main.
