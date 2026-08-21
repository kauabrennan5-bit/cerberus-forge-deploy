# N17 — FASE 25A — MASTER SYSTEM AUDIT

**DATA:** 2026-08-21 01:45 UTC
**ESTADO:** AUDITORIA READ-ONLY EXCLUSIVA — `PHASE25A_READ_ONLY_ONLY` cumprido. Nenhum arquivo foi alterado, nenhum commit, push, deploy ou migration foi executado, nenhum dado foi escrito no Supabase, nenhuma configuração do Render foi tocada, e N14/N15/N16/N17/N18, thresholds, weights, scores, contracts e governance permanecem intocados. Nenhum secret foi exposto neste documento — valores sensíveis nunca são reproduzidos, apenas nomes de variáveis quando necessário.
**PROD_RUN_ID:** N17_PHASE25A_AUDIT_20260821

---

## 1. Executive Summary

O sistema é hoje uma plataforma de descoberta e publicação de produtos afiliados em que **todas as peças do caminho Shopee → site já existem e foram validadas em produção, mas o elo final "aprovação no Telegram → publicação real" está deliberadamente aberto para decisão manual**. A Fase 23 criou o preview de afiliado no Telegram (`approve_only`, sem efeito), a Fase 24 enriqueceu o card com imagens e preço observacional pelo scraper canônico, e o pipeline canônico `evaluate → approve → publish` com `syncCatalogAndDeploy` (Supabase → `products.json` → GitHub → site estático) já publica produtos de fato — porém por um caminho legado paralelo (`confirm_pub`) que não passa por N15.

Em números: 15 famílias de rotas HTTP todas **LIVE**; 19 comandos de texto e 28 callbacks inline no Telegram; 11 repositórios Supabase; 202 commits em main; produção servindo o SHA exato `3deb755` em dois domínios idênticos, webhook Telegram configurado e correspondente, operador em modo `OBSERVE` (nada automático); catálogo canônico com **14 produtos**; estado do pipeline comercial com `candidates=0` e `affiliate_links=0` (limpo pós-cleanup da Fase 20). A consolidação do Telegram como painel único exige, no mínimo, **um novo comando** (`/shopee N`), **três comandos de leitura**, o **registro dos comandos no BotFather via `setMyCommands`**, e **um comando `/publicar` que feche o elo final** — tudo reutilizando serviços existentes, sem migrar nada hoje (o `batch_id` do lote pode esperar a fase de implementação).

## 2. GitHub Architecture Map

O repositório `kauabrennan5-bit/cerberus-forge-deploy` (main, 202 commits) organiza-se em quatro camadas. A camada de entrada é o `server.ts` (núcleo legado, ~1230 linhas) que registra rotas de produtos, admin, webhooks Telegram e feeds Meta públicos. A camada de serviços (`server/services/`) contém os motores reutilizáveis: `telegramBot.ts` (~1655 linhas — dispatcher de webhook), `scraper.ts` (~995 linhas — extração multi-marketplace), `productAutomation.ts` (572 linhas — orquestrador de links), `productPipeline.ts` (249 linhas — pipeline canônico), `catalogSync.ts` (sync Supabase→GitHub→site estático com lock), `githubCatalogSync.ts`, `cerberusOperator.ts` (modo operacional com persistência), `commercialCockpit.ts` (renderizações de leitura) e `facilitator` (batch discovery). A camada comercial (`server/commercial/`) implementa os blocos N: `discovery/` (N2: `discover.ts`, connectors `mercadoLivre.ts` e `shopee.ts`, `research.ts` N3, rate limiter, normalizador), `commercialBrain/` (N14: engine, normalizers, weights), `governance/` (N15: engine com hard gate `n8_contract_compatible`), `publication/` (N16: `n16Service.ts`, `n16Provider.ts`, `supabasePublicationAdapter.ts`, `publicationExecutor.ts` v1.0), `affiliate/` (N6–N8/N17: `acquisitionService.ts`, `n17Service.ts`, `shopeeAffiliateProvider.ts`, `shopeeApiClient.ts`, `shopeeClientContracts.ts`, `affiliateLinkResolver.ts`, `n17AuthorizationStore.ts`, `n17Contract.ts`), `cycle/` (N9 orquestração por estágio) e `experiments/`. As rotas (`server/routes/`) expõem essas famílias; os repositórios (`server/repositories/`, 11 arquivos) encapsulam Supabase; `tests/` cobre o conjunto; `docs/` registra as provas das fases.

## 3. Telegram Command Map

