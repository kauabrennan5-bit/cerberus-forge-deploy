# N17 — FASE 24 — PUBLICAÇÃO E PROVA REAL EM PRODUÇÃO — RELATÓRIO FINAL

**DATA:** 2026-08-21
**PROOF_RUN_ID:** N17_PHASE24_PHASE4_PROBE_20260821
**STATUS:** VALIDADO EM PRODUÇÃO — aguardando sua autorização para próxima etapa (nenhuma publicação real executada).

---

## 1. PUBLICAÇÃO
- **Commit:** `3deb7556611be7134cf46a2241b8c1c0ffd0d45b` — `feat(n17-phase24): enrich Shopee affiliate preview with scraper images and observational price, Telegram photo card, fail-closed identity validation`
- **Push:** main → origin/main (cdaf1bc → 3deb755)
- **Deploy:** concluído automaticamente pelo Render. `/health` passou a servir `version=3deb7556611be7134cf46a2241b8c1c0ffd0d45b` (14:26 UTC).
- **/api/telegram-status:** operatorState=READY, webhook canônico confere, apiHealthy=true, tokenConfigured=true.
- **Secret scan pré-commit:** tokens reais removidos dos docs do bloco 23 (substituídos por mask); `tests/jobQueueRepository.test.ts` mantém apenas um token revogado usado como fixture intencional de teste de sanitização. Nenhum secret em código novo.

## 2. PROVA REAL EM PRODUÇÃO (produto comprovado)
URL: `https://shopee.com.br/product/1530442944/23794344926` · shop_id=1530442944 · item_id=23794344926

Resposta HTTP 200 de `POST /api/commercial/preview-telegram` (sanitizada — `affiliateUrl` omitido do relatório, presente no corpo real):

```json
{
  "ok": true,
  "reviewId": "affprev-124vbe6-mt29szbp",
  "affiliateStatus": "link_acquired",
  "name": "Porta Talher Madeira Nobre Vidro Organizador Multiuso Robusto Mesa Posta Decoraçao Cozinha Hotelaria",
  "price": 79.9,
  "priceScaleVerified": false,
  "productLink": "https://shopee.com.br/product/1530442944/23794344926",
  "shopId": "1530442944",
  "itemId": "23794344926",
  "cardSent": true,
  "cardAsPhoto": true,
  "extractedImageCount": 9,
  "cardMessageId": null
}
```

Confirmações objetivas:
1. **identityMatch:** shop_id/item_id da resposta = identidade extraída da URL oficial (Affiliate API como autoridade).
2. **affiliateUrl oficial:** presente no corpo da resposta e usado no card (`affiliateStatus=link_acquired`).
3. **Imagens:** 9 imagens reais extraídas pelo scraper canônico (CDN Shopee via regex DOM) — card enviado como **foto** (`cardAsPhoto: true`).
4. **Preço:** `79.9` apresentado com `priceScaleVerified: false` — escala não verificada, conforme política; sem rótulo de moeda confirmada, sem BRL.
5. **PendingReview:** persistido no Supabase com status=pending, expira em 24h (`expires_at=1787362098902`).
6. **Nenhuma mutação de catálogo:** `products=14` intacto; candidates=0; affiliate_links=0.

## 3. GATES
- `npm test`: **1452 testes PASS, 0 fail** (incluindo os 22 do suite de preview com os 4 cenários E2E da Fase 24).
- `npx tsc --noEmit`: OK · `npm run build`: OK · `git diff --check`: OK

## 4. DECISÕES DO CARD (aguardando você)
O card deve estar no seu Telegram (@CerberusFindsBot) com os botões:
- **[✅ PUBLICAR]** → registra decisão no PendingReview (`approve_only`); NÃO publica no site nesta fase.
- **[❌ DESCARTAR]** → cancel_rev; nenhuma mutation.

Esta prova corresponde ao passo 6 da sua autorização; os botões não foram acionados por mim.

## 5. PRÓXIMO PASSO MÍNIMO
1. Você valida o card no Telegram (com imagem real, preço não-verificado e offerLink oficial).
2. Ao clicar em PUBLICAR/DESCARTAR, registro a decisão e reporto.
3. Revoke manual da key temporária Render `rnd_PclWCbYitirnEiUDC5sI15WbdcsM` (Dashboard → Account Settings → API Keys — a Render não expõe revogação via API).
4. Sem nova autorização sua, nada mais é executado (N15/N16/N18 continuam bloqueados).

**CLASSIFICAÇÃO: N17 — FASE 24 — CONSOLIDADO EM PRODUÇÃO (prova real validada; publicação no site permanece bloqueada por política).**
