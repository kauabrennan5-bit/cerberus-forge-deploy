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

# Bloco 2 — Arquitetura e Fonte Única de Verdade

- [x] Criar ARCHITECTURE_CONTRACT.md com fontes de verdade, contratos, identidade, fluxos, erros, fallbacks, segurança, invariantes e detecção de divergência.
- [x] Auditar e corrigir apenas fallbacks perigosos que possam mascarar indisponibilidade da fonte canônica.
- [x] Validar criação/leitura/listagem de produtos, tracking, analytics, exportação, paginação, Telegram e build sem implementar o Cerberus Operator.
- [x] Executar npm install, npm run build, lint/typecheck e testes existentes; revisar diff e enviar somente alterações necessárias para main.

# Bloco 5 — Autocorreção Segura / Safe Auto-Heal

- [x] Criar registro central de ações autorizadas com risco, pré-condições, execução, validação, rollback, timeout e cooldown.
- [x] Implementar ações seguras e idempotentes para revalidar serviços, catálogo, tracking, analytics e sincronização autorizada.
- [x] Implementar proteção contra loops com cooldown e circuit breaker, sem executar comandos arbitrários ou ações destrutivas.
- [x] Integrar o fluxo de autocorreção e o audit log ao painel do Telegram com aprovação obrigatória para ações de risco alto.
- [x] Criar SAFE_AUTO_HEAL_ARCHITECTURE.md e validar build, lint, testes existentes e ausência de exposição de segredos.
- [x] Revisar o diff e enviar somente o Bloco 5 para a branch main.

# Bloco 6 — Autonomia Operacional e Recuperação

- [x] Criar estado operacional consolidado e máquina de estados determinística com transições auditáveis.
- [x] Implementar Decision Engine separado, níveis de autonomia e Escalation Engine sem executar ações fora do Action Registry.
- [x] Orquestrar recuperação com seleção, execução, validação, recovery real, circuit breaker e fail-safe.
- [x] Aprofundar health checks de produtos, catálogo, GitHub, site e deploy sem gerar ou alterar dados.
- [x] Atualizar painel Telegram com estado, nível, pendências, escalonamentos e audit log operacional.
- [x] Criar documentação e testes do Bloco 6; validar lint, testes, build e segurança.
- [x] Revisar o diff e enviar exclusivamente o Bloco 6 para a branch main.

# Bloco 7 — Automação Completa do Ciclo de Produtos

- [x] Auditar e reutilizar o pipeline atual de automação, scraper, curadoria, repositório, sincronização e Telegram.
- [x] Formalizar lifecycle, normalização, validação comercial, duplicidade, curadoria estruturada e audit log sem criar fontes concorrentes.
- [x] Implementar fila de aprovação humana e operações administrativas de pausar, reativar e arquivar sem exclusão física.
- [x] Validar publicação somente após Supabase, projeção estática, sincronização canônica e verificação pós-publicação.
- [x] Integrar métricas do pipeline ao Cerberus Operator sem publicar produtos automaticamente.
- [x] Criar documentação e testes; validar lint, build, segurança, catálogo e analytics canônicos.
- [x] Revisar o diff e enviar exclusivamente o Bloco 7 para a branch main.

# Correções Bloco 7 — /listar Direto e Marketplace Mercado Livre (meli.la)

- [ ] Corrigir comando direto /listar no Telegram para enviar nova mensagem com a listagem paginada (sem exigir message_id pré-existente).
- [ ] Centralizar e robustecer a detecção de marketplace com allowlist explícita (Shopee, Mercado Livre, meli.la).
- [ ] Implementar resolução segura de links curtos (meli.la) com proteções SSRF, timeout, limite de redirecionamentos e validação de domínio permitido.
- [ ] Criar testes automatizados para /listar direto, resolução de meli.la e falhas de redirect.
- [ ] Validar lint, testes, build, diff de segurança e enviar para main.

# Correção Definitiva — /listar, Detector Canônico e Observabilidade

- [ ] Substituir o callback artificial de /listar por sendTelegramMessage com renderer paginado compartilhado.
- [ ] Preservar a edição de páginas products_list:<page> somente para callbacks com message_id real.
- [ ] Remover detectores locais e integrar server/services/marketplace.ts ao Telegram, automação e lifecycle.
- [ ] Adicionar logs sanitizados de update, autorização, comando, handler, paginação e resultado Telegram.
- [ ] Criar testes de regressão para /listar direto, callbacks reais, paginação, meli.la e detector único.
- [ ] Validar lint, testes, build, dist/server.cjs, segurança, commit e push para main.
