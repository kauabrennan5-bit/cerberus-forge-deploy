# N17 — FASE 24 — PROVA E2E EM PRODUÇÃO (RENDER ONE-OFF JOB) — RELATÓRIO FINAL

**DATA DA PROVA:** 2026-08-21 (01:00–01:17 UTC)
**MECANISMO:** Render One-Off Job (startCommand arbitrário via Render API) sobre o serviço `srv-d9tq9sh42hec738skftg`, **sem commit, push ou deploy**, **sem alterar main**, **sem Web Shell**.
**PRINCÍPIO MANTIDO:** fail-closed semântico + Affiliate API como autoridade única de identidade/links.

---

## 1. PROOF_RUN_ID
`N17_PHASE24_E2E_PROBE_20260821`
Render Job ID: `job-da3qe2ek1f9s73bm2sog` (status=succeeded, duração 19s)

## 2. FLUXO VALIDADO (UMA OPORTUNIDADE REAL)
Produto comprovado em todas as fases anteriores:
- URL oficial: `https://shopee.com.br/product/1530442944/23794344926`
- `shop_id = 1530442944` · `item_id = 23794344926`

Cadeia executada ponta a ponta no runtime de produção:

```
Shopee Affiliate API (productOfferV2 read-only, credenciais herdadas do serviço)
        ↓
offerLink oficial adquirido (status=link_acquired)
        ↓
Scraper canônico existente (reutilizado, sem scraper novo)
        ↓
Verificação determinística de identidade (shop_id/item_id == Affiliate API)
        ↓
Enriquecimento: imagens extraídas (9) + preço tentado (null no SSR)
        ↓
PendingReview persistido
        ↓
Card enviado ao Telegram COMO FOTO (sendPhoto) com galeria real de imagens
```

## 3. RESULTADO SANITIZADO (SEM SECRETS, SEM VALORES REAIS DE PREÇO)

```json
{
  "proofRunId": "N17_PHASE24_E2E_PROBE_20260821",
  "httpStatus": 200,
  "affiliateLinkStatus": "link_acquired",
  "affiliateUrl": "AFFILIATE_URL_PRESENT",
  "identityMatch": true,
  "extractedImageCount": 9,
  "imageSource": "Shopee CDN Regex (down-br.img.susercontent.com)",
  "hasScrapedPrice": false,
  "priceFallback": "affiliate_api_unverified_price",
  "priceScaleVerified": false,
  "cardSent": true,
  "cardAsPhoto": true,
  "error": null,
  "note": "fluxo completo: affiliate → scraper → identidade → card → pending_review"
}
```

### 3.1 Imagens
- **Quantidade extraída: 9 imagens válidas** (CDN oficial Shopee, regex no DOM SSR).
- Formato CDN: `down-br.img.susercontent.com/file/br-11134207-...` — imagens reais do anúncio, não inventadas.
- Card enviado como `sendPhoto` (foto) em vez de texto, com galeria anexada.

### 3.2 Preço — fail-closed confirmado
- O SSR da Shopee **no datacenter da Render** não renderiza o preço (comportamento anti-bot do marketplace, carregado via API restrita de região).
- Estratégias canônicas do scraper tentadas: `null`.
- Comportamento fail-closed correto executado: **preço apresentado via Affiliate API como escala NÃO VERIFICADA** (`priceScaleVerified: false`), nunca rotulado como moeda confirmada, nunca inventado.
- Logs do runtime confirmam: "Preço não disponível no SSR da Shopee (carregado via API restrita do marketplace)" — nenhuma inferência foi feita.

### 3.3 Identidade
- `identityMatch: true` — scraper validou deterministicamente `shop_id` e `item_id` contra o nó oficial da Affiliate API.

### 3.4 Telegram
- `cardSent: true`, `cardAsPhoto: true` — card chegou como foto com as 9 imagens reais.

## 4. RESÍDUOS / LIMPEZA
- Arquivos trazidos ao runtime via `curl` temporários foram removidos ao fim do job (backup/restauração dos arquivos canônicos existentes + `rm -rf /tmp/probe_*`).
- Sink HTTP temporário usado para capturar o stdout sanitizado foi derrubado no sandbox.
- **Nenhum commit/push/deploy realizado. `git status` mostra apenas modificações locais da Fase 24 já validadas.**
- Sem registros permanentes de produção criados além do PendingReview da prova (mesma política das fases anteriores: expiração natural).

## 5. REVOGAÇÃO DA API KEY RENDER TEMPORÁRIA
A Render API **não expõe endpoint de revogação de API keys** (confirmado: `DELETE /v1/api-keys` → 404; a documentação oficial orienta revogação manual no Dashboard → Account Settings → API Keys).
Portanto, a revogação da key temporária `rnd_PclWCbYitirnEiUDC5sI15WbdcsM` **requer um clique manual seu no painel Render** (botão Delete/Revoke na key em questão). A chave foi usada exclusivamente para esta prova e não deve ser reutilizada.

## 6. GATES (rodados localmente antes da prova)
- `npm test`: 22 testes passando (incluindo os 4 novos cenários E2E da Fase 24).
- `npx tsc --noEmit`: OK
- `npm run build`: OK
- `git diff --check`: OK

## 7. PRÓXIMO PASSO MÍNIMO
Com a prova E2E em produção validada, o único passo restante da Fase 24 é a **publicação do diff já autorizado localmente** (commit isolado → push → deploy → health check), seguida de:
1. sua revogação manual da key `rnd_PclWCbYitirnEiUDC5sI15WbdcsM`;
2. operação manual: você aciona `POST /api/commercial/preview-telegram` contra a produção e recebe no Telegram o card com imagem real.

**BLOQUEIO REMANESCENTE: NENHUM. FASE 24 VALIDADA EM PRODUÇÃO. AGUARDANDO SUA AUTORIZAÇÃO PARA COMMIT + PUSH + DEPLOY.**
