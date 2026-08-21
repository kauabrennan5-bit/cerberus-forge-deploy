# N17 Fase 23 — E2E REAL — ESTADO (snapshot interno)

## COMMIT/DEPLOY PUBLICADO
- Commit: 1ca4d3727a5482cd3fbfc7d1aa3232fe40b70ecb (main, pushed+deployed)
- URL produção: https://cerberus-forge-deploy-backend.onrender.com
- /health = 200, version=1ca4d3727a5482cd3fbfc7d1aa3232fe40b70ecb (== commit) ✓

## PROVA E2E EXECUTADA (curl, admin pw cerberus1607)
- 1ª chamada: HTTP 200, reviewId=affprev-124vbe6-mt25c9wy, card enviado ao Telegram do usuário ✓
- 2ª chamada: HTTP 200, duplicate=true (idempotência OK)
- Endpoint: POST /api/commercial/preview-telegram, body {"url":"https://shopee.com.br/product/1530442944/23794344926"}, header x-admin-password: cerberus1607
- Campo do body é `url` (não shopee_url).

## BOTÕES DO CARD NÃO FUNCIONARAM (relato do usuário)
- Card recebido no Telegram ✓ (rota + Affiliate API + envio funcionam)
- Callbacks (✅ PUBLICAR → approve_only, ❌ DESCARTAR → cancel_rev) não tiveram efeito.

## NOVO TOKEN DO BOT (usuário revogou o anterior e rotacionou)
- Bot: @CerberusFindsBot, id=8819631444
- Token novo: <TELEGRAM_BOT_TOKEN_ROTACIONADO>
- Usuário: @Kauatzx, id=1976526372, lang=pt-br
- getMe OK ✓. getWebhookInfo: resposta vazia/cortada — PRECISA RE-TESTAR (curl com -w).
- O TELEGRAM_BOT_TOKEN do Render PRECISA SER ATUALIZADO para o novo token (env var do serviço srv-d9tq9sh42hec738skftg). Render API key antiga revogada (401) — não dá pra atualizar via API; opções: browser (dashboard.render.com, logado no sandbox) ou pedir ao usuário.

## PENDÊNCIAS
1. Atualizar TELEGRAM_BOT_TOKEN no Render (browser ou usuário).
2. Diagnosticar por que callback_query não foi processado: verificar webhook do bot de produção (onde handleTelegramWebhookUpdate espera?), se webhook aponta para /api/telegram/webhook, se o bot usa polling ou webhook, e se o callback da mensagem veio após o token ser revogado (callbacks antigos com token inválido falham).
3. Correção mínima + gates + commit/push/deploy (autorizado para corrigir e revalidar).
4. Revalidar E2E: novo preview → usuário testa os 2 botões.
5. Cleanup: PendingReview affprev-124vbe6-mt25c9wy (persistido em DATA_DIR telegram_reviews.json no Render + supabase telegram_pending_reviews se tabela existir — tabela NÃO existe no schema público; save faz upsert fail-soft).
6. Key temp Render rnd_AQsU...6CEQ: JÁ REVOGADA ✓ (401).
7. Relatório final com: commit SHA, render SHA, HTTP statuses, reviewId, comportamento dos callbacks.

## FATOS DO REPO (para diagnóstico)
- telegramBot.ts: handleTelegramWebhookUpdate processa callback_query; handler `approve_only:{reviewId}` adicionado ANTES de `confirm_pub:`; usa answerCallbackQuery + getPendingReview (file fallback) + savePendingReview (status=published, descrição += approved_by=approve_only) + deleteUserState + logTelegramEvent.
- sendTelegramMessage usa fetch(api.telegram.org) — funcionou na 1ª prova (card chegou).
- cancel_rev existe (handler antigo, funciona em produção normalmente?).
- DATA_DIR telegram_reviews.json é local por instância; produção persiste também no Supabase (upsert em telegram_pending_reviews — tabela inexistente no public; warning fail-soft).

## ACHADO CRÍTICO NOS LOGS DO RENDER (11:26)
Os logs mostram: `update_received callback_query` → `admin_authorized=true` → `approve_only chat_id=1976526372 review_id=affprev-124vbe6-mt25c9wy source=affiliate_preview` (3 vezes: 11:25:58, 11:26:38, 11:26:48 — 2x usuário real + 1x meu simulate `simtest1`? não, simtest retornou 200 imediato).
CONCLUSÃO: O handler approve_only FOI executado e o logTelegramEvent rodou. A review foi marcada published. O QUE FALHOU foi a resposta visível ao usuário:
1. `answerCallbackQuery(callbackId, ...)` — se o token foi rotacionado APÓS o card ter sido enviado (com o token antigo), o callback_query chega mas answerCallbackQuery usa o NOVO token... na verdade answerCallbackQuery funciona com qualquer token válido (o token identifica o bot, não a sessão). Então deveria funcionar.
2. `editTelegramMessageCaption(chatId, messageId, feedback)` — o chatId do callback vem de cb.message.chat.id. Se a mensagem do card foi enviada com o token antigo e a edição com o token novo, edita normalmente. MAS o webhook responde 200 IMEDIATO e processa async — o Telegram espera resposta ao callback em até ~15s; se editCaption falhar, ainda assim o usuário não veria nada visível.
3. HIPÓTESE FORTE: os cliques do usuário aconteceram COM O TOKEN ANTIGO no bot (o card foi enviado pelo runtime com o token antigo? NÃO — a prova E2E usou o token antigo do Render para enviar o card ~23:23, e o usuário clicou ~23:26 — o token foi rotacionado DEPOIS do envio do card!). getWebhookInfo com o token NOVO mostra o mesmo webhook — o bot continua funcionando, mas as respostas aos callbacks podem falhar silenciosamente se o Telegram rejeitar.
   - Verificado nos logs: após "approve_only" não há log de "response_method=answerCallbackQuery" nem erro. answerCallbackQuery silencia erros no catch (console.error). O usuario disse "os botões não surtiram efeito" — ou seja, NENHUM feedback visual.
   - O Telegram mostra "This alert will be closed automatically" se showAlert=true; mas sem alert, se o answer falhar (BAD REQUEST: query identifier invalid/timeout), o usuário não vê nada.
   - O `editTelegramMessageCaption` pode ter falhado (caption vs text: o card foi enviado como sendMessage com text, não caption! editTelegramMessageCaption em mensagem de TEXTO retorna erro → feedback nunca chega ao usuário).
4. CONFIRMAR: buildPreviewCardText é enviado via sendTelegramMessage (text), mas o handler usa editTelegramMessageCaption (espera caption). Texto ≠ caption → edit falha. É um bug real.
CORREÇÃO MÍNIMA: no handler approve_only (e cancel_rev?), usar editTelegramMessageText quando apropriado (mensagem de texto) — ou enviar sendMessage de feedback. cancel_rev também usa editTelegramMessageCaption — mesmo bug potencial.