| Comando | Handler | Serviço chamado | Resultado | Mutation? | Aprovação humana | Estado |
|---|---|---|---|---|---|---|
| `/start` | comando start | painel admin menu | menu inicial | não | — | LIVE |
| `/admin` | comando admin | admin_menu | painel admin | não (navegação) | — | LIVE |
| `/listar` `/produtos` | comando produtos | `productsRepository.getProducts` | lista catálogo | não | — | LIVE |
| `/categorias` | comando categorias | `categoriesRepository` | gestão categorias | sim (admin) | sim (humano) | LIVE |
| `/help` | comando help | texto estático | ajuda | não | — | LIVE |
| `/discover ML\|SH url\|search` | `runDiscoverCommand` (facilitator) | `executeDiscover` (N2) | candidato + evidence | sim (candidate) | sim | LIVE |
| `/discover-batch ML\|SH <urls>` | `runDiscoverBatchCommand` | N2 batch | lote de candidatos | sim | sim | LIVE |
| `/research <id>` | comando research | `commercialCockpit.renderResearch` | render N3 | não | — | LIVE (read-only) |
| `/assess <id>` | comando assess | `renderAssessment` | render N4 | não | — | LIVE (read-only) |
| `/priority` `/opportunities` `/risks` | cockpit | `renderPriority/...` | painéis N13+/N14 | não | — | LIVE (read-only) |
| `/experiments` `/agents` `/decisions` `/recommendations` | cockpit | `renderExperiments/...` | painéis N13+ | não | — | LIVE (read-only) |
| `/affiliates [id\|code]` | cockpit | `renderAffiliates` | registry N6/N17 | não | — | LIVE (read-only) |
| `/cycle status <id>` | comando cycle | `getCycleState` (N9) | estado do ciclo | não | — | LIVE (read-only) |
| link solto (detectado) | handler legacy | `extractProductForReview` → `pipeline.evaluate` | prévia com `confirm_pub` | **sim (publica de fato)** | sim | LIVE — legado |
| `/shopee N` | **não existe** | — | — | — | — | NÃO IMPLEMENTADO |
| `/pendentes` `/aprovados` `/logs` `/status` `/menu` | **não existem** | — | — | — | — | NÃO IMPLEMENTADOS |
| `/menu` | **não existe** | — | — | — | — | NÃO IMPLEMENTADO |

Nenhum comando usa `setMyCommands` — a lista de comandos só existe no painel BotFather (manual) e no `/help`.

## 4. Telegram Callback Map

Todos os callbacks passam por `handleTelegramWebhookUpdate` → `logAndValidateReviewCallback`/whitelist, com autorização por chat. A tabela consolidada:

| Callback | Handler (linha aprox.) | Ação real | Mutation no catálogo? | Família |
|---|---|---|---|---|
| `admin_menu`, `admin_back` | 406 | renderiza painel admin | não | admin (legado) |
| `admin_add`, `admin_system` (678), `admin_highlights` (696) | 406–730 | cadastro/sistema/destaques admin | sim (admin) | admin (legado) |
| `products_list:N`, `product_view`, `product_toggle` (776), `product_edit`, `field_edit` (824), `product_del_confirm/exec` (836/854), `products_search_init`, `add_cat_init`, `rename_cat_init` (1074) | 735–1080 | CRUD do catálogo canônico + analytics (`analytics_overview`, `analytics_products:N`, `analytics_ranking:periodo`, `analytics_product:id:periodo`) | sim (admin, humano) | admin (legado) |
| `product_approvals:N`, `confirm_pub:N` | 412 / 1114 | **`confirm_pub` executa `pipeline.evaluate→approve→publish→syncCatalogAndDeploy` — PUBLICA DE FATO no site** | **sim** | legado de decisão |
| `approve_only:N` | 1087 | registra decisão (`status="published"`, `approved_by=approve_only`, timestamp), **NÃO publica** | não (só a review) | preview (Fase 23/24) |
| `cancel_rev:N` | 1215 | `status="rejected"`, lifecycle.rejected | não | preview |
| `review_details:N` | 1167 | edita mensagem com estado do lifecycle, score, validação | não | preview |
| `edit_price:N` (1187), `edit_cat:N` (1201) | — | sessão de edição por usuário (userState, TTL) | não (edita só a proposta) | legado |
| `operator_home/refresh/health/incidents/history/actions` | 446–570 | console do Cerberus Operator | não (consulta) | operator (N9) |
| `operator_run:N`, `operator_approve:N`, `operator_reject:N` | 574–622 | execução de action autorizada | conforme action | operator |
| `operator_mode:{OBSERVE,SAFE_AUTO_HEAL,DRY_RUN,ADMIN_APPROVAL}` | 649 | muda modo operacional (persiste em Supabase) | sim (modo) | operator |
| `operator_config`, `operator_pending`, `operator_escalations`, `operator_logs` | 630–677 | console | não | operator |

**Recomendação inequívoca (seção 13 do prompt):** o caminho futuro é exclusivamente `approve_only` + `cancel_rev`. O `confirm_pub` deve ser desativado do painel (ou mantido com dupla confirmação e banner de depreciação) porque ele publica de fato sem passar por N15/N17 — é o único ponto onde o Telegram pode causar mutation irreversível hoje. `edit_price`/`edit_cat` são herança do curador manual e não cabem no card de preview (política fail-closed de preço).

## 5. HTTP/API Map

