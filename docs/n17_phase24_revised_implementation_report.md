# N17 — Fase 24 — Relatório de Implementação Revisada (Scraper Integration + Suíte de Testes)

**PROOF_RUN_ID:** `N17_PHASE24_TESTED_20260821`
**Data:** 2026-08-21 (GMT-3)
**Escopo:** Elo Affiliate API → Scraper existente → PendingReview → Telegram (enriquecimento com imagens e preço observacional, fail-closed estrito).
**Autorização requerida para publicação:** SIM — nenhum commit, push ou deploy foi executado.

---

## 1. O que foi implementado e validado

### 1.1 Rota `POST /api/commercial/preview-telegram` (fase 24, implementação anterior)

A implementação do elo permanece a aprovada anteriormente e foi mantida intacta:

| Comportamento | Regra |
|---|---|
| Autoridade de identidade e links | Affiliate API (`shopId`, `itemId`, `productLink`, `offerLink`/affiliateUrl) |
| Scraper (reuso do `server/services/scraper.ts` via `extractProductForReview`) | Fonte de **imagens** e **preço observacional** apenas |
| Verificação de identidade | Determinística contra `productLink` oficial normalizado (`/product/{shop_id}/{item_id}`); divergência → **424** |
| Scraper falho (bloqueio/timeout/sem dados) | **Fail-closed: 424, sem card, sem review persistido** |
| Preço sem escala verificada | Sempre anotado como "escala não verificada — não tratar como moeda"; nunca "R$"; `priceScaleVerified: false` |
| Card Telegram | Foto (`sendPhoto`) com a imagem oficial observada quando disponível; legenda com origem observacional e nota de escala |

### 1.2 Mudanças desta etapa (calibração da suíte de testes)

1. **`server/services/productAutomation.ts`** — adicionado hook oficial de teste `setTestFindExistingProduct`, seguindo exatamente o padrão `setXForTests` já existente na codebase (`telegramRepository`, `previewRegistry`, `affiliateRepository`). Override `null` por padrão; nunca ativo em produção.

2. **`tests/previewTelegramRoutes.test.ts`** — suíte atualizada para consumir o **scraper real** nos testes da rota:
   - Helper `buildFakeShopeeHtml` gera um anúncio Shopee mínimo realista (JSON-LD `Product` com `name`, `image` em hashes CDN `down-br.img.susercontent.com`, `offers` e `og:title`), servido como `Response` real com body stream — o scraper só processa HTML com body legível.
   - Hook `setTestFindExistingProduct` instala o bypass do Supabase em teste; `installFakeTelegramRepo` fakeia `savePendingReview/getPendingReview`; `installFakeAffiliateFetch` responde à Affiliate API com cenários parametrizados (200, bloqueio, preço ausente, item divergente).
   - Captura dos corpos enviados ao Telegram (`telegramCallBodies`) para validar o card de foto (`sendPhoto` com `photo` CDN + `caption`).

3. **Novos testes da Fase 24 (4 cenários):**

| # | Teste | Verificação |
|---|---|---|
| 1 | Scraper enriquece o card com imagens e preço observacional | `200`, card enviado como **foto** (sendPhoto) com 2 imagens oficiais CDN, legenda com origem observacional e nota de escala; `1` chamada ao scraper; review persistido com `imagens.length=2` |
| 2 | Scraper com anúncio bloqueado → fail-closed | `424`, `error: scraper_enrichment_failed`, `failureReason` indica bloqueio/extração; **0 chamadas ao Telegram**, `saveCallCount=0`, sem `reviewId` |
| 3 | Scraper com item divergente (`99999999999/88888888888`) → fail-closed por identidade | `424`, `failureReason: scraper_identity_mismatch`; sem card e sem review |
| 4 | Scraper sem preço no HTML → card usa o preço oficial da Affiliate API | `200`, `price: 99` (valor bruto oficial), `priceScaleVerified: false`, review persistido com imagens e descrição anotando a escala não verificada |

### 1.3 Ajuste de comportamento observado (documentado, não inventado)

- **Categoria do PendingReview:** com o scraper real, `curatedCategory` passa a refletir a categorização curatorial (ex.: "Acessórios") em vez do placeholder `affiliate_preview` — a categoria do source `affiliate_preview` permanece registrada no campo `existingProduct.source` e na descrição. Teste atualizado para aceitar a categoria curatorial real.
- **failureReason propagado:** o motivo real observado pelo scraper (mensagem de bloqueio anti-bot ou código interno) é propagado no corpo do 424 — o teste aceita tanto o código interno quanto a mensagem de bloqueio.

