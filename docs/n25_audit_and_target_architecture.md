# N17 — FASE 25 — AUDITORIA GERAL E CONSOLIDAÇÃO DO TELEGRAM

**DATA:** 2026-08-21
**STATUS:** AUDITORIA READ-ONLY CONCLUÍDA — nenhuma linha de código alterada.
**PROD_RUN_ID:** N17_PHASE25_AUDIT_20260821

Esta auditoria mapeou a superfície completa do sistema (comandos, callbacks, rotas HTTP, blocos N2–N18, scraper, PendingReview, pipeline canônico, persistência e integração Shopee Affiliate) e produziu a proposta de arquitetura para o Telegram como painel operacional único. O resultado é **FIVE_PHASE25_MAP_READY** — os mapas A–H seguem abaixo.

---

## A. MAPA ATUAL DO SISTEMA

O backend está organizado em três camadas: o núcleo legado (`server.ts`, ~1230 linhas, produtos, feeds Meta, webhooks Telegram), os serviços compartilhados (`server/services/`, incluindo `telegramBot.ts` com ~1655 linhas e `scraper.ts` com ~995) e o bloco comercial N13+ (`server/routes/` e `server/commercial/`). A tabela de rotas HTTP registradas é:

| Família | Endpoints | Estado real |
|---|---|---|
| Core/legado (`server.ts`) | `/health`, `/api/admin/verify`, `/api/admin/rebuild-static-catalog`, `/api/products` (CRUD), `/api/submit-product`, `/api/extract`, `/api/automation/process`, `/api/telegram-status`, `/api/telegram/webhook`, feeds Meta (públicos), `/api/meta-capi`, `/api/track-click` | LIVE — catálogo canônico de 14 produtos, feed Meta ativo |
| Discovery (N2) | `POST /api/commercial/discover`, `POST /api/commercial/research-batch`, research (POST/GET) | LIVE — `/discover ML\|SH` via Telegram já usa este serviço |
| Research (N3) | `POST /api/commercial/research/execute`, `GET /api/commercial/research/:id`, batch GET | LIVE — read-only |
| Assessment (N4) | `POST /api/commercial/assess/:candidateId`, `/history`, `GET /assessment/:assessmentId` | LIVE — read-only |
| Curation (N5) | `POST /api/commercial/curation/evaluate`, `GET /curation/:candidateId` | LIVE — read-only |
| Commercial Brain (N14) | `/api/commercial/commercial-brain/evaluate`, `/:candidateId`, `/signals`, `/recommendations`, `/analyze` | LIVE — read-only; price com `scale=UNVERIFIED` |
| Governance (N15) | `POST /api/commercial/governance/decide`, `GET /governance/:candidateId` | LIVE — com hard gate `n8_contract_compatible (ACQUIRE_AFFILIATE)` |
| Cycle (N9/pipeline) | `/api/admin/cycle/start`, `list`, `:cycleId/state`, `run/{discovery,research,assessment,acquisition,resolution,decision,publication}`, `run-all`, `cleanup` | LIVE — por estágio, sem execução automática |
| Publication (N16) | `/candidates/:id/publish/preview`, `/publish`, `/publish/status`, `/publications`, `/publication/execute` | LIVE — idempotência por `execution_key`, confirmação obrigatória |
| Affiliate (N6–N8, N17) | `/affiliate/acquire`, `/affiliate/links`, `/links/:id/validate`, `/links/:id/revoke`, `/providers`, `/affiliate/n17/acquire` | LIVE — provedor Shopee ativo (Fase 24 validada) |
| Agent Runtime (N9) | `/api/agent-runtime/execute`, `/approve`, `/executions` | LIVE — com aprovação humana |
| Experiments (N18?) | `/api/commercial/experiments` CRUD, `/:id/decide`, `/:id/observe`, `/decisions` | LIVE como registro — N18 propriamente dito bloqueado por política |
| Preview (Fase 23/24) | `POST /api/commercial/preview-telegram` | LIVE — comprovado em produção |

A persistência em Supabase tem 11 repositórios (`products`, `telegram_pending_reviews`, `candidates`, `candidate_evidence`, `candidate_assessments`*, `affiliate_links`, `job_queue`, `publication_executions`, `operational_memory`, `policy_journal`, `product_observations`). Counts atuais: **products=14, pending_reviews=9, candidates=0, evidence=0, affiliate_links=0**.