| Família | Rotas principais | Chamada por | Usado hoje? |
|---|---|---|---|
| Core/legado | `GET /health`; `POST /api/admin/verify`; `/api/admin/rebuild-static-catalog`; `GET/POST/PUT/DELETE /api/products*`; `POST /api/submit-product`, `/api/extract`, `/api/automation/process`; `GET /api/telegram-status`, `/api/telegram/status`; `POST /api/telegram-set-webhook`; `POST /api/telegram/webhook`; feeds Meta públicos (`/api/meta-feed.csv|xml`, `/feed.csv|xml`); `POST /api/meta-capi`, `/api/track-click` | admin, feed Meta, bot | sim — catálogo 14 produtos |
| Discovery N2 | `POST /api/commercial/discover`; `POST /api/commercial/research-batch`; research POST/GET | `/discover`, `/discover-batch`, scripts | sim |
| Research N3 | `POST /api/commercial/research/execute`; `GET /research/:id` | `/research` | sim |
| Assessment N4 | `POST /api/commercial/assess/:id`, `/history`; `GET /assessment/:id` | `/assess` | sim |
| Curation N5 | `POST /api/commercial/curation/evaluate`; `GET /curation/:id` | internamente (pipeline) | sim |
| Commercial Brain N14 | `/api/commercial/commercial-brain/evaluate`, `/:candidateId`, `/signals`, `/recommendations`, `/analyze` | cockpit | sim (read-only) |
| Governance N15 | `POST /api/commercial/governance/decide`; `GET /governance/:id` | ciclo, scripts | sim |
| Cycle N9 | `/api/admin/cycle/start`, `list`, `/:id/state`, `run/{discovery,research,assessment,acquisition,resolution,decision,publication}`, `run-all`, `cleanup` | HTTP admin | sim |
| Publication N16 | `POST /candidates/:id/publish/preview`, `/publish`, `/publish/status`; `GET /publications`; `POST /publication/execute` | HTTP admin (manual) | sim |
| Affiliate N6–N8/N17 | `POST /api/commercial/affiliate/acquire`; `/affiliate/links` (POST/GET); `/links/:id/validate`; `/links/:id/revoke`; `/providers`; `POST /api/commercial/affiliate/n17/acquire` | HTTP admin, N17 | sim — provado Fases 14–24 |
| Agent Runtime | `/api/agent-runtime/execute`, `/approve`, `/executions` | HTTP admin | sim |
| Experiments | `/api/commercial/experiments` CRUD, `/:id/decide`, `/:id/observe`, `/decisions` | HTTP + `/experiments` | sim (registro) |
| Preview | `POST /api/commercial/preview-telegram` | admin | sim — provado Fases 23/24 |

## 6. Shopee End-to-End Map

| Etapa | Função | Arquivo | Entrada | Saída | Tratamento de erro | Idempotência | Rate limit | Persistência | Lote? |
|---|---|---|---|---|---|---|---|---|---|
| Discovery | `executeDiscover` → `shopeeConnector.search` | `commercial/discovery/discover.ts` / `connectors/shopee.ts` | `{ market: SH, query/urls }` | candidatos + evidence hash | fail-closed (relata falha, não inventa) | `evidence_hash` por item | `rateLimiter.ts` | via candidates repository | sim (`/discover-batch`, batch facilitator) |
| Affiliate | `acquireN17` / `acquireAffiliateLink` | `affiliate/n17Service.ts` / `acquisitionService.ts` | `candidate_id + authorization (N15)`, item/shop id | `offerLink` oficial | `blocked()` com código (AUTHORIZATION_INVALID, PROVIDER_MARKETPLACE_MISMATCH...) | `buildN17IdempotencyKey` (determinística) | pelo provider | `affiliate_links` | sim (por item) |
| Scraper | `fetchProductDataFromUrl` | `services/scraper.ts` | URL pública | imagens (regex CDN), preço observacional, título | try/catch → null | por URL | timeouts internos + retry | memória/retorno | sim (sequencial) |
| Identidade | validação determinística | `previewTelegramRoutes.ts` | shop_id/item_id API vs scraper | `identityMatch` boolean | **424 fail-closed** se divergir | por URL+chat | — | review.meta | sim |
| Preview card | `buildPreviewCard` + sendPhoto | `previewTelegramRoutes.ts` + `telegramBot.ts` | review enriquecida | card foto com galeria | fallback card texto | `reviewId` determinístico (URL+chatId, TTL reuso 1h) | — | `telegram_pending_reviews` | sim (1 review por item) |
| Decisão | `approve_only` / `cancel_rev` | `telegramBot.ts` | callback + reviewId | status published/rejected | validação de callback | por reviewId | — | review | — |
| Publicação | `confirm_pub`→`createProductionProductPipeline` **ou** N16 `/publication/execute` | `productPipeline.ts` + `n16Service.ts` | review/candidate | produto no site | rollback não destrutivo | `execution_key` N16 | — | products + GitHub commit | não automático |

**Resposta à pergunta-chave da auditoria:** existe função pronta que faz partes disso e pode ser orquestrada? **Sim.** O preview-telegram (Fase 23/24) já orquestra Affiliate → scraper → identidade → PendingReview → Telegram para **um** item. O que falta é apenas um orquestrador de lote (`/shopee N`) que chama a mesma lógica N vezes, e o comando `/publicar` que fecha o elo final.

## 7. Affiliate Map