---

## 2. Gates executados

| Gate | Resultado |
|---|---|
| `npm test` (suíte completa, 1452 testes) | **1452 pass, 0 fail, 0 cancelled** (~64s) |
| `npx tsc --noEmit` | **OK** (0 erros) |
| `npm run build` | **OK** (`dist/server.cjs` 1.0mb, esbuild 41ms) |
| `git diff --check` | **OK** (sem whitespace issues) |
| Secret scan (grep por patterns OpenAI/GitHub/Slack/Shopee secret) | **OK** (nenhum secret exposto) |
| Suíte específica da rota (22 testes) | **22 pass, 0 fail** |

---

## 3. Arquivos alterados (diff)

```
docs/n17_phase23_final_report.md       | 188 +++++++++++++---------
server/routes/previewTelegramRoutes.ts | 282 ++++++++++++++++++++++++++++++---
server/services/productAutomation.ts   |  26 ++-
tests/previewTelegramRoutes.test.ts    | 251 +++++++++++++++++++++++++++++++++--
```

**Resumo por arquivo:**

- **`server/routes/previewTelegramRoutes.ts`** (+282/−): implementação da Fase 24 — `extractCanonicalShopeeIds`, `enrichWithExistingScraper` (fail-closed), `buildPreviewCardText` com `priceSource` e contagem de imagens, `sendTelegramPhoto` quando há imagem oficial, `persistPreviewReview` com imagens/curadoria e notas de proveniência observacional.
- **`server/services/productAutomation.ts`** (+26/−): hook de teste `setTestFindExistingProduct` (padrão `setXForTests`; override `null` em produção).
- **`tests/previewTelegramRoutes.test.ts`** (+249/−2): helper do HTML fake Shopee, fake do scraper, hooks do Supabase/Telegram, e os 4 novos testes fail-closed/enriquecimento.
- **`docs/n17_phase23_final_report.md`**: ajustes menores de documentação (reflexo do enriquecimento observacional).

**Não alterados (confirmado):** `contract.ts`, `engine.ts`, weights, thresholds, `commercialBrain`, `governance` (N13/N14/N15), N16, N17 core, `affprv-shopee` provider, N8, N6, `telegramRepository` (só hooks de teste existentes usados), Supabase schema, credenciais, rotas de aquisição/publicação.

---

## 4. Comportamento confirmado do card Telegram (validado em teste com scraper real)

```
🛒 CERBERUS FINDS — PREVIEW SHOPEE
🏷️ <nome observado no anúncio>
💰 79,90 (observacional — escala não verificada — não tratar como moeda)
🖼️ Imagem: 2 imagem(ns) oficial(is) observadas no anúncio (scraper · proveniência do anúncio original)
🔗 URL original / link de afiliado / auditoria shop_id · item_id
```

- Com imagem: card enviado como **foto** (`sendPhoto`, `parse_mode: HTML`).
- Sem imagem (scraper sem imagens e Affiliate sem imagem): card enviado como **texto** (`sendMessage`) informando a ausência oficial.
- Callbacks `[✅ PUBLICAR]` / `[❌ DESCARTAR]` inalterados (aprovados na Fase 23).

---

## 5. Limitações conhecidas

1. **Curadoria Gemini em teste:** sem `GEMINI_API_KEY` no sandbox, o scraper descreve/curadoria de texto não é executada; título e imagens vêm do JSON-LD/CDN real. Em produção (Render com env), a curadoria é executada normalmente.
2. **Preço sempre sem escala verificada:** a normalização da Fase 12-13 permanece `unit=string_price_unscaled, quality=UNKNOWN` — o card exibe o valor bruto com nota explícita.
3. **PendingReview com categoria curatorial:** o campo `categoria` reflete a curadoria do anúncio (ex.: "Acessórios"); a proveniência `affiliate_preview` segue em `existingProduct.source` e na descrição.
4. **N14 permanece fora do escopo:** nenhuma alteração de thresholds, score, policy ou weights; o preview não executa N13/N14/N15/N17.

---

## 6. Estado final e próximo passo

- **Gates:** todos PASS.
- **Publicação:** AUSENTE (nada commitado/enviado/deployado).
- **Supabase/produção:** não tocados; `products` canônico intacto (14 registros na última prova oficial).
- **NEXT_MINIMAL_CHANGE (aguardando sua autorização):** commit isolado + push + deploy + E2E real de ponta a ponta (`Shopee Affiliate → scraper → foto com preço observacional → Telegram → approve_only/cancel_rev`), com cleanup dos registros de prova em seguida.
