# N17 — FASE 24 — PLANO: OPERAÇÃO MANUAL PÓS APPROVE_ONLY
# PROOF_RUN_ID=N17_PHASE24_20260821 — AUDITORIA READ-ONLY

## PHASE24_PLAN_READY

## 1. Diagnóstico — auditoria read-only do caminho atual

O ponto de entrada natural do produto aprovado é o pipeline de publicação
existente que o handler `confirm_pub:` já utiliza
(`server/services/telegramBot.ts`, linhas 1114–1160). Esse caminho executa
três etapas canônicas e já é o fluxo operacional de decisão humana em
produção, sem criar nenhuma via paralela:

```
pipeline.evaluate({...})      → validação + curadoria (estado PENDING_APPROVAL)
pipeline.approve(lifecycle)   → aprovação humana explícita
pipeline.publish(lifecycle)   → createCanonicalProduct + syncCatalogAndDeploy
```

O `approve_only` da Fase 23 para exatamente após o registro da decisão
(`status=published` no PendingReview) — o elo que falta é a passagem da
revisão aprovada por essas três etapas sob comando humano explícito, caso a
caso, mantendo publicação automática bloqueada por default.

A via alternativa `POST /api/commercial/candidates/:id/publish`
(`server/routes/publicationRoutes.ts`) não é o ponto de entrada adequado:
ela opera sobre candidates do fluxo N2→N17 e possui dependências de
assessment e idempotência próprias, enquanto o preview de afiliado vive no
repositório de PendingReview (Telegram).

## 2. Dados já suficientes no PendingReview (rota preview Telegram)

| Campo | Fonte | Status |
|---|---|---|
| produto (título) | productName da Affiliate API | disponível e oficial |
| normalizedUrl | productLink oficial (link comum Shopee) | disponível |
| affiliateUrl | offerLink oficial da conta | disponível (existingProduct) |
| descricao | audit trail `affiliate_preview · priceScaleVerified=false` | disponível |
| categoria | "affiliate_preview" | disponível (não confirmada → WARNING, não bloqueia) |
| preco | price decimal da API (quando presente) | disponível quando API retorna; 0 quando ausente |
| shop_id / item_id | resposta oficial | disponível para auditoria |

## 3. Dados que ainda faltam (hard-FAIL do validateCandidate)

O validador canônico (`server/services/productLifecycle.ts:164`) rejeita
com falha dura em dois pontos que o preview de afiliado não cobre:

1. **Imagens obrigatórias (>=1 HTTP(S))** — a Affiliate API não fornece
   imagens (policy 10010, confirmada nas Fases 14/22) e o PendingReview é
   salvo com `imagens=[]`. **Este é o bloqueio principal.** Sem ao menos
   uma imagem, qualquer tentativa de publicação seria REJECTED pelo
   pipeline. Não existe atualmente callback `edit_imagem` no bot; apenas
   `edit_price:` e `edit_cat:` permitem preenchimento manual.
2. **Preço válido (preco>0)** — quando a API não retorna price (ou retorna
   string inválida), o review é salvo com `preco=0`, que também falha. O
   callback `edit_price:` já permite preenchimento manual editorial, e o
   caso real da prova retornou 79,90, então este gap é intermitente.

O marketplace é reconhecido (`detectMarketplace(shopee.com.br) = "Shopee"`)
e a duplicidade contra o catálogo canônico usa o productLink — ambos OK.

## 4. Menor alteração arquitetural (recomendada)

Introduzir **um único callback** `publish_review:{reviewId}`, exclusivo para
reviews `affiliate_preview`, no mesmo serviço do bot, executando as três
etapas canônicas do fluxo existente com pré-condições fail-closed:

1. Se `preco <= 0` → resposta visível no chat: "preço obrigatório — use
   💰 Alterar Preço"; **sem mutation**.
2. Se `imagens.length === 0` → resposta visível: "imagem obrigatória —
   forneça a URL da imagem do produto (fonte editorial sua)"; **sem
   mutation**. (Adicionar também o callback mínimo `edit_imagem:{id}` que
   aceita uma URL HTTP(S) fornecida pelo admin, com validação de formato.)
3. Somente com ambas satisfeitas: `evaluate → approve → publish`, com o
   mesmo tratamento de erro/rollback e feedback que o confirm_pub já tem,
   registrando no review `published_by=publish_review · approved_review={id}`.

Isso reutiliza 100% do fluxo existente (evaluate/approve/publish/createCanonicalProduct/
syncCatalogAndDeploy), não cria nenhuma rota HTTP nova, não toca N14/N15,
thresholds, weights, scores, contracts, governança, N8/N16/N17/N18, e
mantém a publicação automática bloqueada — a ação exige o clique humano
em um card de revisão existente, por revisão.

## 5. Gates e testes necessários

- Testes unitários (node:test, padrão do projeto): pré-condição preco<=0
  → sem publish; imagens vazias → sem publish; happy path com preco>0 e
  imagem (pipeline mockado) → evaluate→approve→publish; double-click
  → sem segunda publicação; callback em review inválida/expirada →
  mensagem de erro; review de categoria não-affiliate → recusa do callback.
- Gates completos: `npm test`, `npx tsc --noEmit`, `npm run build`,
  `git diff --check`, secret scan.

## 6. Teste E2E em modo dry-run

Possível, em dois níveis:

- **Dry-run parcial (sem efeito em produção):** o pipeline publicado em
  `evaluate→approve` para naturalmente em `PENDING_APPROVAL` — o endpoint
  pode executar somente até ali e devolver o lifecycle previewado
  (score, curation, validation warnings), exatamente o que o
  `POST /publish/preview` de candidates já faz como formato de resposta.
  Este nível é seguro para validar o preenchimento de gaps antes de
  qualquer publicação real.
- **Dry-run total:** exigiria mock do adapter no endpoint (invasivo) — não
  recomendado; o dry-run parcial atende a necessidade sem alterar o
  adapter de produção.

O E2E real seguiria: enviar preview da mesma URL variante → 💰 confirmar
preço → ✏️ fornecer imagem → ✅ PUBLICAR (approve_only) → 🚀 publicar
(publish_review) → verificar produto no catálogo e cleanup da prova.

## 7. Decisão

O menor elo arquitetural é **um callback de publicação por demanda
(`publish_review`) + um callback de imagem (`edit_imagem`)**, reutilizando
integralmente o pipeline canônico já validado em produção pela Fase 23.
Sem esse elo, o produto aprovado no Telegram não tem caminho para o site
sem recriar a review pelo fluxo antigo — o approve_only sozinho registra
a decisão mas não publica.

**NEXT_MINIMAL_CHANGE:** implementar os 2 callbacks novos
(publish_review + edit_imagem) com as pré-condições fail-closed, os testes
correspondentes, rodar os gates completos e entregar o diff para
autorização antes de qualquer commit/push/deploy.

Não foram executados nesta fase: nenhum commit, push, deploy, aquisição,
publicação, N14/N15, Seller API, scraping ou alteração de governança.
