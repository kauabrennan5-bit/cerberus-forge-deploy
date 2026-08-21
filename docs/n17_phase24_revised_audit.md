# N17 — FASE 24 REVISADA — AUDITORIA READ-ONLY
# Affiliate API → Scraper → PendingReview → Telegram → pipeline.publish
# PROOF_RUN_ID=N17_PHASE24_REVISED_20260821 — SEM ALTERAÇÃO DE CÓDIGO

## A) Scraper existente (`server/services/scraper.ts`, ~995 linhas)

**Entrada:** `fetchProductDataFromUrl(urlStr, rawTextOverride?)` — recebe uma
URL de marketplace (Shopee/Mercado Livre/E-commerce comum). Rejeita com
fail-closed: protocolo não http(s), redes privadas/localhost, e
marketplaces não reconhecidos (`detectMarketplace === "Outros"` → erro).
Timeout de 15s, limite de 750KB de HTML, até 3 redirecionamentos seguidos
(whitelisted por marketplace).

**URL que processa:** aceita qualquer URL pública de marketplace permitida,
incluindo exatamente `https://shopee.com.br/product/{shop_id}/{item_id}`.
A normalização canônica (reusada via `normalizeProductUrl` no
`productAutomation.ts:118-170`) transforma os 4 formatos oficiais Shopee
(`/product/{shop}/{item}`, `/{loja}/{shop}/{item}`, com slug, e
`-i.{shop}.{item}`) na forma canônica `/product/{shop_id}/{item_id}`.

**Campos extraídos:** `title` (JSON-LD > OG > `<title>` > derivado da URL),
`price` (number decimal ou null — 8 estratégias sequenciais, fail-closed:
nunca inventa; descarta parcelas, preços riscados e valores fora de
0–100.000 via `isContextuallyValidSalePrice`), `images` (string[]),
`rawContent` (texto de contexto com audit trail do que foi observado).

**Como obtém imagens:** `extractShopeeCdnImages` lê os hashes oficiais da
galeria do produto (`"images"/"image_list"/"image_ids"` no JSON interno da
página) e monta URLs do CDN oficial
`https://down-br.img.susercontent.com/file/{hash}` em alta resolução
(limpa sufixos _tn/_b), com fallback por regex no HTML. `dedupeAndCleanImages`
filtra favicons/logos/badges/trackers.

**Como obtém preço:** `extractCorrectPrice` — JSON-LD, dados internos, OG,
meta tags, seletores HTML, estratégia específica Shopee, ML e regex. Todas
as 8 falharem → `null` (fail-closed). Semântica: número decimal exibido na
página, tipicamente BRL da loja BR; o próprio scraper o apresenta como
`R$ X.XX` no rawContent, mas **não há contrato oficial de escala** — a
proveniência permanece "scraper observacional".

**Como valida:** rejeição de URL insegura; título genérico (`isGenericTitle`
— jargões de marketplace, "account verification", 403, captcha);
título+imagens ausentes → bloqueio da extração inteira
(`productAutomation.ts:348-363`); `containsRawPayloadMarkers` bloqueia
descrições com payload técnico do scraper na publicação (pipeline).

**Transporte:** `extractProductForReview` (`productAutomation.ts:311`)
retorna `{success, data: {normalizedUrl, marketplace, produto, categoria,
preco, imagens, descricao, existingProduct}}`. Curadoria editorial via
Gemini (opcional, com orçamento). O caller do bot
(`telegramBot.ts:1458-1500`) avalia via `pipeline.evaluate`, cria o
PendingReview completo (com lifecycle) e envia o card — foto quando há
imagem, texto quando não há. É o caminho do `/discover` e do envio de link
direto no chat (fluxo atual de publicação manual).

## B) Pipeline de publicação existente

O `confirm_pub:` do bot (`telegramBot.ts:1114-1160`) executa o pipeline
canônico: `createProductionProductPipeline().evaluate({...}) →
pipeline.approve → pipeline.publish`. O adapter de produção
(`productPipeline.ts:202`) exige do candidate: `produto`, `categoria`,
`preco` (number, fallback 0), `imagens` (string[]), `normalizedUrl`,
`descricao`, `ref`. O `validateCandidate` (`productLifecycle.ts:164`)
aplica hard-FAIL em: URL inválida, título genérico/ausente, payload técnico
na descrição, **preco<=0**, **imagens vazias** e marketplace não Shopee/ML.
O `publish` cria o produto canônico (`createProduct`, status=approved) e
roda `syncCatalogAndDeploy` (catálogo Supabase + projeção + vitrine), com
rollback não destrutivo se a validação pública falhar.

O offerLink oficial da Affiliate API entra pelo parâmetro
`affiliateUrl` da decisão (publicationRoutes já suporta
`affiliateUrl` + `provider: "admin:manual"`); o PendingReview do
affiliate_preview já preserva o link em
`existingProduct.affiliateUrl` e `descricao`.

## C) Ponto mínimo de conexão

**Fluxo atual:** Affiliate API (Fase 23) → PendingReview com título, URL,
offerLink e shop/item (SEM imagens; preço 0 quando ausente) → Telegram
(card texto) → approve_only registra decisão → nada publica.

**Fluxo desejado:** Affiliate API (identidade + offerLink oficial) →
**scraper** (enriquece com imagens, preço exibido) → validação →
PendingReview completo (affiliate + scraper) → Telegram (card com foto)
→ aprovação humana → pipeline.publish canônico com o offerLink.

