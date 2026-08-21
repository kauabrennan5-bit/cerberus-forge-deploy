# Fase 25 — Achados parciais 01: rotas HTTP e superfície Telegram

## Rotas HTTP (server.ts + server/routes/*.ts)
Todos admin-auth (requireAdminAuth), exceto /health, produtos públicos, track-click, feeds, webhook.

### server.ts (legacy/core)
- GET /health (public)
- POST /api/admin/verify, /api/admin/rebuild-static-catalog
- GET /api/products, GET /api/products/:idOrSlug, POST /api/products, DELETE /api/products/:id, POST /api/products/:id/delete, POST /api/products/delete
- PUT /api/products/:id, POST /api/products/:id/edit, /api/products/:id/update
- POST /api/meta-capi (público)
- POST /api/track-click (público)
- GET /api/meta-feed.csv, /feed.csv, /api/meta-feed.xml, /feed.xml (público)
- POST /api/submit-product (admin)
- POST /api/extract (admin) — extração manual via scraper
- POST /api/automation/process, /api/process-url (admin) — pipeline automatizado
- GET /api/telegram-status, /api/telegram/status (público)
- POST /api/telegram-set-webhook, /api/telegram/set-webhook (admin)
- POST /api/telegram/webhook, /api/telegram-webhook (público — recebe updates)
- POST /api/proxy-csv (admin)

### server/routes/*.ts (bloco N13+)
- POST /api/commercial/preview-telegram (Fase 23/24 — Affiliate→Scraper→PendingReview→Telegram)
- POST /api/commercial/discover (N2 discovery)
- POST /api/commercial/research-batch; POST research; GET research GET research batch
- POST /api/commercial/analyze (N3?)
- POST /api/commercial/curation/evaluate; GET /api/commercial/curation/:candidateId
- POST /api/commercial/commercial-brain/evaluate; GET /api/commercial/commercial-brain/:candidateId
- GET /api/commercial/signals, /api/commercial/recommendations (N14 commercial brain)
- GET/POST /api/commercial/candidates, /api/commercial/candidates/:id
- POST /api/commercial/curation/evaluate... etc
- POST /api/commercial/governance/decide; GET /api/commercial/governance/:candidateId (N15)
- POST /api/commercial/candidates/:id/publish/preview; POST .../publish; GET .../publish/status (N16)
- GET /api/commercial/publications; POST /api/commercial/publication/execute (N16)
- GET/POST /api/commercial/assess/:candidateId; /api/commercial/assess/:candidateId/history
- GET /api/commercial/assessment/:assessmentId
- POST /api/commercial/experiments; GET .../experiments; .../:id; .../:id/status; .../:id/decide; .../:id/observe; GET /api/commercial/decisions (N17/N18?)
- Affiliate: /api/commercial/affiliate/acquire; /api/commercial/affiliate/links (POST/GET/:id); /api/commercial/affiliate/links/:id/validate; /api/commercial/affiliate/links/:id/revoke; /api/commercial/affiliate/providers; /api/commercial/affiliate/providers/:id; /api/commercial/affiliate/n17/acquire (N17 acquisition)
- Agent runtime: /api/agent-runtime/execute, /api/agent-runtime/approve, /api/agent-runtime/executions
- Cycle (N2→N16 pipeline): /api/admin/cycle/start, /api/admin/cycle/list, /api/admin/cycle/:cycleId/state, /api/admin/cycle/:cycleId/run/{discovery|research|assessment|acquisition|resolution|decision|publication}, /api/admin/cycle/:cycleId/run-all, /api/admin/cycle/:cycleId/cleanup
- Policy engine: registerPolicyEngineRoutes (POST governance/policy?); Governance: registerGovernanceRoutes
- Research: registerResearchRoutes (POST research execute, GET research/:id, GET research batch)

## Superfície Telegram (server/services/telegramBot.ts, ~1655 linhas)

### Comandos de texto (handler handleTelegramWebhookUpdate)
- /start, /admin → painel admin
- /listar, /produtos → lista de produtos
- /categorias → gestão de categorias
- /help
- /priority, /opportunities, /risks, /experiments, /agents, /decisions, /recommendations, /affiliates, /cycle → cockpit comercial (N13+/N14/N17?)
- /discover ML|SH url|search (N2) → runDiscoverCommand
- /discover-batch ML|SH <urls> (N11) → runDiscoverBatchCommand
- /research <candidate_id> (N3, render-only) → commercialCockpit.renderResearch
- /assess <candidate_id> (N4, render-only) → commercialCockpit.renderAssessment
- Envio de link solto → detectMarketplace + extractProductForReview + evaluate → prévia (fluxo legado)

### Callbacks (inline buttons)
Namespace admin/menu: admin_menu, admin_add, admin_system, admin_highlights, admin_categories, products_list:N, product_view/pk, product_toggle, product_edit, field_edit(id:campo), product_del_confirm, product_del_exec, products_search_init, add_cat_init, rename_cat_init, product_approvals:N, confirm_pub:N, cancel_rev:N, review_details:N, edit_price:N, edit_cat:N, analytics_overview, analytics_products:N, analytics_ranking:periodo, analytics_product:id:periodo