A função canônica para transformar um candidato Shopee em produto com `offerLink` oficial depende do contexto. Para o fluxo de preview (sem N15), usa-se `acquireAffiliateLink` (`affiliate/acquisitionService.ts`, com idempotência interna e `shopeeAffiliateProvider` — GraphQL oficial com headers SHA256). Para o fluxo N17, usa-se `acquireN17` (`affiliate/n17Service.ts`), que exige autorização N15 legítima (`n17AuthorizationStore` com lookup e TTL 24h) e gera idempotency key determinística; retorna `blocked(...)` com código legível quando qualquer gate falha (REQUEST_INVALID, IDEMPOTENCY_CONFLICT, AUTHORIZATION_INVALID, PROVIDER_NOT_ACTIVE, PROVIDER_MARKETPLACE_MISMATCH, N8_CONTRACT_INVALID). O provider é `createShopeeAffiliateProvider` (`shopeeAffiliateProvider.ts`), contratos em `shopeeClientContracts.ts` (selection set `productOfferV2`), `n17Contract.ts` e `contract.ts`. Os campos retornados no nó de oferta: `itemId`, `shopId`, `productName`, `price` (string — normalizada localmente com `priceScaleVerified: false` na leitura, nunca minor_units comprovado), `productLink`, `offerLink`. O repositório `affiliate_links` (`affiliateRepository.ts`) persiste + `affiliateLinkResolver.ts` (`selectEligibleLink`, contrato v1) resolve o link elegível. A proveniência oficial é preservada até a publicação; o `offerLink` chega ao card via `affiliateUrl` do PendingReview.

## 8. Scraper Map

O scraper canônico é `server/services/scraper.ts` (`fetchProductDataFromUrl`, linha 73). Entradas aceitas: qualquer URL pública de produto; a normalização (`normalizeProductUrl` em `productAutomation.ts`) resolve `shope.ee` → `shopee.com.br` e extrai `shop_id`/`item_id` do padrão `/product/{shop_id}/{item_id}`. Extração de imagens: `extractShopeeCdnImages` (regex sobre o DOM SSR para `down-br.img.susercontent.com`, `down-sg` e `cf.shopee`). Preço: `extractCorrectPrice` com `ESTRATÉGIA_6_SHOPEE_SPECIFIC` (estado JSON `price_min`/`price`), retornando string — a semântica de escala fica UNVERIFIED. Título: `extractTitleFromUrl` + título da página. Descrição/categoria: não extraídas em lote pelo scraper (descrição via curadoria; categoria via `categoriesRepository`). Fail-closed: na Fase 24 o preview retorna 424 se o scraper falhar ou a identidade divergir; sem dados inventados. Anti-bot: timeouts internos + retry; na Fase 24 o SSR do datacenter Render retornou preço `null` (comportamento anti-bot observado) e o sistema fallback corretamente para o preço da Affiliate API com `priceScaleVerified: false`. Deduplicação: por URL normalizada + `findExistingProduct` (hook de teste `setTestFindExistingProduct`). Proveniência: cada valor carrega origem (affiliate|scraper|normalizado) no card e na review. **Fase 24 comprovada em produção:** Affiliate API → scraper → 9 imagens CDN reais → `identityMatch=true` → card Telegram enviado como foto (`sendPhoto`).

## 9. PendingReview Map

A tabela Supabase `telegram_pending_reviews` é gerenciada por `server/repositories/telegramRepository.ts` (`savePendingReview` upsert, `getPendingReview`, `getLatestPendingReviewForUser`, `listPendingReviews`, `deletePendingReview`, `setUserState`). Campos atuais: `id`, `review_id` (determinístico por URL normalizada + chatId, com registry de reuso de 1h), `produto`, `descricao`, `link`, `preco` (null quando indisponível — nunca inventado), `imagens` (array de URLs CDN), `categoria` (com prefixo `affiliate_preview` para identificar a fonte), `status` (pending/published/rejected/error), `source` (affiliate_preview|manual), `affiliate_url`, `meta` (JSON: identidade, proveniência, `extractedImageCount`, `cardAsPhoto`), `lifecycle` (registro do pipeline, quando existe), `existing_product`, `created_at`, `expires_at`, `chat_id`. Expiração: `getPendingReview` trata `status='pending' ∧ now ≥ expires_at` como expirada; o repo define `SESSION_EXPIRATION_MS = 3600000` (1h), mas o preview da Fase 23/24 cria com TTL 24h (desencontro já documentado na Fase 25 — padronizar em 24h é decisão da próxima fase). Persistência: Supabase é o caminho canônico com fallback fail-closed (review não criada se persistência falhar — nada é enviado sem registro). Status/fluxo: pending → published (via `approve_only`, só registro) ou rejected (via `cancel_rev`). Metadados suportados hoje: identidade (shop_id/item_id), proveniência do preço, contagem de imagens, modo do card (foto/texto) — **`batch_id` não existe ainda** (os reviews do mesmo lote seriam rastreáveis por `created_at`+chat, mas sem vínculo explícito; a coluna é proposta DDL-only G6). Vários reviews por lote: suportado (independência por reviewId).

## 10. Publication Map