**Gap exato:** a rota `previewTelegramRoutes.ts` persiste o review logo
após o `acquireAffiliateLink`, **antes** de qualquer enriquecimento. O
scraper e todo o caminho de enriquecimento já existem e são o mesmo
`extractProductForReview` que o fluxo de link do bot usa.

**Menor alteração arquitetural (dentro da rota existente, sem rota nova):**
na `POST /api/commercial/preview-telegram`, entre o `acquireAffiliateLink`
(elegível) e o `persistPreviewReview/sendPreviewCard`:

1. Chamar `extractProductForReview(productLinkOficial)` — a MESMA URL
   canônica normalizada que a Affiliate API confirmou;
2. Validar o **vínculo de identidade** (item E): extrair shop_id/item_id da
   URL normalizada retornada pelo scraper e comparar com os IDs oficiais
   da resposta da Affiliate API; divergência → 424 fail-closed;
3. Fazer **merge** com precedência e proveniência explícita:
   - imagens = `scraper.imagens` (se >=1; senão manter [] e avisar no card);
   - preco = scraper.price quando >0 (proveniência `scraper_observational`,
     SEM escala/moeda oficial — manter `priceScaleVerified: false` no
     `existingProduct` e não rotular como BRL comprovado; o preço da
     Affiliate, quando presente, permanece como está);
   - título/descrição/categoria: preferir os curatoriais do scraper
     (editoriais) sobre os da API; produto oficial da API preservado em
     `descricao` para auditoria;
   - offerLink/affiliateUrl, shop_id, item_id, productLink: SEMPRE da
     Affiliate API (fonte oficial).
4. Persistir o review completo e enviar o card (foto quando houver imagem).
5. O approve_only e o caminho à publicação não mudam: o confirm_pub já
   executa evaluate→approve→publish e o offerLink está no review.

**Prova de identidade (item E):** a URL usada pelo scraper é a
`productLink` oficial retornada pela própria Affiliate API e é normalizada
para `/product/{shop_id}/{item_id}` — a mesma forma de identidade que a
Affiliate API confirma no response (`itemId`, `shopId`). A identidade vem
da **URL contratada**, não de heurística de conteúdo; se a normalização
não resolver (shop_id/item_id ausentes) ou divergir da resposta oficial,
fail-closed 424. Não há como a página servida por essa URL pertencer a
outro produto — o vínculo é determinístico pela construção da URL.

**Arquivos que seriam alterados (mínimos):**
1. `server/routes/previewTelegramRoutes.ts` — merge affiliate+scraper
   antes de `persistPreviewReview`/`sendPreviewCard` (único arquivo
   funcional novo; ~40-60 linhas);
2. `tests/previewTelegramRoutes.test.ts` — testes do merge;
3. documentação (`docs/n17_phase24_revised_*.md`).

Nenhum arquivo de scraper, pipeline, contract, engine, N14/N15,
governança, N8/N16/N17/N18 seria tocado.

**Testes necessários:** scraper com a URL canônica retornando imagens →
review com imagens e preco>0; scraper falhando (bloqueio 403/timeout) →
424 sem card e SEM retry (review não persistido) ou com card degradado
(afirmar a política no gate); identidade divergente → 424; imagens
vazias → card texto com aviso de imagem ausente; preço ausente do
scraper → preco permanece como hoje; proveniência e priceScaleVerified
nos asserts; idempotência preservada; callback inválido.

**Riscos:**
1. **Bloqueio anti-bot da Shopee** — o SSR da Shopee frequentemente nega
   o fetch do scraper (é exatamente o caso documentado em
   `productAutomation.ts:356`: "Preço indisponível no SSR da Shopee
   (requer API privada/autenticada)"). O merge deve tratar falha do
   scraper como caminho degradado (424 sem card, ou card sem imagem se a
   política decidir tolerar) — nunca inventar imagem.
2. **Preço divergente** — Affiliate (string decimal, UNVERIFIED) vs
   scraper (number observacional) podem diferir; o card deve exibir o
   preço do scraper com proveniência explícita, e ambos permanecem
   UNVERIFIED quanto à escala oficial — nenhuma moeda/comparação
   automática.
3. **Latência** — scraper adiciona até 15s à rota (hoje instantânea);
   aceitável para operação manual.
4. **Curadoria Gemini** — o enriquecimento passa a usar o orçamento
   Gemini (opcional, já presente no fluxo do bot); falha de curadoria
   mantém dados brutos do scraper (comportamento existente).

**Dry-run E2E:** possível — a prova com a URL real
`shopee.com.br/product/1530442944/23794344926` validaria imagens/preço do
scraper contra a identidade oficial antes de qualquer aprovação.

## D) Resposta direta

- Scraper aceita `https://shopee.com.br/product/{shop_id}/{item_id}`
  diretamente: **SIM** (detectMarketplace="Shopee", normalização
  canônica padrão 1).
- Associação inequívoca scraper↔Affiliate: **SIM, pela URL normalizada**
  (`/product/{shop_id}/{item_id}` extraída deterministicamente do
  productLink oficial e comparada aos IDs da resposta da API); fail-closed
  em qualquer divergência.

## PRÓXIMO

**NEXT_MINIMAL_CHANGE:** implementar o merge affiliate+scraper na rota
`preview-telegram` (arquivo único), com a verificação de identidade, a
política de fail-closed para scraper falho, a proveniência
`scraper_observational` com `priceScaleVerified: false`, os testes e os
gates completos — sem commit/push/deploy até sua autorização.