*Observação: a tabela `candidate_assessments` não existe no Supabase atual (erro 42P01 ao consultar) — o código usa `candidate_evidence` + assessment como dado derivado, coerente com o cleanup da Fase 20.

## B. MAPA ATUAL DO TELEGRAM

O bot (`handleTelegramWebhookUpdate` em `telegramBot.ts`) dispatcha por texto e callback query, com autorização por `isUserAllowed`. A superfície atual é:

| Comandos de texto | Callbacks inline | O que fazem |
|---|---|---|
| `/start`, `/admin` | `admin_menu`, `admin_add`, `admin_system`, `admin_highlights`, `admin_categories` | Painel admin legado (produtos, categorias, sistema) |
| `/listar`, `/produtos` | `products_list:N`, `product_view`, `product_toggle`, `product_edit`, `field_edit`, `product_del_confirm/exec`, `products_search_init`, `add_cat_init`, `rename_cat_init`, `product_approvals:N`, `analytics_*` | Gestão do catálogo canônico e analytics |
| `/categorias` | — | Gestão de categorias |
| `/help` | — | Ajuda |
| `/discover ML\|SH url\|search` | — | N2 discovery controlado |
| `/discover-batch ML\|SH <urls>` | — | N11 batch controlado |
| `/research <candidate_id>` | — | N3 read-only |
| `/assess <candidate_id>` | — | N4 read-only |
| `/priority`, `/opportunities`, `/risks`, `/experiments`, `/agents`, `/decisions`, `/recommendations`, `/affiliates`, `/cycle status <id>` | — | Cockpit comercial N13+ (read-only) |
| — | `operator_home/refresh/health/incidents/history/actions/run/approve/reject/config/mode/pending/escalations/logs` | Cerberus Operator (N9) — modos OBSERVE/SAFE_AUTO_HEAL/DRY_RUN/ADMIN_APPROVAL |
| — | `confirm_pub:N`, `cancel_rev:N`, `review_details:N`, `edit_price:N`, `edit_cat:N` | Fluxo legado de propostas (link solto) — `confirm_pub` **publica de fato** |
| — | `approve_only:N`, `cancel_rev:N` (cards da Fase 23/24) | Registro de decisão sem publicação — `approve_only` distingue fonte `affiliate_preview` vs `manual` |

O modo operacional default do Operator é **OBSERVE** (linha 127 de `cerberusOperator.ts`) — o scheduler interno não roda nada nesse modo, cumprindo a política de "nenhum agente habilitado automaticamente".

## C. FUNCIONALIDADES QUE SÓ EXISTEM POR HTTP/SCRIPT (FORA DO TELEGRAM)

| Funcionalidade | Endpoint atual | Por que importa |
|---|---|---|
| Preview de afiliado Shopee com imagens/preço | `POST /api/commercial/preview-telegram` | Caminho atual exige admin password digitada — não é experiência de painel |
| Aquisição N17 (`acquireN17`) | `/api/commercial/affiliate/n17/acquire` | Só via HTTP/script |
| Aquisição N6 (`acquireAffiliateLink`) | `/api/commercial/affiliate/acquire` | Idem |
| Registry de links (`validate`/`revoke`) | `/api/commercial/affiliate/links/:id/...` | Revoque de links não acessível no Telegram |
| Publish N16 (execute/preview/status) | `/candidates/:id/publish*` | Execução manual só via HTTP |
| Cycle start/run/run-all/cleanup | `/api/admin/cycle/*` | Orquestração de estágio só via HTTP |
| Extração manual via scraper | `POST /api/extract` | Legacy, duplica `/discover` |
| Rebuild do catálogo estático | `/api/admin/rebuild-static-catalog` | Manutenção só via HTTP |
| Agent runtime execute/approve | `/api/agent-runtime/*` | Duplica parcialmente `operator_actions` |
| Experiments CRUD/decide | `/api/commercial/experiments/*` | `/experiments` no Telegram é só leitura (renderDecisions) |
| Job queue (enqueue/status) | `jobQueueRepository` | Sem superfície Telegram |

## D. FUNCIONALIDADES DO TELEGRAM DESATUALIZADAS OU DUPLICADAS

