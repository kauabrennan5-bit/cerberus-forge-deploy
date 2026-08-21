# N17 — FASE 24 — NOTAS DE AUDITORIA READ-ONLY (pós approve_only)

Data: 2026-08-21. Escopo: read-only, sem commit/push/deploy, sem aquisição/publicação.

## 1. Ponto exato onde o produto aprovado deve entrar
O fluxo operacional existente para PendingReviews é o handler
`confirm_pub:` (server/services/telegramBot.ts:1114-1160), que:
1. `createProductionProductPipeline().evaluate({...})` (linha 1125)
2. `pipeline.approve(lifecycle)` (linha 1140)
3. `pipeline.publish(lifecycle)` (linha 1141) → productsRepository.createProduct
   (products, status=approved, ref, link, descricao, preco, imagens, ativo)
   + `syncCatalogAndDeploy` (server/services/catalogSync.ts:105) → catálogo
   canônico + vitrine pública.
4. Feedback via editCaption/sendMessage.

O caminho alternativo é publicationRoutes.ts (publicationN16?), mas ele
opera sobre CANDIDATES (fluxo N2→N17) e não sobre PendingReview — NÃO é o
ponto natural para affiliate preview.

CONCLUSÃO: o menor elo é o pipeline.evaluate→approve→publish já usado pelo
confirm_pub. O approve_only atual para ANTES do registro (linha 1100) —
encaminhamento manual = repetir manualmente, via Telegram, o mesmo
caminho que o confirm_pub executa, OU um endpoint dry-run.

## 2. Dados do PendingReview JÁ suficientes (rota preview Telegram)
- produto (productName oficial da Affiliate API)
- normalizedUrl (productLink oficial)
- descricao (audit trail affiliate_preview + priceScaleVerified=false)
- status, categoria="affiliate_preview", existingProduct.affiliateUrl (link oficial do usuário)
- preco (quando a API retornou price decimal: 79.90 no card; preco=0 quando ausente)

## 3. Dados que FALTAM para pipeline.evaluate (hard-FAIL se ausentes)
validateCandidate (server/services/productLifecycle.ts:164):
- preco <= 0 → "Preço válido é obrigatório." (FAIL duro)
- imagens.length === 0 → "Ao menos uma imagem HTTP(S) é obrigatória." (FAIL duro)
- marketplace: detectMarketplace(shopee.com.br)="Shopee" OK (marketplace.ts:45)
- duplicidade: detectDuplicate por link — affiliate preview usa productLink (link comum Shopee), não offerLink; duplicidade contra products existentes OK
- categoria não confirmada → WARNING; descricao → WARNING (ambos aceitáveis: outcome=WARNING → PENDING_APPROVAL, curation recommendation=REVIEW)

GAP PRINCIPAL: IMAGENS. Affiliate API não fornece imagem (policy 10010).
Pipeline exige >=1 imagem HTTP(S) → qualquer aprovação affiliate_preview
sem imagem seria REJECTED pelo pipeline.
GAP SECUNDÁRIO: preco=0 quando price ausente/inválido → FAIL.

Mecanismos existentes de preenchimento (Telegram):
- edit_price: (linha 1187) → await_price → parseAndNormalizePrice (R$ editorial)
- edit_cat: (linha 1201) → awaiting_category
- NÃO existe edit_imagem no bot (nenhum callback de imagem)

## 4. Menor alteração arquitetural necessária (candidatos)
Opção A (mínima, sem nova rota): o próprio usuário executa manual:
  approve_only → edit_price (se necessário) → (imagem continua bloqueio)
  → confirmar publicação via fluxo existente.
  PROBLEMA: sem imagem não passa; sem edit_imagem o admin não consegue.
Opção B (elo mínimo): um callback `start_publish:{reviewId}` que executa
  evaluate→approve→publish (idêntico ao confirm_pub, mas exclusivo para
  reviews affiliate_preview) com pré-condição fail-closed:
  preco>0 E imagens.length>0 SENÃO resposta visível com os gaps.
Opção C (reuso total): reusar confirm_pub para affiliate_preview reviews —
  o confirm_pub JÁ funciona para qualquer review; o approve_only pode apenas
  pré-preencher. RISCO: confirm_pub executa pipeline.publish automaticamente
  (fora do espírito "sem automação") — precisa de consentimento por ação.
RECOMENDAÇÃO: Opção B + exigir imagem via edit_imagem novo OU aceitar que
  a publicação manual do affiliate preview seja SEMPRE dry-run primeiro
  (publicationRoutes POST /publish/preview só cobre candidates — não PendingReview).

## 5. Gates/testes necessários se implementado
- Testes: pré-condição preco<=0 → REJECT visível; imagens vazias → REJECT;
  happy path com preco>0 (imagem simulada) → evaluate→approve→publish;
  idempotência (2× start_publish → sem 2ª publicação); callback inválido/expirado.
- npm test, npx tsc --noEmit, npm run build, git diff --check, secret scan.
- Teste E2E dry-run: POST /publish/preview equivalente para review, OU
  start_publish:dry-run (modo preview que para em PENDING_APPROVAL).

## 6. Dry-run E2E possível?
SIM parcialmente: pipeline.evaluate→approve pode ser executado e o record
estado PENDING_APPROVAL sem chamar publish (dry-run nativo). publish real
exige syncCatalogAndDeploy (efeito em produção) — dry-run total exigiria
mock do adapter no endpoint. Alternativa: usar o dry-run existente de
candidates como referência de formato de resposta.

## 7. Restrições respeitadas
- N14/N15, thresholds, weights, scores, contracts, governance: NÃO tocados
- N8/N16/N17/N18, scraping, Seller API: NÃO usados/novos
- Nenhuma execução real de publicação nesta fase
- persistPreviewReview persiste link_oficial em existingProduct.affiliateUrl

## PRÓXIMO: escrever docs/n17_phase24_plan.md e entregar PHASE24_PLAN_READY
