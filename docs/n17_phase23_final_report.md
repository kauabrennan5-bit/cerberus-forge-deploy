# N17 — FASE 23 — RELATÓRIO FINAL — AFFILIATE PREVIEW (SHOPEE → TELEGRAM → APROVAÇÃO MANUAL)

**STATUS: IMPLEMENTAÇÃO VALIDADA LOCALMENTE — AGUARDANDO AUTORIZAÇÃO PARA COMMIT+PUSH+DEPLOY E TESTE E2E REAL**

## 1. O QUE FOI IMPLEMENTADO (menor alteração para conectar SHOPEE → AFFILIATE LINK → TELEGRAM)

**A) Nova rota admin:** `server/routes/previewTelegramRoutes.ts` (373 linhas, nova)
- Endpoint: `POST /api/commercial/preview-telegram`
- Autenticação: `x-admin-password` (mesma exigência de todas as rotas admin)
- Fluxo: URL Shopee → `extractShopeeIdentifiers` → **1 única chamada read-only** `productOfferV2` via `client.acquireAffiliateLink` (Affiliate API oficial já configurada) → extrai price do raw via `extractOfferNodes` (exportado) → gera **PendingReview** (`category=affiliate_preview`, `status=pending`, `priceScaleVerified=false`) → envia card Telegram com inline keyboard `[✅ PUBLICAR → approve_only:{reviewId}]` e `[❌ DESCARTAR → cancel_rev:{reviewId}]`.
- Idempotência por URL (registry de 1h; mesmo item não gera card duplicado).

**B) Fail-closed e sanidade:**
- Credenciais ausentes → HTTP 503 `affiliate_auth_unavailable` (sem card, sem review).
- Oferta existe mas não elegível → HTTP 424 `affiliate_link_not_available` (sem card, sem review).
- Shopee indisponível → HTTP 502/504 (sem card, sem review).
- Falha de envio ao Telegram → HTTP 503 `telegram_send_failed`, MAS o PendingReview é persistido (auditoria não perde a decisão).
- Nenhum `raw_response`/secret é persistido em nenhum ponto.

**C) Preço com escala UNVERIFIED:**
- O card exibe a forma decimal observada (vírgula) com a nota explícita: "(escala não verificada — não tratar como moeda)".
- **Nunca** usa prefixo "R$" nem declara moeda/escala.
- String inválida/vazia/ausente → campo ausente no card (unknown, não inventado).

**D) Imagem:**
- A API de Afiliados não fornece imagens (policy 10010 bloqueia). O card informa explicitamente: "Imagem: não fornecida pela API de Afiliados". Nada é inventado.

**E) Callback `approve_only`:** (`server/services/telegramBot.ts`, +30 linhas)
- Handler `approve_only:{reviewId}` processado ANTES de `confirm_pub:`.
- Só registra a decisão no `PendingReview` (`status=published`, descrição += `approved_by=approve_only · approved_at=...`, `logTelegramEvent`).
- **Não executa `pipeline.publish`, não chama N17/N8/N6, nenhuma mutation no site.**
- DESCARTAR usa o `cancel_rev:` já existente (sem alteração).

**F) Wiring:** `server.ts` registra `setupPreviewTelegramRoutes` após `registerCommercialBrainRoutes` (+6 linhas).

**G) Hooks de teste controlados:** `telegramRepository.ts` ganhou `setTestSavePendingReview`/`setTestGetPendingReview` (mesmo padrão `setXForTests` usado por `setAffiliateClientForTests`).

## 2. ARQUIVOS ALTERADOS (diff --stat)

```
 server.ts:                                       +6
 server/commercial/affiliate/shopeeApiClient.ts:  +8/-1  (export extractOfferNodes)
 server/repositories/telegramRepository.ts:       +28  (hooks de teste)
 server/services/telegramBot.ts:                  +30  (handler approve_only)
 server/routes/previewTelegramRoutes.ts:          NOVO (373 linhas)
 tests/previewTelegramRoutes.test.ts:             NOVO (492 linhas, 17 testes)
```

**NOTA DE GOVERNANÇA:** nenhuma policy, threshold, weight, score, TTL, contract, engine ou regra N13/N14/N15/N16/N17 foi tocada. Seller API não usada. Nenhuma autorização de loja solicitada.

## 3. GATES — TODOS PASSARAM

```
npm test:          1447 testes — 1447 pass, 0 fail (~64s)
                   incl. 17 novos (rota + callback approve_only)
npx tsc --noEmit:  OK (0 erros, incluindo testes)
npm run build:     OK
git diff --check:  OK
secret scan:       NO SECRETS (mock-app-id/mock-app-secret são placeholders
                   legítimos de teste, não credenciais reais)
```

## 4. TESTE E2E REAL — BLOQUEIO

O teste ponta a ponta com credenciais **reais** não foi executado porque:

1. As credenciais `SHOPEE_AFFILIATE_APP_ID`/`SECRET` existem **somente no Render** (`srv-d9tq9sh42hec738skftg`); o sandbox não as possui (prova real por curl no sandbox é inviável e o usuário proibiu colar credenciais em chat).
2. A rota nova ainda **não está publicada** — o Shell do Render roda o código do deploy atual (main), então rodar a rota nova lá exigiria commit/push/deploy primeiro.
3. O Web Shell do Render não estabeleceu sessão interativa via automação do sandbox (WebSocket do terminal não conecta no navegador automatizado), impedindo a execução remota do código já publicado.

**Caminho para o critério de sucesso completo (Shopee Affiliate → produto real → seu offerLink → Telegram → você recebe o card):**

Após sua autorização para **commit isolado + push + deploy**, eu:
1. Commito/pusho o diff acima (somente os 6 arquivos do escopo).
2. Aguardo Render, confirmo `/health` 200 e SHA servido = SHA publicado.
3. Executo a prova real via `curl` contra o endpoint publicado:
   `POST https://cerberus-XXXX.onrender.com/api/commercial/preview-telegram` com `x-admin-password` e body `{"shopee_url":"https://shopee.com.br/product/1530442944/23794344926"}`.
4. Você recebe o card no Telegram e testa os dois botões:
   - `✅ PUBLICAR` → callback `approve_only` → decisão registrada, **nada publicado**.
   - `❌ DESCARTAR` → callback `cancel_rev` (existente).
5. Faço cleanup dos PendingReview de prova e entrego o relatório final (status HTTP, reviewId, card recebido, comportamento dos 2 callbacks).

## 5. LIMITAÇÕES REGISTRADAS

- Imagem do produto: indisponível via Affiliate API (não inventada; explicitada no card).
- `price` permanece `UNVERIFIED` (sem contrato de escala oficial).
- Sem dimensões adicionais (stock/seller/commission): policy 10010 da API.
- O teste E2E real fica condicionado ao deploy (autorização sua).

## 6. DECISÃO REQUERIDA

- [ ] Autorizar commit isolado + push + deploy + prova E2E real (item 4)
- [ ] OU manter apenas a entrega local (diff/gates já concluídos)