1. **`confirm_pub` vs `approve_only`**: dois botões de "aprovar" com semântica diferente. O card do preview (Fase 23/24) já migrou para `approve_only`; o painel legado (`product_approvals`) ainda expõe `confirm_pub`, que **publica de fato**. Risco de decisão com efeito irreversível sem gate N15.
2. **Fluxo de link solto** (linhas ~1450+ de `telegramBot.ts`): envia link → `extractProductForReview` → `pipeline.evaluate` → prévia com `confirm_pub`. É o caminho legado paralelo ao preview de afiliado; usa o pipeline de produção (com publish real) e não usa N17/N15.
3. **`edit_price`/`edit_cat`**: herdado do fluxo legado de curadoria manual; sem equivalente no card de preview (que tem política fail-closed para preço).
4. **Comandos cockpit** (`/priority`, `/agents`, `/risks`, `/experiments`): renderizam dados do N13+ mas sem filtros, paginação ou ação — visualização, não operação.
5. **Sem `setMyCommands`**: os comandos não são registrados via BotFather API — o usuário precisa consultar `/help` ou a memória.

## E. ARQUITETURA-ALVO: TELEGRAM COMO PAINEL OPERACIONAL ÚNICO

O princípio é **reutilizar, não reimplementar**: o Telegram se torna o control plane de todas as rotas existentes, sem criar nenhum serviço novo. A arquitetura-alvo tem três camadas:

1. **Camada de comandos** — um dispatcher extensível que mapeia cada comando para o serviço já existente (ex.: `/shopee 10` → `executeDiscover` → scraper → `buildPreviewCard` → `savePendingReview` → sendPhoto). Novos comandos são roteados pelo mesmo `handleTelegramWebhookUpdate`, reutilizando `commercialCockpit`, `facilitator` e `previewTelegramRoutes`.
2. **Camada de decisões** — todos os cards emitidos pelo painel usam o par `approve_only`/`cancel_rev`. O botão `confirm_pub` do painel legado é marcado como deprecado (apenas exibido em revisão manual, não em novos cards). Toda decisão registra `chat_id`, `user_id`, `source=telegram_panel` e timestamp — a decisão humana continua sendo a única porta para mutation.
3. **Camada de observação** — `/status`, `/pendentes`, `/aprovados`, `/logs` consomem repositórios já existentes (`listPendingReviews`, `productsRepository`, `operationalMemoryRepository`, `jobQueueRepository`) sem escrever nada.

Invariantes preservadas: nada no Telegram executa N14/N15, thresholds, weights ou contratos; o pipeline canônico `evaluate → approve → publish` permanece imutável; a aprovação humana é obrigatória antes de qualquer mutation; o Operator permanece em OBSERVE até mudança de modo explícita pelo painel.

## F. FLUXO EXATO DO FUTURO `/shopee <N>`

Para `/shopee 10`, a cadeia completa seria:

1. **Origem dos 10 candidatos** — `executeDiscover` (N2) com o connector Shopee canônico (`server/commercial/discovery/connectors/shopee.ts`, busca via `https://shopee.com.br/search?keyword=...`). Por default, 1 termo de busca configurável (`/shopee 10 "termo"`); sem termo, usa o interesse comercial registrado (futuro, só com sua autorização). O rate limiter do discovery (`server/commercial/discovery/rateLimiter.ts`) limita as consultas.
2. **Deduplicação** — em dois níveis: (a) intra-batch por `source_product_id + shop_id` (mesma identidade não entra duas vezes); (b) inter-batch por `listing_key` do `candidatesRepository` (produto já conhecido/canônico é descartado, não reprocessado).
3. **Gates aplicados a cada candidato** — (a) identidade: URL pública oficial + `shop_id`/`item_id` extraídos do resultado da busca; (b) N2 evidence: cada item gera evidence com `evidence_digest`; (c) fail-closed: item que falha na busca, scraping ou verificação de identidade é relatado como falha no resumo do lote e nunca entra no lote de cards (não inventa dados).
4. **Afiliado por item** — para cada candidato aprovado nos gates, aquisição `acquireAffiliateLink`/`acquireN17` via provider oficial, com `buildN17IdempotencyKey` (replay idêntico não duplica links). `offerLink` permanece com a origem oficial — sem Seller API, sem fallback.
5. **Scraper por item** — o mesmo `scraper.ts` enriquece com imagens do CDN Shopee e preço observacional; validação determinística de identidade `shop_id`/`item_id`; se falhar, preço volta ao da Affiliate API com `priceScaleVerified: false` (política da Fase 14/24).
6. **PendingReviews relacionados** — cada card gera um `PendingReview` com `source=affiliate_preview`, `meta.batch_id` comum (hash determinístico do lote + timestamp), `reviewId` determinístico por URL + chatId, e TTL de 24h. O batch cria até N reviews; cada review é independente — descartar 1 não descarta o lote.
7. **Cards** — `sendPhoto` com galeria real quando há imagens; caso contrário card texto; botões `[✅ PUBLICAR]` (`approve_only:{reviewId}`) e `[❌ DESCARTAR]` (`cancel_rev:{reviewId}`). Um card-resumo do lote reporta: enviados N, falhas F, pendentes P.
8. **Decisões** — `approve_only` registra a decisão e encaminha ao fluxo manual existente; `cancel_rev` expira o item. Nenhuma publicação automática.