O caminho canônico é `createProductionProductPipeline` (`productPipeline.ts`): `evaluate(input)` → valida (estado VALIDATED/REJECTED/ERROR) → `approve(record)` → `publish(record)`. `publish` cria o produto com `createProduct({produto, categoria, preco, imagens, link: normalizedUrl, descricao, status:"approved"}, {syncCatalog:false})`, depois `updateProduct(ativo:true, status:"published", syncCatalog:false)` e finalmente `syncCatalogAndDeploy`. Esta última (`catalogSync.ts:105`) adquire lock de catálogo, lê Supabase, exporta `products.json` estático, faz commit no GitHub (`kauabrennan5-bit/CerberusFindsArchive`), valida identidade e contagem no catálogo público (site `cerberus-static-catalog.onrender.com`) e, em caso de falha pública, executa rollback **não destrutivo** (`ativo:false, status:"error"`, novo sync). A variante N16 (`/publication/execute` → `executePublicationN16`) usa `supabasePublicationAdapter.ts`: `createCanonicalProduct` (mesma semântica) + `linkPromotion` (vínculo candidate→product com evento operacional) + confirmação do provider, com idempotência por `execution_key` (duplicata retorna `PUBLISHED` sem refazer). Rollback existe (`restoreCreatedProduct` desativa). **affiliateUrl:** o produto canônico armazena `link` = URL original do produto; o `affiliateUrl` vive na PendingReview e em `affiliate_links` — o card e o site usam o `offerLink` oficial da Affiliate API. **Resposta à pergunta do prompt** (o que falta após clicar PUBLICAR num card affiliate_preview): hoje, **o elo final não existe** — `approve_only` só registra a decisão. Para publicar de fato seria preciso (1) recuperar a review, (2) passar o conteúdo + affiliateUrl à rota N16 `/publication/execute` ou ao pipeline, e (3) deixar `syncCatalogAndDeploy` concluir. Um comando `/publicar <reviewId>` no Telegram faria exatamente isso **sem alterar N16/pipeline**.

## 11. Duplicate/Legacy Flows

| Duplicação | Canônico (novo) | Legado | Deprecável? | Manter temporariamente? | Risco de remover | Recomendação |
|---|---|---|---|---|---|---|
| `confirm_pub` vs `approve_only` | `approve_only` (+ futuro `/publicar`) | `confirm_pub` (publica de fato, sem N15) | **Sim** | Sim, só leitura/histórico | Baixo se nenhum card novo o usar | Desativar do painel, remover dos keyboards novos |
| Link solto (detectado) vs `affiliate_preview` | `preview-telegram` (Affiliate + scraper + fail-closed) | Envio de link → `extractProductForReview` → `confirm_pub` | Sim (parcial) | Sim — útil para URLs não-Shopee/ML | Médio (uso real do usuário) | Manter só para ML/outras fontes; Shopee deve passar pelo preview |
| `/discover` vs discovery alternativo | `executeDiscover` (connector canônico) | `/api/extract` (HTTP, scraper direto) | Sim | Não | Baixo | `/api/extract` permanece admin-HTTP; não expor no Telegram |
| `/discover-batch` vs novos batch | batch facilitator existente | — (novo `/shopee N` usaria o mesmo) | Não | — | — | Reutilizar o facilitator dentro do `/shopee` |
| Pipeline legado (avaliação inline) vs canônico `evaluate→approve→publish` | `createProductionProductPipeline` | avaliação inline no handler de link solto | Sim (o handler deve chamar o canônico) | Sim | Baixo | Unificar chamadas |
| Operator vs Agent Runtime | Operator (modo + ações autorizadas) | `/api/agent-runtime/*` | Não | Sim | Médio | Operador é o painel; agent-runtime fica HTTP |
| HTTP-only vs Telegram | Painel Telegram | Todas as rotas admin HTTP | Não | Sim | — | Cada rota admin ganha comando correspondente |
| `edit_price`/`edit_cat` vs política fail-closed | sem edição (preço observacional UNVERIFIED) | sessão userState | **Sim** | Sim | Baixo | Remover dos keyboards de preview |

## 12. Telegram Gaps

As funcionalidades operacionais sem superfície Telegram: `preview-telegram` (hoje exige admin password no HTTP), aquisição N6/N17, `validate`/`revoke` de links, N16 `publish`/`execute`, `cycle start/run/run-all/cleanup`, `rebuild-static-catalog`, agent runtime, experiments CRUD e job queue. No sentido inverso, o que o Telegram tem e está desatualizado: `confirm_pub` (mutation sem gate), `edit_price`/`edit_cat` (incompatíveis com a política de preço), cockpit read-only sem filtros/paginação, e a ausência de `setMyCommands`. Estados no Supabase na data da auditoria: `products=14`, `telegram_pending_reviews=9` (8 expiradas de provas anteriores + a da Fase 24), `candidates=0`, `candidate_evidence=0`, `affiliate_links=0`.

## 13. Reusable Components

