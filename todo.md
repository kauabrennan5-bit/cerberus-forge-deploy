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

# Melhoria de UX/UI do Analytics por Produto no Telegram

- [x] Abreviar títulos de produtos longos e exibir nome completo quando necessário.
- [x] Organizar métricas em blocos visuais claros (📈 Desempenho, 🛒 Marketplaces, 🕐 Último clique, 🌐 Origem).
- [x] Destacar o período atualmente selecionado (Hoje, 7 dias, 30 dias, Total).
- [x] Adicionar botões inline (🔎 Trocar produto, 📊 Ranking, ⬅️ Voltar, 🏠 Painel).
- [x] Mostrar percentual por marketplace e tratar origem não identificada sem inventar dados.
- [x] Executar build de produção, validar e enviar para main.

# Melhoria de UX — Paginação do Catálogo Telegram

- [x] Atualizar cabeçalho e navegação de /listar para exibir total, página atual de total e botões condicionais de anterior/próxima.
- [x] Atualizar cabeçalho e navegação de Analytics -> Escolher Produto para o mesmo padrão.
- [x] Executar build de produção, validar e enviar commit para a branch main.