## G. ALTERAÇÕES MÍNIMAS NECESSÁRIAS (propostas, não implementadas)

| # | Alteração | Escopo | Risco |
|---|---|---|---|
| G1 | Registrar comandos via `setMyCommands` (`/menu`, `/status`, `/shopee`, `/pendentes`, `/aprovados`, `/logs`, `/discover`, `/research`, `/assess`, `/cycle`) | Só `telegramBot.ts` | Baixo — cosmetics |
| G2 | `/shopee <N> [termo]` → orquestrador batch que chama `executeDiscover` + aquisição oficial + scraper + `savePendingReview` por item, com `batch_id` | Novo módulo `server/bot/shopeeCommand.ts` reutilizando facilitator + previewTelegramRoutes | Baixo — fail-closed por item |
| G3 | `/pendentes` → `listPendingReviews`; `/aprovados` → filtro por status=approved; `/status` → health + telegram-status + counts | Leitura de repositórios existentes | Baixo |
| G4 | `/logs` → leitura de `operational_memory`/`job_queue` (read-only) | Leitura | Baixo |
| G5 | Unificação de decisão: novos cards usam `approve_only`/`cancel_rev`; painel legado mantém `confirm_pub` apenas com banner de depreciação e confirmação extra | `telegramBot.ts` | Médio — cuidado com comportamento legado |
| G6 | `batch_id` nos PendingReviews (migration DDL-only: coluna `batch_id text nullable` + índice) | DDL-only, sem tocar dados | Baixo |
| G7 | `/menu` → painel único que consolida admin_menu + operator_home | `telegramBot.ts` | Baixo |

## H. RISCOS E O QUE NÃO DEVE SER ALTERADO

**Não tocar:** N14 (engine, weights, thresholds, regra `price=string_price_unscaled/scale=UNVERIFIED`), N15 (policy, authorization, TTL), N16 (idempotência, confirmação de publicação), N17 (acquisition contract, idempotency key, fail-closed `blocked()`), contratos `shopeeClientContracts`, governance engine (hard gate `ACQUIRE_AFFILIATE`), pipeline `evaluate → approve → publish`, operator default `OBSERVE`, e a fonte de autoridade (Affiliate API para IDs/links; Affiliate API/scraper observacional para imagens/preço).

**Riscos identificados:**
1. **Duplicidade confirm_pub/approve_only** — o painel legado ainda publica de fato; qualquer novo card deve usar exclusivamente `approve_only`.
2. **Rate limiting da Shopee** — lote de 10 busca + 10 aquisições + 10 scrapes é pesado; o rate limiter do discovery deve ser respeitado e o lote deve ser sequencial com backoff, reportando falhas individualmente.
3. **TTL desencontrado** — repo usa 1h, preview usa 24h; padronizar em 24h para o painel (decisão sua).
4. **Idempotência do lote** — `/shopee 10` repetido não deve criar cards duplicados; `reviewId` determinístico já protege, mas o `batch_id` (G6) dá rastreabilidade.
5. **Anti-bot da Shopee no datacenter Render** — como observado na Fase 24, o preço pode vir `null` do scraper; o fail-closed já resolve, mas o card deve reportar a proveniência explicitamente.
6. **Secrets** — nenhum novo comando deve logar/exibir credenciais ou valores sensíveis.

---

**CLASSIFICAÇÃO: N17 — FASE 25 — AUDITORIA CONCLUÍDA. FIVE_PHASE25_MAP_READY.**

Aguardando sua autorização para implementar os comandos (G1–G7) na ordem proposta, começando pelo mínimo: G1 (setMyCommands) + G3 (comandos de observação) + G2 (/shopee).