Componentes prontos para reutilização imediata: `executeDiscover` + `shopeeConnector` + `rateLimiter` (discovery com limite de taxa); `acquisitionService.acquireAffiliateLink` e `n17Service.acquireN17` (aquisição oficial com idempotência); `fetchProductDataFromUrl`/`extractShopeeCdnImages` (scraper canônico); `buildPreviewCard`/`savePendingReview` da rota de preview (card foto + persistência + idempotência por reviewId); `logAndValidateReviewCallback` (validação de callback com whitelist); `listPendingReviews` (leitura para `/pendentes`); `productsRepository`/`operationalMemoryRepository`/`jobQueueRepository` (leitura para `/status`, `/logs`); `createProductionProductPipeline` e `executePublicationN16` (publicação final, inalterados); `commercialCockpit.render*` (menu); `facilitator.telegramBatchResponse` (resposta de lote); `syncCatalogAndDeploy` (deploy). Nenhum deles precisa de modificação para o plano mínimo.

## 14. Components That Actually Need New Code

O código novo real se resume a quatro blocos: **(1)** o orquestrador `/shopee N [termo]` — um módulo que loopa sobre a lógica já existente por item, com `batch_id` lógico em memória (coluna DDL não é pré-requisito); **(2)** os comandos de leitura `/pendentes`, `/aprovados`, `/status`, `/logs`, `/menu` — funções puras de leitura; **(3)** o comando `/publicar <reviewId>` que fecha o elo final invocando N16/pipeline existente; **(4)** o registro `setMyCommands` na inicialização do bot. Opcional para esta primeira entrega: `batch_id` (migration DDL-only, pode esperar) e a desativação gradual de `confirm_pub`/`edit_price`/`edit_cat` nos keyboards. Todo o resto é conexão.

## 15. Proposed /shopee N Architecture

Desenho técnico do fluxo com as funções existentes em cada `?`:

```
/shopee 10 ["termo"]  (novo comando — dispatcher do telegramBot.ts)
    ↓
[A] executeDiscover(SH, termo, limit=10)      → connector/shopee.ts + rateLimiter
    ↓  (dedup intra-batch por shop_id+item_id; inter-batch por findExistingProduct/listing_key)
[B] acquireAffiliateLink por item             → acquisitionService (idempotency interna)
    ↓  (se elegibilidade falhar: item relatado no resumo, nunca card incompleto)
[C] fetchProductDataFromUrl por item          → scraper.ts (imagens/preço observacional)
    ↓  (identidade: regex shop_id/item_id da URL oficial vs nó da API; divergência = skip)
[D] savePendingReview × N (source=affiliate_preview) → telegramRepository
    ↓  (reviewId determinístico URL+chatId; TTL 24h; meta com proveniência)
[E] buildPreviewCard + sendPhoto × N + card-resumo do lote → previewTelegramRoutes/telegramBot.ts
```

Regras de resiliência: rate limit respeitado pelo `rateLimiter` do discovery e chamadas de aquisição sequenciais; **falha individual** é reportada no resumo do lote (ex.: "10 enviados, 1 falha: scraping bloqueado") e nunca interrompe o lote; **duplicado** intra-batch é eliminado por identidade, e reenvio do mesmo comando usa reviewId determinístico (card idempotente); **sem elegibilidade Affiliate** = item descartado com razão no resumo; **scraper bloqueado** = preço retorna `null` observacional, proveniência explícita no card (nunca inventado), ou item omitido se a política exigir fail-closed total (decisão sua — proposta: manter o card com preço da Affiliate API `priceScaleVerified:false`, como na Fase 24); **sem preço** = card mostra preço Affiliate não verificado; **sem imagem** = card texto em vez de foto (fallback já existente); **identidade** = regex determinística da URL oficial contra o nó da API (424 em divergência); **duplicação de cards** = reviewId determinístico; **publicação automática** = impossível — os botões são `approve_only`/`cancel_rev` e `/publicar` exigirá confirmação explícita.

**Formato do comando:** `/shopee 10` vs `/shopee 10 "termo"`. Recomendação técnica: **começar por `/shopee N "termo"` obrigatório** — discovery sem termo exigiria manter um "interesse comercial registrado" (dado novo que não existe hoje; inventá-lo violaria a política de não criar dados artificiais). Sem termo, o comando rejeita com mensagem de uso. Depois que o usuário autorizar um interesse comercial explícito (ex.: persistido num registro próprio), o termo pode se tornar opcional.

## 16. Proposed Telegram Menu

Comandos propostos e reaproveitamento: `/menu` (novo — consolida `admin_menu` + `operator_home` + links para `/pendentes`/`/status`); `/status` (novo — `GET /health` + `telegram-status` + contagens Supabase: produtos, pendentes, lote em andamento); `/shopee N "termo"` (novo — seção 15); `/pendentes` (novo — `listPendingReviews` status=pending); `/aprovados` (novo — lista com status=published, por chat ou global com filtro admin); `/logs` (novo — leitura de `operational_memory`/`job_queue`); os existentes `/discover`, `/discover-batch`, `/research`, `/assess`, `/cycle`, `/priority`, `/opportunities`, `/risks`, `/experiments`, `/agents`, `/decisions`, `/recommendations`, `/affiliates`, `/listar`, `/produtos`, `/categorias`, `/help`, `/start` são mantidos e registrados via `setMyCommands`. Reaproveitados: `/listar` cobre "catálogo atual"; `/affiliates` cobre registry de links; `/cycle` cobre orquestração de estágio.