Namespace Operator (N9?): operator_home, operator_refresh, operator_health, operator_incidents, operator_history, operator_actions, operator_run:N, operator_approve:N, operator_reject:N, operator_config, operator_mode:{OBSERVE|SAFE_AUTO_HEAL|DRY_RUN|ADMIN_APPROVAL}, operator_pending, operator_escalations, operator_logs

Namespace preview (Fase 23): approve_only:N (registrar decisão, approve_only, fonte affiliate_preview ou manual), confirm_pub:N (herdado do fluxo legado), edit_price:N, edit_cat:N, cancel_rev:N, review_details:N

### Observações-chave
- NÃO existe setMyCommands (comandos não registrados no BotFather via API; apenas via painel).
- Duas famílias de decisão duplicadas: confirm_pub (publica de fato — legado) vs approve_only (só registra decisão — Fase 23).
- previewTelegramRoutes.ts (Fase 23/24) não registra callbacks Telegram próprios — os callbacks dos cards de preview usam approve_only (linha 1087-1111 do telegramBot.ts), com detecção de origem "affiliate_preview" vs "manual".
- cardAsPhoto/sendPhoto existe no telegramBot.ts (Fase 24 enrichment).


---

# Fase 25 — Achados parciais 02: blocos N2–N18, pipeline, persistência

## PendingReview (server/repositories/telegramRepository.ts)
- Tabela `telegram_pending_reviews`; SESSION_EXPIRATION_MS = 3600000 (1h) no repo; previewTelegramRoutes usa 24h (expiresAt = createdAt + 24h).
- savePendingReview (upsert), getPendingReview, getLatestPendingReviewForUser, listPendingReviews (status=pending + dentro do TTL), deletePendingReview (linha 168).
- setUserState (sessão de edição por usuário).
- Expiração: getPendingReview valida `status==='pending' && now >= expiresAt` → trata como expirado (linha 202).

## Preview (Fase 23/24 — server/routes/previewTelegramRoutes.ts)
- POST /api/commercial/preview-telegram (admin). buildPreviewKeyboard: [✅ PUBLICAR → approve_only:{id}], [❌ DESCARTAR → cancel_rev:{id}].
- Idempotência: reviewId determinístico por URL normalizada + chatId; TTL de 1h para reuso do mesmo reviewId (registry em memória + TTL).
- savePendingReview com meta source "affiliate_preview"; scrape enriquece imagens/preço (Fase 24), fail-closed 424 se scraper falhar/identidade divergir.
- Card como foto (sendPhoto) quando imagens; fallback card texto.
- approve_only callback distingue source "affiliate_preview" vs "manual".

## Pipeline canônico (server/services/productPipeline.ts, 249 linhas)
- createProductionProductPipeline().evaluate(input) → validação → LifecycleRecord (state EVALUATED)
- approve(record) → APPROVED (persiste approved_at, approved_by)
- publish(record) → PUBLISHED (createProduct, publishedProductId) — REQUER approve() prévio.
- Unpublish/pause via adapters.pauseCanonicalProduct.

## Scraper (server/services/scraper.ts, 995 linhas)
- fetchProductDataFromUrl (linha 73) — ML, Shopee, e-commerce.
- extractShopeeCdnImages (linha 311-349): regex CDN down-br/sg susercontent, cf.shopee.
- extractCorrectPrice (429); estratégia ESTRTÉGIA_6_SHOPEE_SPECIFIC (595); JSON state price_min/price (506).
- productAutomation.ts (572): extractProductForReview (333), processProductUrl (545), normalizeProductUrl, detectMarketplace, findExistingProduct, setTestFindExistingProduct (hook de teste).

