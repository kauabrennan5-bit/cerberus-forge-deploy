# Commit 3 — /publicar <reviewId> — SNAPSHOT + PLANO (DISCOVER/PLAN)

## SNAPSHOT (antes da mudança)

- Repo: kauabrennan5-bit/cerberus-forge-deploy · branch main · HEAD 308a5ac
- Serviço canônico: cerberus-forge-deploy-backend (Render srv-d9tq9sh42hec738skftg)
- Webhook: `POST /api/telegram/webhook` (server.ts linha ~945) → `handleTelegramWebhookUpdate`
- dispatcher: server/services/telegramBot.ts
  - Callbacks existentes: `approve_only`, `cancel_rev`, `confirm_pub`, `review_details`, `edit_price`, `edit_cat`
  - Comando `/publicar` atual: placeholder "ainda não disponível" (linha ~1319)
  - Painel read-only: /menu /status /pendentes /aprovados (telegramPanel.ts, Fase 25B)
- persistência: telegram_pending_reviews (Supabase) via telegramRepository (hooks setTestSavePendingReview/setTestGetPendingReview)
- Pipeline canônico: ProductPipeline (productPipeline.ts): evaluate → validateCandidate → curate → PENDING_APPROVAL → approve → publish
- validateCandidate: ERRO se preco<=0, imagens=0, URL inválida, marketplace ∉ {Shopee, Mercado Livre}
- confirm_pub handler (linha ~1138): cria createProductionProductPipeline(), evaluate/aprrove/publish, feedback final
- Testes: previewTelegramRoutes.test.ts (padrão node:test, installFakeTelegramRepo, fetch fake), telegramReadPanel.test.ts
- Gates: npm test (concurrency 1), tsc, build (esbuild dist/server.cjs), git diff --check, secret scan

## Elo auditado (respostas da Fase 25C)

- Ponto exato de entrada: callback confirm_pub — já implementa o fluxo canônico completo
- Dados do PendingReview suficientes: produto, categoria, preco, imagens, normalizedUrl, descricao, marketplace detectado — NADA falta
- /publicar = ENCaminhar review aprovada (status=published por approve_only) ao card de confirmação humana [✅ Confirmar & Publicar] + ações auxiliares (preço/categoria/detalhes/rejeitar)

## PLANO (menor alteração)

Arquivos alterados (somente 2):
1. server/services/telegramBot.ts
   - Novo handler de texto `/publicar <reviewId>` ANTES do placeholder atual:
     - valida reviewId presente (sintaxe); review deve existir
     - valida status: aceita `pending` e `published` (aprovada via approve_only); rejeita `cancelled`/`rejected` com motivo
     - valida isUserAllowed (já garantido pelo dispatcher)
     - executa lifecycle prévio: `refreshReviewLifecycle` → grava lifecycle na review → savePendingReview
     - envia card de confirmação com buildMainReviewKeyboard (confirm_pub / edit_price / edit_cat / review_details / cancel_rev)
     - feedback de erro para review inexistente, cancelada, expirada (expiresAt)
   - Atualizar placeholder /publicar sem argumentos para mostrar /pendentes (leitura) em vez de "em breve"? NÃO — manter informativo neutro: "use /publicar <reviewId> · /pendentes lista os IDs"
2. server/services/telegramPanel.ts
   - renderReadPanelMenu: atualizar linha "/publicar — em breve" → "/publicar <id> — encaminhar review à publicação (confirmação humana)"
   - renderPendingReviews: incluir ID público da review (código) em cada item para que o usuário copie → usar `r.id` (afprev-...)
   - TELEGRAM_PANEL_COMMANDS descrição de "publicar" atualizada

Invariantes preservadas:
- isUserAllowed (único ator autorizado), logTelegramEvent
- pipeline canônico INTACTO (evaluate/aprrove/publish) — /publicar só encaminha, não publica
- DECISION ≠ ACTION: publicação só ocorre via callback confirm_pub (confirmação humana explícita)
- fail-closed: lifecycle ERROR/REJECTED → review status=error, feedback, zero mutation do catálogo
- N14/N15/thresholds/weights/contracts NÃO tocados
- preço escala não verificada permanece; preco=0 na review → validateCandidate falha → ERROR (fail-closed) — comportamento esperado do pipeline
- affiliateUrl preservada em existingProduct (não entra no candidate do pipeline, que usa normalizedUrl/link)

Riscos:
- review affiliate_preview com preco=0 SEM preço observacional → VALIDATION_ERROR no pipeline (correto: fail-closed, usuário informado, pode usar edit_price antes de confirmar)
- card de confirmação enviado como MENSAGEM NOVA (não edit caption) — consistente com aprovação anterior
- idempotência: double-send /publicar gera 2 cards; harmless (confirm_pub é idempotente via pipeline APPROVED/PUBLISHED)

Testes (novos, tests/publishCommand.test.ts ~14 casos):
- sintaxe sem id; review inexistente; review cancelada; review já published → card; review pending → card
- lifecycle prévio executado e persistido (validate pass/warn)
- preco=0 → confirm_pub NÃO executado por /publicar (só encaminha) — mas registrar lifecycle ERROR é responsabilidade do confirm_pub; /publicar registra lifecycle prévio e deixa confirm_pub reavaliar? DECISÃO: /publicar registra refreshReviewLifecycle (preview) e o card mostra estado; confirm_pub faz evaluate novo (restaura ou reavalua) — confirmar comportamento.
- unauthorized → não chega (dispatcher)
- renderPendingReviews mostra IDs; menu atualizado

## CONDIÇÕES DE PARADA

- qualquer gate falhar → STOPPED — VALIDATION FAILURE
- necessidade de alterar contrato/schema/autoridade → STOPPED — SCOPE VIOLATION