## 17. Governance/Safety Audit

A consolidação **não exige** alterar N14 (engine/weights/thresholds; price continua `string_price_unscaled`, scale UNVERIFIED), N15 (policy/authorization/TTL), N16 (idempotência/confirmar publicação), N17 (acquisition contract/idempotency key/fail-closed), N18 (proibido), contracts da Affiliate API, contract do scraper ou o pipeline de publicação. Pontos onde a integração Telegram poderia contornar gates, com mitigação: (1) **confirm_pub** publica sem N15 — mitigação: desativar nos novos keyboards; (2) um `/publicar` mal desenhado poderia publicar sem validação de identidade — mitigação: `/publicar` só opera sobre PendingReview existente (identidade já validada no preview) e reusa N16/pipeline intactos; (3) lotes poderiam multiplicar calls à Affiliate API — mitigação: rate limiter + resumo de falhas; (4) callbacks fora de whitelist/chat — mitigação: `logAndValidateReviewCallback` já valida; (5) secrets em logs — mitigação: nenhuma função nova loga credenciais ou valores de preço reais. **Recomendação inequívoca confirmada:** o caminho futuro de decisão é `approve_only` + `cancel_rev`; `confirm_pub` é removido da superfície nova e deprecado no legado.

## 18. GitHub vs Production Divergences

