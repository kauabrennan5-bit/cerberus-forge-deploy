# N17 Fase 24 — PROVA E2E NO SHELL RENDER (Caminho A) — Estado

PROOF_RUN_ID: N17_PHASE24_E2E_SHELL_20260821
Autorização: usuário autorizou Caminho A (prova no Shell Render via navegador, SEM commit/push/deploy/restart).

## Regras da prova (do prompt do usuário)
1. Levar arquivos da Fase 24 ao Shell/runtime temporário (não colar manualmente — o agente faz pelo navegador).
2. Executar scripts/phase24_e2e_probe.ts no Shell.
3. Produto: shop_id=1530442944, item_id=23794344926 (https://shopee.com.br/product/1530442944/23794344926)
4. Validar: Affiliate → productLink oficial → scraper → identidade → imagens/preço → card Telegram.
5. Registrar APENAS resultado sanitizado (status, identidade, qtd imagens, campos, proveniência, resultado Telegram).
6. SEM commit/push/deploy/restart produção/alteração permanente no repositório.
7. SEM publicação/aquisição/N15/N16/N18/mutation catálogo.
8. Se scraper bloqueado pela Shopee: parar e reportar (SEM bypass/fallback/mudança de política).
9. Limpar arquivos temporários do Shell no final sem tocar código publicado.
10. Entregar relatório E2E completo e AGUARDAR autorização antes de commit/push/deploy da Fase 24.

## Estado atual
- Render service: cerberus-forge-deploy-backend (dashboard.render.com — login OK no browser sandbox).
- Health produção: OK, version=cdaf1bc1ddd61902d0f086b8a5947ee5a3b707f3 (Fase 23, SEM código da Fase 24).
- Shell do Render: o deploy web service Render NÃO tem git clone no Shell por padrão? (verificar — nas Fases 14 o script probe_offer_schema.ts JÁ ESTAVA no código publicado; aqui não está).
- Arquivos locais alterados (Fase 24):
  * server/routes/previewTelegramRoutes.ts
  * server/services/productAutomation.ts (hook setTestFindExistingProduct)
  * tests/previewTelegramRoutes.test.ts
  * scripts/phase24_e2e_probe.ts (probe da prova — validado em tsc)
- Estratégia para levar arquivos ao Shell: usar base64+heredoc via Shell do Render (3 arquivos + probe) OU verificar se o Shell tem git (render web services têm /opt/render/project/src com o código?). Se o código-fonte está no /opt/render/project/src, posso gravar os arquivos lá (apenas em memória do container — efêmero, sem push/deploy).

## Probe (scripts/phase24_e2e_probe.ts)
- Sobe express local com setupPreviewTelegramRoutes (requireAdminAuth no-op), chama
  POST /api/commercial/preview-telegram com a URL oficial do produto.
- Saída: JSON sanitizado (sem preço real, sem secrets) com proofRunId, probeStep,
  httpStatus, affiliateLinkStatus, affiliateUrl, identityMatch, extractedImageCount,
  hasScrapedPrice, cardSent, cardAsPhoto, priceScaleVerified, note, error.

## Como chegar ao Shell
- Dashboard → serviço cerberus-forge-deploy-backend → aba/logs → "Shell" (bash icon).
- Render Shell: bash no container do serviço; node/npm/pnpm/tsx disponíveis (service Node).
- Escrever arquivos: cat > path <<'EOF' ... EOF (heredoc com base64 -d se necessário).

## Resultado (preencher ao executar)
- PROOF_RUN_ID: N17_PHASE24_E2E_SHELL_20260821
- HTTP_STATUS: ?
- IDENTITY_CONFIRMED: ?
- IMAGE_COUNT: ?
- HAS_SCRAPED_PRICE: ?
- CARD_SENT / CARD_AS_PHOTO: ?
- PRICE_SCALE_VERIFIED: false (esperado)
- CLEANUP_DONE: ?

## Uploads temporários (para curl no Shell Render)
- server/routes/previewTelegramRoutes.ts → https://files.manuscdn.com/user_upload_by_module/session_file/310519663849027308/npUvudAxOcIDyBiT.ts
- server/services/productAutomation.ts → https://files.manuscdn.com/user_upload_by_module/session_file/310519663849027308/MkaDaQctRTMEKyrD.ts
- scripts/phase24_e2e_probe.ts → https://files.manuscdn.com/user_upload_by_module/session_file/310519663849027308/ClXrjnpOEeGomHkn.ts
- Secret scan: limpo (nenhum secret nos 3 arquivos)

## Shell Render: conectado (Instance 6nc52), service srv-d9tq9sh42hec738skftg
Comandos a executar no Shell (em sequência):
1. VERIFICAR AMBIENTE: pwd && ls && which node npx tsx && node -v
2. BAIXAR ARQUIVOS:
   curl -sL https://files.manuscdn.com/user_upload_by_module/session_file/310519663849027308/npUvudAxOcIDyBiT.ts -o /tmp/f24_route.ts
   curl -sL https://files.manuscdn.com/user_upload_by_module/session_file/310519663849027308/MkaDaQctRTMEKyrD.ts -o /tmp/f24_auto.ts
   curl -sL https://files.manuscdn.com/user_upload_by_module/session_file/310519663849027308/ClXrjnpOEeGomHkn.ts -o /tmp/f24_probe.ts
3. APLICAR TEMPORARIAMENTE (SOBREPONDO, sem restart):
   SRC=$(node -e "console.log(require('/opt/render/project/src/package.json').main||'dist/server.cjs')") — o serviço roda dist/server.cjs? Verificar.
   cp server/routes/previewTelegramRoutes.ts /tmp/orig_route.ts.bak? Não necessário — /tmp não afeta o deploy (o deploy é só leitura dos arquivos do repo). A rota é importada por dist/server.cjs (compilado), então sobrescrever o .ts do SOURCE não tem efeito no runtime compilado!
   ⚠️ IMPORTANTE: o runtime serve dist/server.cjs (esbuild build). Overwrite de .ts do source NÃO funciona. Precisamos OU (a) re-compilar (npx tsc/esbuild e copiar dist — mas o server.cjs usa require dos .ts transpilados; previewTelegramRoutes é importado por server.cjs → sobrescrever dist/server/routes/previewTelegramRoutes.js funciona) OU (b) rodar tsx com o source direto.
   Decisão: usar tsx diretamente: `npx tsx /tmp/f24_probe.ts` — o probe cria um express server local e importa setupPreviewTelegramRoutes do SOURCE .ts (tsx transpila em memória). O source precisa estar no filesystem: copiar os .ts para /opt/render/project/src/... ou usar importmap? tsx resolve caminhos relativos do arquivo de entrada (/tmp) — importa '../server/routes/...' relativo a /tmp → NÃO existe. SOLUÇÃO: copiar os arquivos para /opt/render/project/src/server/... e o probe para /opt/render/project/src/scripts/, depois `cd /opt/render/project/src && npx tsx scripts/phase24_e2e_probe.ts`.
   Isso NÃO altera o deploy (dist não é recompilado, não há restart; os arquivos .ts são fonte de referência e o servidor roda o .cjs).
4. EXECUTAR: cd /opt/render/project/src && npx tsx scripts/phase24_e2e_probe.ts
5. GRAVAR RESULTADO: ... > /tmp/probe_result.json && cat /tmp/probe_result.json
6. CLEANUP: rm /tmp/f24_*.ts /tmp/probe_result.json; e reverter os .ts copiados para o original? → copiar originais de volta: pegar via git? o Shell pode não ter .git. Alternativa: não copiar para src — rodar o probe de um dir próprio:
   mkdir -p /tmp/probe/src/server/routes /tmp/probe/src/server/services /tmp/probe/src/server/commercial/affiliate
   copiar route+productAutomation+probe; tsx resolve imports da rota → a rota importa serviços do mesmo package via '../services/...'? Sim: imports relativos → copiar também os módulos importados pela rota (scraper.ts, telegramRepository.ts, previewRegistry, shopeeApiClient etc.). Complicado.
   MELHOR: usar NODE_PATH/env para tsx? Ou patch tsconfig paths? 
   MAIS SIMPLES E SEGURO: sobrescrever dist/server/routes/previewTelegramRoutes.js (compilado do ts) e server/services/productAutomation.js. Mas esbuild? package.json build usa esbuild (dist/server.cjs único bundle?). Verificar estrutura do dist! Se bundle único, sobrescrever módulo dentro do bundle não funciona → usar require cache override no probe.
   OPÇÃO FINAL: probe com loader que sobrescreve o módulo no require cache:
   `const r = require.resolve('/opt/render/project/src/dist/server/routes/previewTelegramRoutes.js')` — se a rota está no bundle, não existe o arquivo separado.
   ⇒ PASSO 0: no Shell: ls dist && ls dist/server/routes 2>/dev/null — descobrir estrutura do build.

## Status Shell Render (2026-08-21 ~00:55)
- Shell aberto em https://dashboard.render.com/web/srv-d9tq9sh42hec738skftg/shell, Instance 6nc52.
- Browser sandbox logado na conta Render do usuário.
- Terminal do Web Shell: área clicável nas coordenadas aproximadas (558,300) numa viewport 892x768 — clicar ali e usar browser_input com texto + Enter.
- Primeiro comando enviado (verificar output): `pwd && ls /opt/render/project/src/server/routes/ | head -20 && which node tsx npx && node -v && ls /opt/render/project/src/node_modules/.bin/tsx; echo SHELL_READY`
- O output precisa ser lido com browser_view (terminal pode precisar de scroll).
- Build = bundle único dist/server.cjs (esbuild --packages=external). Fonte TS em /opt/render/project/src (commit cdaf1bc).
- Plano confirmado: curl dos 3 arquivos CDN para /opt/render/project/src/server/routes/previewTelegramRoutes.ts, /opt/render/project/src/server/services/productAutomation.ts, /opt/render/project/src/scripts/phase24_e2e_probe.ts; depois `cd /opt/render/project/src && npx tsx scripts/phase24_e2e_probe.ts` (tsx transpila source em memória; imports relativos da rota resolvem o source sobrescrito).
- Cleanup final: apagar os 3 arquivos (git checkout dos 2 .ts para restaurar original — verificar se há .git no container; senão, copiar backup dos originais via curl ANTES de sobrescrever: cdn backup dos cdaf1bc não disponível; alternativa: salvar cópia local dos .ts atuais antes via `cp` para /tmp/ antes de sobrescrever e restaurar depois).
- Resultado da prova: gravar em /tmp/probe_result.json e copiar o JSON para o relatório.
- URLs CDN: npUvudAxOcIDyBiT.ts (rota), MkaDaQctRTMEKyrD.ts (productAutomation), ClXrjnpOEeGomHkn.ts (probe).

## Bloqueio atual no Shell Render (2026-08-21 00:56)
O Web Shell do Render (terminal xterm no iframe) NÃO está recebendo os inputs enviados via browser_input/browser_press_key: o terminal permanece em branco (só cursor no topo, canto superior esquerdo) e nenhum output aparece. Possíveis causas: (1) o terminal ainda está "Connecting..." / sessão shell não inicializou (mostrou "Connecting..." no primeiro load); (2) o xterm requer clique real com foco antes de receber input; (3) a aba Shell pode exigir reload.

Tentativas já feitas sem efeito: browser_click nas coords do terminal, browser_move_mouse, browser_input com Enter, browser_press_key Enter.

Próxima ação: fazer reload da página /web/srv-d9tq9sh42hec738skftg/shell, aguardar "Connected", clicar uma vez no terminal e tentar `whoami` novamente. Se continuar falhando após ~3 tentativas, alternativa: usar a Render API (key temporária do usuário já revogada — não temos) ou pedir usuário takeover... MAS não solicitar takeover ainda; tentar mais uma vez com reload.

## Dados salvos essenciais (não perder)
- Prova E2E: Caminho A autorizado, SEM commit/push/deploy.
- Produto: https://shopee.com.br/product/1530442944/23794344926 (shop_id=1530442944, item_id=23794344926).
- Arquivos CDN: rota=npUvudAxOcIDyBiT.ts, productAutomation=MkaDaQctRTMEKyrD.ts, probe=ClXrjnpOEeGomHkn.ts.
- Comando de prova: cd /opt/render/project/src && npx tsx scripts/phase24_e2e_probe.ts (após curl dos 3 arquivos para seus paths no source).
- Antes de sobrescrever: fazer backup cp dos 2 arquivos .ts do source para /tmp/.
- Cleanup: remover os 3 arquivos e restaurar backups.
- Probe: scripts/phase24_e2e_probe.ts (5601 bytes, validado tsc). Sobe express local porta 4173, chama POST /api/commercial/preview-telegram com header Authorization Admin (o probe usa admin password? — VERIFICAR: o probe usa adminAuth fake que ignora checkAdminAuth, mas a rota exige requireAdminAuth real? No sandbox a rota usa checkAdminAuth via deps — o probe passa deps { checkAdminAuth: fn no-op }. No Render a rota é criada via setupPreviewTelegramRoutes(deps, checkAdminAuth)? — VERIFICAR assinatura de setupPreviewTelegramRoutes em previewTelegramRoutes.ts antes de executar (linha ~590-613): se esperar admin password, o probe precisa enviá-la ou o checkAdminAuth é opcional).
- Health prod OK, version cdaf1bc (Fase 23, sem Fase 24).

## Bloqueio persistente (2026-08-21 00:58)
Após reload da página e clique de foco, o Web Shell do Render continua SEM receber input do automation: browser_input, browser_click, browser_press_key não produzem efeito no terminal xterm (terminal em branco com cursor no topo). Já tentei: 2 reloads, cliques em múltiplas coordenadas, move_mouse, input com Enter, press_key Enter.

Hipóteses restantes:
1. O Web Shell do Render requer HTTPS/WSS handshake que o browser automation (com viewport/viewport_height fixos?) não completa — pode ser bloqueio do serviço: a instância 6nc52 pode estar em sleep e o shell precisa de interação real do usuário para acordar.
2. O browser sandbox não suporta o protocolo WebSocket do xterm (a página parece "Connected" mas o terminal não ecoa).

Decisão: informar o usuário do bloqueio objetivo e propor: (a) ele mesmo abre o Shell e cola o comando pronto (posso entregar o pacote de comandos prontos em código copiável — mesmo padrão da Fase 14 Caminho 3 que ele usou com sucesso); (b) ou autorizar o deploy da Fase 24 e eu executo a prova contra o endpoint público.
OBS: na Fase 14 o usuário rodou o comando manualmente no Shell Render com sucesso. A diferença é que agora queremos que EU rode via browser — e o terminal não aceita input automatizado.
NOTA: há uma alternativa a considerar: Render One-Off Jobs (aba "One-Off Jobs" na sidebar) — não exige terminal interativo. Podia rodar um job com o comando? One-Off Jobs rodam imagem deployada, sem os arquivos novos. Não serve.
Outra: renderctl não disponível. API do Render: sem key válida (revogada).
Conclusão: caminho prático = entregar comando copiável para o usuário (mesmo padrão aceito na Fase 14) OU obter autorização para deploy.