## STATUS DA IMPLEMENTAÇÃO (checkpoint)

Já implementado: /publicar <reviewId> em telegramBot.ts (após /shopee, antes de /analytics).
Funciona: sintaxe sem id; lifecycle prévio via restoreLifecycleRecord/evaluate; persistência se !review.lifecycle; previewState/PREVIEW_AVAILABLE quando restore retorna PENDING_APPROVAL/APPROVED.
Painel atualizado: renderReadPanelMenu, renderPendingReviews (ID), TELEGRAM_PANEL_COMMANDS.
tsc limpo.

## BUG DE TESTE IDENTIFICADO (em investigação)

test 1 passou; testes 2-10 falham com "Cannot read properties of undefined (reading 'text')" — sentMessages vazio.
Causa provável: fetch fake captura "api.telegram.org/bot" mas sendTelegramMessage pode estar sendo chamado após o cleanup OU o fake não captura porque test 1 usa beforeEach installFakeTelegramRepo e os hooks de repo podem conflitar. Na verdade: tests 2+ também instalam fake transport. Diagnóstico pendente: adicionar log no fake para ver se fetch é chamado.
Nota: sendTelegramMessage early-returns quando !getTelegramBotToken(). FIX aplicado: process.env.TELEGRAM_BOT_TOKEN = "fake-bot-token" no topo do arquivo + restauração no afterEach.

## Padrões oficiais (para referência de testes)

- setTestSavePendingReview / setTestGetPendingReview (telegramRepository.ts)
- setTestTelegramSenders(msg, photo) (telegramBot.ts linha ~75) — hook oficial para envio
- setTestShopeeClient (shopeeCommand.ts) — cliente Affiliate injetável
- TELEGRAM_ALLOWED_USERS default "1976526372"
- previewTelegramRoutes.test.ts usa fetch fake global + installFakeTelegramRepo (mesmo padrão)
- handleTelegramWebhookUpdate(update) é o ponto de entrada do dispatcher
- buildMainReviewKeyboard(reviewId): [✅ Confirmar & Publicar], [💰 Alterar Preço · 📁 Alterar Categoria], [🔎 Ver detalhes · ❌ Rejeitar]

## CHECKPOINT 2 (após correções de teste)

Implementação completa:
1. server/services/telegramBot.ts — /publicar <reviewId> implementado (linha ~1319).
2. server/services/telegramPanel.ts — menu/pendentes/comandos atualizados.
3. server/services/productPipeline.ts — hook oficial setTestProductPipeline adicionado (linha ~207).
4. tests/publishCommand.test.ts — 10 testes, padrão node:test.

Diagnósticos de teste resolvidos:
- fetch fake substituído por setTestTelegramSenders (hook oficial).
- TELEGRAM_BOT_TOKEN="fake-bot-token" necessário (sendTelegramMessage early-return sem token).
- evaluate do pipeline lança sem envs Supabase → hook setTestProductPipeline (novo) com pipeline em memória (getProducts=[] + publish fake).
- require() não disponível em runner ESM → import dinâmico para productAutomation.

Próximo: rodar suite nova + npm test completo + tsc + build + secret scan. Depois entregar relatório A-J.

Estado prod: serviço canônico cerberus-forge-deploy-backend, SHA atual 308a5ac, webhook ok, testes 1485/1485 antes desta mudança.

## CHECKPOINT 3 — IMPLEMENTAÇÃO VALIDADA (local)

Gates locais completos e PASSANDO:
- npm test: 1495/1495 pass (antes 1485; +10 novos da suite publishCommand.test.ts)
- tsc: OK
- build: OK (dist gerado)
- git diff --check: OK
- secret scan: OK (nenhum segredo nos diffs)

Arquivos alterados (git status):
1. server/services/telegramBot.ts — /publicar <reviewId> implementado (após /analytics, antes de /start).
   - Governa status cancelled/rejected/error/expired; pré-avaliação read-only;
   - Persiste lifecycle prévio para o confirm_pub reutilizar; preço 0 → alerta AUSENTE;
   - DECISION ≠ ACTION: nada publica aqui; o confirm_pub segue canônico.
   - Marcador "// FASE 25C (Commit 3)" — FORA do bloco guardião 25B.
2. server/services/telegramPanel.ts — menu consolidado mostra /shopee N e /publicar <id> live (antes "em breve"); linha 🔎 Auditoria nos pendentes; TELEGRAM_PANEL_COMMANDS inclui publicar.
3. server/services/productPipeline.ts — hook oficial setTestProductPipeline (padrão setXForTests).
4. tests/publishCommand.test.ts — 10 testes (sintaxe, inexistente, cancelada, expirada, encaminho pendente, já aprovada, NÃO executa publish, preco=0, não autorizado, escala não verificada).
5. tests/telegramReadPanel.test.ts — guardiões de menu atualizados para estado LIVE (/shopee e /publicar sem "em breve").

Decisões de arquitetura tomadas:
- /publicar é o único elo read-panel → pipeline; execução do pipeline permanece exclusiva no callback confirm_pub (confirmação humana 2 etapas).
- Bloco 25C colocado DEPOIS do /analytics para não conflitar com guardião da Fase 25B.
- Hook setTestProductPipeline no productPipeline.ts (fábrica substituída em teste; pipeline em memória: getProducts=[] + publish fake, evaluate/curation rodam de verdade).

Estado prod atual: serviço cerberus-forge-deploy-backend, SHA 308a5ac.
Pendências para entrega: relatório A-J ao usuário (aguardando autorização para commit/push/deploy + E2E).
E2E planejado pós-deploy: /publicar <reviewId> de uma review pendente real (produto comprovado 1530442944/23794344926) + callbacks confirm_pub/cancel_rev.