Verificação read-only em 2026-08-21: `/health` nos dois domínios (`cerberus-forge-deploy.onrender.com` e `-backend.onrender.com`) serve `version=3deb7556611be7134cf46a2241b8c1c0ffd0d45b` = SHA de `origin/main` (202 commits) — **zero divergência**. `/api/telegram/status` (domínio `-backend`): `configured`, `tokenConfigured`, `whitelistConfigured`, `effectiveWhitelistConfigured`, `webhookConfigured` e `webhookMatchesExpectedUrl` todos `true`; webhook esperado `...-backend.onrender.com/api/telegram/webhook`; `pendingUpdates=0`; `apiHealthy=true`; `backendReady=true`; `operatorState=READY`; `backendSha=3deb755`. O site estático `cerberus-static-catalog.onrender.com` responde (SPA com gtag) e é alimentado pelo `products.json` do sync. Variáveis de ambiente no Render conhecidas **apenas por nome** (valores nunca expostos): `SHOPEE_AFFILIATE_APP_ID`, `SHOPEE_AFFILIATE_APP_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_CHATS`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`/`SERVICE_ROLE_KEY`, `STATIC_CATALOG_URL`, `GITHUB_*` (sync do catálogo). A key temporária da Fase 24 (`rnd_PclW...`) não está disponível nesta sessão (não persistida) e permanece pendente de revogação manual no Dashboard, conforme autorizado anteriormente.

## 19. Recommended Deprecations

Em ordem de segurança: primeiro, remover `confirm_pub` e `edit_price`/`edit_cat` dos keyboards de preview (nada os aciona mais); segundo, documentar como legado o handler de link solto para Shopee (orientar uso do `/shopee` quando existir); terceiro, após a virada de tráfego para o painel, restringir `/api/extract` e o agent-runtime a uso administrativo explícito; por fim, manter `OPERATOR mode` legado intacto (não é duplicação — é funcional). Nenhum código é removido nesta fase.

## 20. Minimal Implementation Plan

Sequência mínima em três commits futuros (nada é implementado agora): **Commit 1** — `setMyCommands` na inicialização do bot + comandos de leitura (`/status`, `/pendentes`, `/aprovados`, `/menu`) usando repositórios existentes + testes; **Commit 2** — `/shopee N "termo"` (orquestrador por item reutilizando discovery + aquisição + scraper + preview, resumo de lote, idempotência por reviewId) + testes unitários (autorização ausente, identidade divergente, scraper bloqueado, sem elegibilidade, sem imagem, sem preço, duplicado); **Commit 3** — `/publicar <reviewId>` (valida review existente → N16/pipeline → confirmação antes da mutation) + desativação de `confirm_pub` nos keyboards. Gates obrigatórios em cada commit: `npm test` (1452+), `npx tsc --noEmit`, `npm run build`, `git diff --check`, secret scan. Provas: E2E do `/shopee 2` com o produto já comprovado antes de lotes maiores, via Render one-off job se necessário.

## 21. Exact Files That Would Need Modification

Arquivos a tocar (nenhum deles pertence a N14/N15/N16/N17/engine/contracts): `server/services/telegramBot.ts` (dispatcher + keyboards + setMyCommands — o arquivo central do painel); `server/services/commercialCockpit.ts` (render do `/menu`); um novo módulo `server/bot/shopeeCommand.ts` (orquestrador, reutilizando facilitator/previewTelegramRoutes); `server/repositories/telegramRepository.ts` (apenas leitura/consulta — sem migration); e testes `tests/telegramShopeeCommand.test.ts` + extensões em `tests/previewTelegramRoutes.test.ts`. Opcional futuro: migration DDL-only (`telegram_pending_reviews.batch_id`), `server/routes/previewTelegramRoutes.ts` (expor internamente a lógica por item sem repetir o HTTP), `server/services/productAutomation.ts` (nenhuma mudança necessária). **Nenhum arquivo de blocos N, contracts, weights ou thresholds é modificado.**

## 22. Risks

Os riscos principais: (1) **rate limit/anti-bot Shopee** em lotes — mitigado por rate limiter + falha individual; (2) **confirm_pub residual** — qualquer card antigo ainda pode publicar; mitigado por depreciação imediata dos keyboards; (3) **TTL desencontrado** (repo 1h vs preview 24h) — padronizar em 24h; (4) **idempotência de lote** — reviewId determinístico protege, mas o usuário deve saber que reenviar `/shopee 10` não cria cards duplicados e não reaproveita os antigos (expirados); (5) **preço anti-bot null** — proveniência explícita; (6) **explosão de mensagens** — N cards + resumo em lote grande (10+); mitigar com chunking de envio; (7) **segredo** — nenhum comando novo loga credenciais/valores.

## 23. Tests Required

Para o plano mínimo: testes do `/shopee` cobrindo: (a) termo ausente → rejeição com uso; (b) número fora de 1..20 → rejeição; (c) discovery vazio → resumo "0 enviados"; (d) identidade divergente → skip + resumo; (e) scraper bloqueado → proveniência explícita ou skip; (f) sem elegibilidade Affiliate → skip com razão; (g) sem imagem → card texto; (h) sem preço → card com preço Affiliate `priceScaleVerified:false`; (i) duplicado intra-batch → 1 card apenas; (j) reenvio do comando → idempotência; (k) reviewId determinístico; (l) nenhum mutation Supabase além das reviews. Para leitura: `/status`/`/pendentes`/`/aprovados` mockando repositórios (0 registros, registros expirados, pendentes). Para `/publicar`: review inexistente → erro; review já decidida → erro; review valida → chamada única ao N16 mockado com confirmação prévia.

## 24. E2E Plan

Prova futura (após autorização): deploy do Commit 1 → `/health`/SHA → `/menu`, `/status`, `/pendentes` no Telegram real; deploy do Commit 2 → `/shopee 2 "porta talher"` com o produto já comprovado (shop_id=1530442944, item_id=23794344926) → validar: 2 cards foto (ou 1 card + 1 falha sanamente relatada), identidade exata, affiliateUrl oficial, preço UNVERIFIED, reviews no Supabase; clicar ❌ em um e ✅ no outro → confirmar `approve_only`/`cancel_rev` (sem publicação); deploy do Commit 3 → `/publicar <reviewId>` com confirmação → publicação real de **um** produto (a primeira publicação real do fluxo), seguidos de cleanup e relatório. Cada passo aguarda autorização separada.

## 25. FINAL RECOMMENDATION

**A) O que já está pronto hoje:** discovery Shopee com rate limiter; aquisição oficial com idempotência e fail-closed; scraper canônico com identidade e proveniência; preview-telegram com card foto, PendingReview persistida e idempotência; pipeline canônico `evaluate→approve→publish` com syncCatalogAndDeploy e rollback; N16 com idempotência e confirmação; painel Operator; contagens de leitura; produção íntegra (SHA igual ao GitHub, webhook OK, 14 produtos).

**B) O que falta apenas conectar:** o loop de lote (`/shopee N` reutiliza discovery+aquisição+scraper+preview item a item); a leitura para painéis (`listPendingReviews`, `getProducts`, repositórios de memória/job); o menu consolidado (`commercialCockpit` + callbacks existentes); e o comando `/publicar` que invoca N16/pipeline existentes sobre uma review já validada.

**C) O que realmente precisa de código novo:** um módulo orquestrador de lote, quatro comandos de leitura/menu, o registro `setMyCommands` e a extensão de testes — ~4–6 arquivos.

**D) Menor conjunto de arquivos a alterar:** `telegramBot.ts` (dispatcher), `commercialCockpit.ts` (menu), novo `server/bot/shopeeCommand.ts`, testes novos. Zero arquivo de N14/N15/N16/N17, contracts, weights, thresholds ou governança.

**E) Primeiro commit:** `setMyCommands` + `/status`, `/pendentes`, `/aprovados`, `/menu` — risco mínimo, valor imediato, sem mutation.

**F) Fluxo final de `/shopee 10 → cards → aprovação → publicação no site`:** `/shopee 10 "termo"` → 10 descobertas deduplicadas → 10 `offerLink` oficiais → 10 enriquecimentos scraper → 10 PendingReviews (TTL 24h, proveniência, fail-closed) → 10 cards foto + resumo → decisão humana `[✅ PUBLICAR]` via `approve_only` (registro) → comando `/publicar <reviewId>` com confirmação → `executePublicationN16`/pipeline → produto no Supabase + commit GitHub → site estático validado publicamente. Nenhuma etapa automatiza a publicação: **aprovação humana é obrigatória em dois pontos** (decisão no card e confirmação no `/publicar`).

---

**CONCLUSÃO: FASE 25A ENCERRADA — `PHASE25A_READ_ONLY_ONLY` CUMPRIDO. MAPA DA VERDADE ENTREGUE. Aguardo sua autorização para iniciar o Commit 1 (setMyCommands + comandos de leitura).**