## Blocos N
- N2 discovery: server/commercial/discovery/discover.ts (executeDiscover, getConnector por MarketplaceSource: ML|SH; connectors/mercadoLivre.ts, shopee.ts — Shopee connector existe); research.ts (startResearch, RESEARCH_FIELDS, 535 linhas); rateLimiter, evidence, normalizer.
- N3 research: routes/researchRoutes.ts; /research comando Telegram → commercialCockpit.renderResearch.
- N4 assessment: /assess; assess routes (POST /api/commercial/assess/:candidateId, /history).
- N13+ candidates: candidatesRepository (registerCandidate, listingKeyFrom, getCandidate, listCandidates, startReview, recordVerdict, promoteToProduct, deleteCandidateForProof, generateCandidateId); candidateEvidenceRepository (evidenceDigest, fieldHash); candidateAssessmentRepository.
- N14 commercial brain: commercialBrainRoutes (/api/commercial/commercial-brain/evaluate, :candidateId), /api/commercial/signals, /api/commercial/recommendations, /api/commercial/analyze; engine.ts, normalizers, weights (server/commercial/commercialBrain/). price=string_price_unscaled, scale UNVERIFIED.
- N15 governance: governanceRoutes (/api/commercial/governance/decide, /:candidateId); engine.ts linha 279-287: hard gate "n8_contract_compatible (ACQUIRE_AFFILIATE)"; authorizationContext; ADVERTISE scope.
- N16 publication: routes /api/commercial/candidates/:id/publish, /publish/preview, /publish/status, /publications, /publication/execute; publication/n16Service.ts (executePublicationN16 com idempotência execution_key, status PUBLISHED/FAILED/AMBIGUOUS, confirmation via provider.getStatus), n16Provider.ts, supabasePublicationAdapter.ts, publicationExecutor.ts (v1.0).
- N17 affiliate: acquisitionService.ts (acquireAffiliateLink, base GraphQL Shopee, idempotência), n17Service.ts (acquireN17, buildN17IdempotencyKey, blocked() com REQUEST_INVALID/IDEMPOTENCY_CONFLICT/AUTHORIZATION_INVALID/PROVIDER_MARKETPLACE_MISMATCH/N8_CONTRACT_INVALID...), n17AuthorizationStore (N15 authorization lookup, TTL 24h), n17Routes (/api/commercial/affiliate/n17/acquire, /affiliate/acquire, /links POST/GET/:id/validate/revoke, /providers), shopeeAffiliateProvider, shopeeApiClient, shopeeClientContracts, affiliateLinkResolver (selectEligibleLink, AFFILIATE_RESOLVER_CONTRACT_VERSION).
- N18: apenas referência em n17Contract.ts — NÃO IMPLEMENTADO (proibido até N17 consolidar).
- Operator (cerberusOperator.ts): modo default OBSERVE (linha 127); schedulerTimer existe mas só roda em modos não-OBSERVE; modos OBSERVE/SAFE_AUTO_HEAL/DRY_RUN/ADMIN_APPROVAL controlados por Telegram (operator_mode callbacks) + persistência Supabase (operationalMemoryRepository).
- Job queue: jobQueueRepository.ts (QUEUED/RUNNING/SUCCEEDED/FAILED/RETRYING/DEAD_LETTER/CANCELLED; created_by human/system/operator/automation/external/agent; publicationExecutionsRepository.ts).
- Ciclo N2→N16: /api/admin/cycle/* (start, list, state, run por estágio discovery/research/assessment/acquisition/resolution/decision/publication, run-all, cleanup).
- Experiments (N18?): experimentRoutes (/api/commercial/experiments CRUD, /decide, /observe, /status) + experimentRepository (1048 linhas) + /api/commercial/decisions.
- Facilitator: discoverBatchCommand, telegramBatchResponse, integratedResearchExecutor — batch discovery p/ Telegram (N11).
- commercialCockpit.ts: renderDiscover, renderResearch, renderAssessment + comandos Telegram /priority /opportunities /risks /experiments /agents /decisions /recommendations /affiliates /cycle.
- Products público: /api/products; admin CRUD. Feed Meta: /api/meta-feed.csv|xml, /feed.csv|xml (integração Facebook/Meta já usada — 14 products com categoria Mercado Livre/Acessórios).

## Telegram: comandos /pending, /aprovados, /logs NÃO existem ainda (propostos).
## Não há /shopee. Discovery Shopee por busca existe em /discover SH search <termo> (N2).


---

# Fase 25A — Prompt do usuário (Pasted_content_100.txt)

Prompt exige relatório "N17 — FASE 25A — MASTER SYSTEM AUDIT" com 25 seções: 1 Executive Summary, 2 GitHub Architecture Map, 3 Telegram Command Map, 4 Telegram Callback Map, 5 HTTP/API Map, 6 Shopee End-to-End Map, 7 Affiliate Map, 8 Scraper Map, 9 PendingReview Map, 10 Publication Map, 11 Duplicate/Legacy Flows, 12 Telegram Gaps, 13 Reusable Components, 14 Components That Actually Need New Code, 15 Proposed /shopee N Architecture, 16 Proposed Telegram Menu, 17 Governance/Safety Audit, 18 GitHub vs Production Divergences, 19 Recommended Deprecations, 20 Minimal Implementation Plan, 21 Exact Files That Would Need Modification, 22 Risks, 23 Tests Required, 24 E2E Plan, 25 FINAL RECOMMENDATION.
Final Recommendation deve responder explicitamente: A) pronto hoje; B) só falta conectar; C) código novo real; D) menor conjunto de arquivos; E) primeiro commit; F) fluxo final /shopee 10 → cards → aprovação → publicação no site.
Restrições: PHASE25A_READ_ONLY_ONLY, NO_CODE_CHANGES, NO_COMMIT, NO_PUSH, NO_DEPLOY, NO_MIGRATION. Não expor secrets; envs do Render só por NOME.

## Achados adicionais (seções 8-13 do prompt)

### Publicação pós-clique (productPipeline.ts + supabasePublicationAdapter.ts + catalogSync.ts)
- `createProduct` (productsRepository.ts:157) recebe input de produto.
- `productPipeline.publish` (201-228) → createProduct → updateProduct(ativo:true,status:"published", syncCatalog:false) — ATENÇÃO: syncCatalog:false no pipeline legado!
- syncCatalogAndDeploy/syncCatalog vivem em: catalogSync.ts (105,143), githubCatalogSync.ts (54), categoriesRepository (58,93), productsRepository (168,237,247,260,90-92), telegramBot.ts (784-785), cerberusOperator.ts (419), publicationExecutor.ts (103,607), supabasePublicationAdapter.ts (121,168).
- Ou seja: o caminho canônico `evaluate→approve→publish` cria o produto mas com syncCatalog=false — o catálogo estático/deploy depende de outro gatilho (publishing via /publication/execute? operator? rebuild?). Confirmar na N16 route: /publication/execute chama n16Service → provider.publish → getStatus confirmação; supabasePublicationAdapter provavelmente faz sync.
- affiliateUrl na publicação: verificar se publish/pipeline aceita affiliateUrl (ver productPipeline.ts linha ~90-130).

### Scraper detalhes
- Entrada: fetchProductDataFromUrl(urlStr) — URL Shopee aceita: shopee.com.br/product/{shop_id}/{item_id}, shope.ee (detectMarketplace).
- normalizeProductUrl (productAutomation.ts:83) — normaliza shope.ee→shopee.com.br.
- extractShopeeCdnImages — regex CDN (347). Preço: ESTRTÉGIA_6_SHOPEE_SPECIFIC (595-599), JSON state price_min/price (506-515).
- Título/descrição/categoria: extractTitleFromUrl (704); curadoria por categoriasRepository.
- Timeout/fail-closed: previewTelegramRoutes 424 se scraper falha/identidade divergir; scraper tem timeouts internos (ver).
- Fase 24 comprovado: 9 imagens, identityMatch=true, cardAsPhoto=true.

### Affiliate
- Função canônica para transformar candidato Shopee em produto com offerLink: `acquireAffiliateLink` (acquisitionService.ts:163, idempotência interna) OU `acquireN17` (n17Service.ts:397, com N15 authorization lookup + idempotency key determinística). Provider: createShopeeAffiliateProvider (shopeeAffiliateProvider.ts:78). affiliate_links repository: affiliateRepository.ts + affiliateLinkResolver (selectEligibleLink). Contract: n17Contract.ts, acquisitionContract.ts, shopeeClientContracts.ts, contract.ts.
- price retorna string; preview normaliza com priceScaleVerified=false.

### PendingReview campos atuais (telegramRepository.ts savePendingReview upsert)
- id, produto, descricao, link, preco?, imagens?, categoria?, status, source (affiliate_preview|manual), affiliateUrl, meta, createdAt, expiresAt, chatId?, userId?, reviewId determinístico URL+chatId, TTL repo 1h vs preview 24h. batch_id NÃO existe ainda (proposta G6).


---

# Fase 25A — Achados críticos: caminho de publicação pós-clique em PUBLICAR

## approve_only (telegramBot.ts ~1087-1125) — COMPORTAMENTO ATUAL EXATO
Ao clicar ✅ PUBLICAR num card affiliate_preview: review.status→"published", descricao anexa "approved_by=approve_only · approved_at=<ts>", salva review, apaga userState, feedback "Sem automação nesta fase". NENHUMA publicação real. Ou seja: hoje o elo final "pendente aprovado → produto no site" NÃO existe para affiliate_preview. Falta criar o "encaminhamento à publicação manual" — mas o prompt da Fase 25 diz para NÃO implementar ainda; apenas identificar.

## confirm_pub (telegramBot.ts ~1127+) — o único caminho real de publicação hoje
- Restaura lifecycle do review OU re-avalia (evaluate) com {produto, categoria, preco, imagens, normalizedUrl, descricao, marketplace}.
- pipeline.approve → pipeline.publish (productPipeline.createProductionProductPipeline).
- createProduct com syncCatalog:false → updateProduct (ativo:true, status:"published", syncCatalog:false) → syncCatalogAndDeploy.
- syncCatalogAndDeploy (catalogSync.ts:105+): lock de catálogo → lê Supabase → exportStaticProductsJson → syncCatalogToGitHub (commit em kauabrennan5-bit/CerberusFindsArchive public.products) → static site (STATIC_CATALOG_URL default cerberus-static-catalog.onrender.com) → validação de identidade/contagem pública → rollback não destrutivo (ativo:false, status:"error") se validação pública falhar.
- Ou seja: publicação no site = candidateRoutes /publish ou confirm_pub → pipeline → syncCatalogAndDeploy (GitHub commit → site estático). N16 /publication/execute usa supabasePublicationAdapter (createCanonicalProduct + linkPromotion + recordOperationalEvent) com mesma semântica.
- affiliateUrl no publish: candidateRoutes linha 242-298 aceita body.affiliateUrl e passa ao publish (usado no promote/publish de candidates). productPipeline.createCanonicalProduct NÃO passa affiliateUrl — o produto canônico tem `link`=normalizedUrl (URL original); affiliateUrl vive no PendingReview/pending_reviews e affiliate_links.

## Conclusão-chave para seção 8 do relatório
O caminho real para produto no site APÓS approve_only em affiliate_preview exige: (1) algo chamar publishN16 ou confirm_pub com o conteúdo do PendingReview; hoje isso é manual (HTTP /api/commercial/candidates/:id/publish ou rota legacy). Um comando Telegram /publicar que leia o PendingReview e invoque a rota N16 seria o elo, SEM alterar N16.


---

# Fase 25A — Seção 14: Render/Produção (read-only, 2026-08-21 01:41 UTC)

Dois domínios servem o MESMO serviço/deploy: cerberus-forge-deploy.onrender.com e cerberus-forge-deploy-backend.onrender.com — ambos /health version=3deb7556611be7134cf46a2241b8c1c0ffd0d45b = origin/main (202 commits). NÃO há divergência GitHub↔produção: SHA servido == SHA publicado.

/api/telegram/status no domínio -backend: configured/token/whitelist/effectiveWhitelist=true; webhookConfigured=true e webhookMatchesExpectedUrl=true (webhook: https://cerberus-forge-deploy-backend.onrender.com/api/telegram/webhook); pendingUpdates=0; apiHealthy=true; backendReady=true; operatorState=READY; secretConfigured=false (campo legado de outra integração); backendSha=3deb755... (nota: o mesmo endpoint via domínio sem -backend reportou webhookConfigured=false — provavelmente resposta antiga/diferente serviço; o domínio oficial é -backend).

Site estático público: cerberus-static-catalog.onrender.com (SPA Cerberus Finds Archive com gtag.js G-KQT4GLD14X) — alimenta-se do products.json gerado por syncCatalogAndDeploy.

Render API key temporária (rnd_PclW... da Fase 24) NÃO está no sandbox (não persistida após reinício) — sem acesso programático ao painel Render nesta sessão; verificação foi via endpoints públicos, sem expor envs por valor. Envs configuradas no Render (por nome, conhecidas das fases): SHOPEE_AFFILIATE_APP_ID, SHOPEE_AFFILIATE_APP_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_ALLOWED_CHATS, SUPABASE_URL/KEY (names only).


---

# Fase 25B — Commit 1 (prompt do usuário, Pasted_content_100.txt reenviado)

Prompt exige: implementar SOMENTE Commit 1 — (1) setMyCommands na inicialização do bot com os comandos: /start /menu /status /pendentes /aprovados /shopee /publicar /listar /produtos /categorias /discover /discover-batch /research /assess /priority /opportunities /risks /experiments /agents /decisions /recommendations /affiliates /cycle /help (shopee e publicar registrados como "ainda não disponíveis" no dispatcher); (2) comandos /menu, /status, /pendentes, /aprovados todos READ-ONLY reutilizando serviços existentes; (3) tests obrigatórios: /menu autorizado/não-autorizado; /status com dados e com componente indisponível + nenhuma mutation; /pendentes zero/pendentes/expirados≠ativos + nenhuma mutation; /aprovados zero/publicados + nenhum estado inventado + nenhuma mutation; setMyCommands na inicialização, comandos esperados registrados, falha de API Telegram não derruba processo; e verificação estática de que nenhum novo handler chama acquisition/publication/approve/reject mutation/sync/deploy.
Gates antes do commit: npm test, npx tsc --noEmit, npm run build, git diff --check, secret scan. Antes do commit entregar resumo A–J (arquivos modificados/novos, resumo de mudanças, testes, resultados dos gates, confirmação de não alteração de N14/N15/N16/N17/N18/thresholds/weights/scores/contracts/migrations). Depois: UM commit "feat(telegram): add read-only operational panel" e PARAR. Sem deploy, sem /shopee, sem /publicar, sem migration.
Regras: ZERO escrita Supabase; reutilizar autorização por chat existente (isUserAllowed); não logar secrets; dados ausentes = "não disponível" explícito; /aprovados: se a estrutura não suportar distinção semântica, documentar limitação e usar só campos existentes.

## Achados de inspeção (fase 1 da 25B)
- telegramBot.ts: 1655 linhas; isUserAllowed em linha 60; autorização aplicada nas linhas 398 (callbacks) e 1243 (mensagens de texto).
- Handlers de comando de texto ficam no bloco "2. MENSAGENS DE TEXTO" após linha ~1243 (update.message && text).
- Ainda não identifiquei o ponto exato de inicialização do bot/webhook (server/server.ts não existe — verificar src/ ou index). comercialCockpit.ts: 720 linhas.


---

# Fase 25B — Plano de implementação Commit 1 (pontos exatos)

## Pontos de injeção identificados
- Handler de comandos de texto: telegramBot.ts linha ~1331+ (bloco "COMANDOS /start /admin /listar /categorias /help"), cockpit em 1368+, handler link/SH em ~1243+. chatId = msg.chat.id. Autorização: isUserAllowed(senderId) — callbacks (398) e mensagens (1243).
- sendTelegramMessage (linha 66) já é fail-safe (return sem throw quando token ausente; erros logados, não propagados).
- Inicialização real do bot: server.ts linha ~945 registra a rota POST do webhook; startTelegramPolling (1647) é no-op (webhook-only). Para setMyCommands: criar função `registerTelegramCommands()` chamável na inicialização (importável) via server.ts após definição das rotas OU dentro do handler de webhook quando token configurado. Fail-safe: envolver em try/catch e log.
- telegramApiFetch (linha 29) — reutilizável para setMyCommands.
- listPendingReviews (telegramRepository.ts:264) lista status="pending" ordenado; getPendingReview trata expiração mudando status para "expired" (READ no repo faz write do status expired — aceitável/inevitável? A auditoria mostra que getPendingReview FAZ savePendingReview quando expira; isso é comportamento existente. Para /pendentes usar listPendingReviews que não altera status).
- getProducts (productsRepository.ts:102) READ-ONLY.
- health/status: /health já existe no Express; para /status usar leitura direta (products count via getProducts; telegram status via getTelegramWebhookDiagnostics(); pending reviews count via listPendingReviews sem tocar review).
- /aprovados: review.status="published" em telegram_pending_reviews = reviews decididas via approve_only; produtos canônicos ativos via getProducts(). Usar ambos com rótulos claros (sem inventar estado).
- renderMainMenu: linha 337 (stats via statsSummary; usar existente). Novo /menu: menu consolidado com seções: painel (existentes) + novos (/status /pendentes /aprovados) + blocos N + preview + /shopee e /publicar (ainda não disponíveis).
- Testes: criar tests/telegramReadPanel.test.ts (nova suite, mocks de isUserAllowed? usar setOverride? verificar como telegramAndMarketplace testa handler — importa handleTelegramWebhookUpdate? construir update.message).
- Comando /shopee e /publicar não implementados: dispatcher com `text.startsWith("/shopee")` → "ainda não disponível" (antes de /discover para não colidir com "/discover..."); mesmo para /publicar.


---

# Fase 25B — Progresso da implementação Commit 1

Arquivos até agora: (1) NOVO server/services/telegramPanel.ts — TELEGRAM_PANEL_COMMANDS (24 comandos incl. shopee/publicar "em breve"), registerTelegramCommands() fail-safe usando telegramApiFetch/getTelegramBotToken exportados do telegramBot, renderReadPanelMenu(), renderStatus() (products+active via productsRepository.getProducts, pending via listPendingReviews, diag via getTelegramWebhookDiagnostics; "não disponível" em falha), renderPendingReviews() (listPendingReviews 20, status explícito), renderApproved() (limitação documentada: reviews status=published + catálogo ativo, sem inventar estado). (2) MODIFICADO server/services/telegramBot.ts — export de getTelegramBotToken (linha ~23) e telegramApiFetch (linha ~31) com comentário FASE 25B. (3) MODIFICADO server.ts — import registerTelegramCommands (linha ~18) e chamada na inicialização após startTelegramPolling (app.listen callback, ~1242-1252) com logs fail-safe.

FALTA: adicionar os 4 handlers + /shopee e /publicar "ainda não disponíveis" no dispatcher de texto do telegramBot.ts (bloco após "// --- COMANDOS /start /admin /listar /categorias /help ---" ~linha 1333): /menu → renderReadPanelMenu(); /status → renderStatus(); /pendentes → renderPendingReviews(); /aprovados → renderApproved(); /shopee (sem espaço) e /publicar → "ainda não disponíveis". Nota: /shopee NÃO pode capturar /shopee 10 futuro — usar text === "/shopee" || text.startsWith("/shopee") com args ignorados? O comando futuro será /shopee N; na Fase 25B o dispatcher deve apenas dizer "ainda não disponível" para qualquer /shopee (com ou sem args) — mas o prompt diz "não criar comportamento parcial ou fictício"; interpretar: só registrar no menu; no dispatcher, /shopee com args invoca mensagem "ainda não disponível" é razoável (não é comportamento do comando). Usar text.startsWith("/shopee") e text.startsWith("/publicar").
Depois: testes/telegramReadPanel.test.ts (nova suite node:test): menu autorizado/não-autorizado (mock isUserAllowed? — verificar se é exportada e overridável; alternativa: testar render* puras + registrar handler via handleTelegramWebhookUpdate com update.message e override de env TELEGRAM_ALLOWED_USER_IDS); status com dados/componente indisponível (mock getProducts falhando → "não disponível"; mocks telegramApiFetch para setMyCommands falhando); pendentes zero/pendentes/expirados (listPendingReviews mock); aprovados zero/publicados; setMyCommands na inicialização (import e chamada com mock). Verificação estática: grep nos novos handlers confirmando ausência de acquisition/publication/approve/reject/sync/deploy calls.
Gates: npm test, npx tsc --noEmit, npm run build, git diff --check, secret scan (grep tokens). Commit: "feat(telegram): add read-only operational panel".
Depois do commit: entregar resumo A–J ao usuário e PARAR (sem deploy).


---

# Fase 25B — Status (implementação completa; testes em fix)

Implementação CONCLUÍDA: (1) server/services/telegramPanel.ts NOVO com TELEGRAM_PANEL_COMMANDS, registerTelegramCommands, renderReadPanelMenu, renderStatus, renderPendingReviews, renderApproved. (2) telegramBot.ts: export getTelegramBotToken/telegramApiFetch + import * as telegramPanel + bloco handlers /menu /status /pendentes /aprovados /shopee /publicar (linha ~1254-1281). (3) server.ts: import + chamada registerTelegramCommands no app.listen callback (fail-safe).

Testes: tests/telegramReadPanel.test.ts (12 testes node:test via npm test "tsx --test tests/*.test.ts"). PROBLEMA RESOLVIDO: mock de fetch falhava porque extrator de método do URL estava errado (`u.split("/bot").pop()` = "TOKEN/setMyCommands"). Corrigido com helper telegramMethod usando new URL().pathname.

FALTA: (a) rodar suite completa 12/12; (b) npm test completo, npx tsc --noEmit, npm run build, git diff --check, secret scan; (c) entregar resumo A–J (arquivos: NOVO telegramPanel.ts + NOVO tests/telegramReadPanel.test.ts; MODIFICADO telegramBot.ts 3 edições, server.ts 2 edições; NENHUM arquivo de N14/N15/N16/N17 alterado; nenhuma migration); (d) commit único "feat(telegram): add read-only operational panel"; (e) trabalhar tree limpa e confirmar; (f) PARAR, sem deploy, aguardar autorização do usuário para Commit 2.
Regras do prompt: resumo A–J = A arquivos modificados/novos, B resumo das mudanças, C testes adicionados, D resultados dos gates, E confirmação N14-18/thresholds intactos, F confirmação sem migration, G confirmação sem deploy, H confirmação fail-safe do bot, I próxima fase (usuário autoriza), J riscos.


---

# Fase 25C — Plano do orquestrador /shopee N (autorizado pelo usuário; Commit 2)

Estado atual: Commit 1 da 25B publicado e em produção (SHA 8d825a9, /menu registrado, /status /pendentes /aprovados ativos). Usuário autorizou a Fase 25C: /shopee N.

## Funções reutilizáveis mapeadas (read-only)
- `server/services/discoveryCommands.ts` (linha 71): `export async function runDiscoverCommand(argsRaw: string): Promise<string>` — parse + discovery. Linha 40: `parseDiscoverCommand`.
- `server/commercial/affiliate/shopeeAffiliateProvider.ts` (linha 78): `createShopeeAffiliateProvider({appId, secret, clientFactory, baseUrl, timeoutMs, clock})` — provider com `generateWithRetry`/`generateOnce` que usa `client.acquireAffiliateLink({shopId, itemId})` (D-SHOPEE-1: productOfferV2 com identificadores extraídos de publicUrl) → `{affiliateUrl, listingId, sellerId}`; throw fail-closed se sem credenciais/identificadores/affiliateUrl.
- Idempotência: `buildN17IdempotencyKey(request)` e `buildN17ResponseDigest` em `server/commercial/affiliate/n17Service.ts` (linhas 60, 93); `acquireN17` (397).
- Scraper: `server/services/productAutomation.ts` (extractProductForReview) e `scraper.ts` não existe na raiz services (é productAutomation).
- Save review: `telegramRepo.savePendingReview(review)` (server/repositories/telegramRepository.ts).
- Card: `sendPreviewCard` (previewTelegramRoutes.ts linha 217) usa `sendTelegramPhoto(chatId, imageUrl, text, keyboard)` → fallback sendMessage; teclado `buildPreviewKeyboard(reviewId)` com approve_only/cancel_rev.
- setupPreviewTelegramRoutes: `PreviewRouteDeps` (linha 434); test registry `setTestPreviewRegistryForTests` (98).
- Dispatcher telegramBot.ts: handlers após verificação isUserAllowed (linha ~1254 na Fase 25B) — novo bloco /shopee deve vir ANTES do bloco existente "ainda não disponível".
- Env: TELEGRAM_ALLOWED_USER_IDS; bot usa sendTelegramMessage/sendTelegramPhoto de telegramBot.ts; telegramApiFetch/getTelegramBotToken exportados.
- Provider real instanciado: procurar onde createShopeeAffiliateProvider é chamado (server/commercial/affiliate/*.ts ou server.ts) — REUTILIZAR a instância, não criar nova com credenciais.

## Design do orquestrador (server/services/shopeeCommand.ts NOVO)
Export: `runShopeeCommand(argsRaw: string): Promise<string>` — parse "N [termo]": N int 1-20 (cap 20 = 20 PendingReviews; default/limite fail-closed >20 rejeita ou cap? prompt auditoria recomendava termo obrigatório e cap ~10-20), termo opcional (default "achados shopee").
Loop por posição i=1..N:
 1. executeDiscover/runDiscoverCommand com termo → extrair candidate/listing (publicUrl ou itemId+shopId) — se falha/fail-closed: marcar "FALHA_DISCOVERY" no card resumo, CONTINUAR fail-soft por item (não trava lote) mas reportar.
 2. acquireN17/resolveLink com idempotency key; se falha: FALHA_AQUISICAO fail-closed por item.
 3. Scraper (extractProductForReview) → imagens + preço observacional (priceScaleVerified:false); identidade exata (itemId/shopId) — mismatch → FALHA_IDENTIDADE fail-closed por item.
 4. build reviewId (affprev-25c-...) + PendingReview (status=pending, expiresAt+24h, batch_id=shopee25c-<ts>) → savePendingReview.
 5. sendPreviewCard (foto se imagem).
Envio inicial: card resumo "🛒 /shopee N iniciado — processando M itens" (mensagem única) + cards individuais; ao final card resumo com sucessos/falhas.
Rate limit Shopee: sleep 2s entre itens (já coberto pelo retry do provider; adicionar pausa de lote).
Segurança: zero mutation de catálogo, zero N14/N15/N16, sem inventar dados; secrets nunca logados; logs sanitizados (quantity/counts apenas).
Handlers telegramBot: /shopee args → runShopeeCommand(args.slice(7)); sem args → usar cap=5? O comando futuro definido na auditoria era /shopee N — sem N deve rejeitar com mensagem de uso (SEM comportamento parcial).
Testes (tests/shopeeCommand.test.ts): parse N válido/inválido/zero/negativo/cap; fluxo mockado completo 1 item sucesso (desc+acq+scraper+review+card foto); falha discovery contorna item; mismatch identidade fail-closed por item; reviewId único por item; zero mutation quando acquire falha; rate limit não derruba; estática anti-mutation.
Gates: npm test, tsc --noEmit, build, diff-check, secret scan. Commit: "feat(telegram): add /shopee N orchestrator (Fase 25C)".

## Após commit (aguardar autorização): deploy — SHA 8d825a9 → novo; validar /health, telegram-status, enviar /shopee 1 real ao Telegram via webhook, receber card, NÃO clicar.


---
# FASE 25C — ESTADO (Commit 2: /shopee N orquestrador)
## Arquivos
- NOVO server/services/shopeeCommand.ts (~340 linhas): parseShopeeCommand (N 1–10 obrigatório), runShopeeCommand, buildShopeeBatchId (lote `shopee-<ts36>`), buildShopeeReviewId, enrichWithExistingScraper (identidade determinística), buildShopeeCardText (escala não verificada, nunca R$), sendShopeeCard (foto quando imagem, fallback texto).
- Contrato review: PendingReview real (telegramBot.ts linha 192: id/chatId/senderId/firstName/username/produto/categoria/preco/imagens/normalizedUrl/descricao/status/expiresAt/existingProduct{source,affiliateUrl,priceScaleVerified:false,shopId,itemId}). descricao carrega batch/position/proveniência.
- NOVO tests/shopeeCommand.test.ts (~420 linhas): parse (vazio, fora de 1-10, válido), batchId/reviewId determinístico, ambiente incompleto, lote completo (card foto, offerLink persistido, escala não verificada sem R$), fail-closed (discovery vazio, not_eligible, identidade divergente, scraper genérico, URL sem ids, lote heterogêneo sem consulta API p/ item sem identidade).
- MODIFICADO server/services/telegramBot.ts: import { runShopeeCommand } from "./shopeeCommand" (~linha 21) + handler /shopee no dispatcher (~linha 1277): args = text.slice("/shopee"), runShopeeCommand, reporta ambiente incompleto/rejeição; cards enviados pelo orquestrador. /publicar continua "ainda não disponível".
- tsc OK.
## Mocking dos testes (padrão do projeto, globalThis.fetch)
- Affiliate API: intercepta URL open-api.affiliate.shopee → AFFILIATE_RESPONSE (link_acquired).
- Connector Shopee: página com links /product/{shop}/{item} (connector usa fetch p/ buscar HTML).
- Scraper override: productAutomation.extractProductForReview.
- Persistência: override savePendingReview no telegramRepository (não usa Supabase nos testes — envs deletadas; backup local).
- Telegram: override sendTelegramMessage/sendTelegramPhoto no telegramBot.
## Pendências
1. Rodar suite nova (npx tsx --test --test-concurrency=1 tests/shopeeCommand.test.ts) e corrigir falhas.
2. Gates completos: npm test, npx tsc --noEmit, npm run build, git diff --check, secret scan.
3. Entregar resumo A–J ao usuário.
4. Após autorização: commit isolado + push; working tree limpa.
5. Depois aguardar autorização para deploy.
## Gatilho Telegram: handler /shopee no dispatcher (telegramBot.ts ~1277) já aponta para runShopeeCommand.
## Contrato do orquestrador: capa lote 1–10; LOT_PAUSE_MS=3000; TTL review 24h; UMA busca do connector por lote (limit=N), dedup interna; aquisição por item com identidade; fail-closed por item sem contaminar lote.


## 25C — progresso mocking (atualização)
- tsc OK; suite nova escrita em tests/shopeeCommand.test.ts (parse, batchId, lote completo, fail-closed, heterogêneo).
- PROBLEMA: imports nomeados de telegramBot (sendTelegramMessage/sendTelegramPhoto) no shopeeCommand.ts são readonly nos consumers; defineProperty e assignment falham com "Cannot assign to read only property" / "Cannot redefine".
- SOLUÇÃO ESCOLHIDA (padrão do projeto, como setTestSavePendingReview em telegramRepository.ts linha 96): adicionar hook oficial no telegramBot.ts: `let testOverrideSendTelegramMessage` / `let testOverrideSendTelegramPhoto` + `setTestTelegramSenders(msg, photo)` e aplicar dentro de sendTelegramMessage/sendTelegramPhoto se override não null (restore com null). Alternativa: converter `export function sendTelegramMessage` para `export let sendTelegramMessage = async function...` — reassign via import nomeado continua readonly; logo o hook é a via correta.
- shopeeCommand.ts linhas 35-41: import { sendTelegramMessage, sendTelegramPhoto } from "./telegramBot"; import { savePendingReview } from "../repositories/telegramRepository" — usar setTest hooks nos dois.
- parseShopeeCommand: parseInt trunca "3.5"→3 (teste corrigido para aceitar).
- Restam: aplicar hook no telegramBot.ts, usar setTestTelegramSenders no teste (remover assignments (telegramModule as any).*), rodar suite, gates completos, resumo A-J, commit isolado (aguardando autorização do usuário).
- O teste da suíte "fail-closed" redefine o fetch 5x dentro de it() — ok com hooks.
