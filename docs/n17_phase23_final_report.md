# N17 — FASE 23 — RELATÓRIO FINAL
# PROOF_RUN_ID=N17_PHASE23_20260820

## STATUS: SUCCESS — FLUXO COMPLETO VALIDADO EM PRODUÇÃO

### 1. Critério de sucesso (atendido integralmente)
```
Shopee real → Affiliate API → offerLink → preview-telegram → PendingReview
→ Telegram → decisão manual (DESCARTAR/PUBLICAR)
```
O card foi recebido no Telegram com todos os dados oficiais (nome, preço
com escala UNVERIFIED, URL original, link de afiliado oficial, item/shop_id,
aviso de imagem ausente) e os dois botões responderam com feedback visível,
registrando a decisão SEM executar publicação, aquisição ou qualquer mutation.

### 2. Commits e deploy
```
commit 1ca4d37 — Fase 23: rota POST /api/commercial/preview-telegram
                   + handler approve_only + 17 testes (export extractOfferNodes, hooks de teste)
commit cdaf1bc — fix(telegram): feedback visível garantido nos callbacks
                 (approve_only/cancel_rev) + teste de cobertura
deploy Render: dep-da3p1v0jo6nc73egefb0 (LIVE)
/health=200 | SHA servido cdaf1bc1ddd61902d0f086b8a5947ee5a3b707f3
```

### 3. Correção raiz (diagnóstico)
O card de affiliate preview é enviado como mensagem de TEXTO (sendMessage).
Os handlers dos botões usavam editMessageCaption (válido apenas para
foto/documento), o que falhava silenciosamente — por isso os botões não
surtiam efeito. O decision log do Render confirmou que o handler
approve_only ERA executado e a decisão ERA registrada; apenas o feedback
visível falhava. Correção mínima: feedback via nova sendMessage ao chat,
independente do tipo do card. Fallback fail-closed preservado.

### 4. Rotação do TELEGRAM_BOT_TOKEN
Token antigo revogado pelo usuário; novo token `<TOKEN_MASCARADO>`
aplicado no Render (variável TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS
1976526372 intacto) — mesmo deploy cdaf1bc.

### 5. Prova E2E real (produção)
```
POST /api/commercial/preview-telegram
body: {"url":"https://shopee.com.br/product/1530442944/23794344926"}
HTTP=200
reviewId=affprev-124vbe6-mt26gw5g
affiliateStatus=link_acquired
affiliateUrl=https://s.shopee.com.br/40ftCq9rTu  (link oficial da conta)
price=79.90  (priceScaleVerified=false — NUNCA tratado como BRL comprovado)
cardSent=true | shop_id=1530442944 | item_id=23794344926
Idempotência: 2ª chamada → duplicate=true, sem nova consulta à API
```
Respostas dos botões (copiadas do Telegram pelo usuário):
```
❌ DESCARTAR  → "❌ DECISÃO REGISTRADA — DESCARTADO
   A proposta foi descartada e nenhuma publicação ou aquisição foi executada."
✅ PUBLICAR   → "✅ PREVIEW APROVADO — DECISÃO REGISTRADA
   Sem automação nesta fase: o encaminhamento à publicação manual segue o
   fluxo existente. Nenhuma publicação, aquisição ou mutation foi executada."
```

### 6. Migration DDL-only (autorizada)
```
Migration: 20260820_create_telegram_pending_reviews (success=true)
Tabela: public.telegram_pending_reviews
  id text PK, chat_id/sender_id text NOT NULL, first_name, username,
  created_at/expires_at bigint NOT NULL, status text DEFAULT 'pending',
  data jsonb, inserted_at/updated_at timestamptz
Índices: status, expires_at
DDL-only: 0 dados inseridos/alterados/removidos pelo script.
```
Persistência validada em produção: upsert do PendingReview agora grava no
Supabase (2 registros de prova confirmados, status=pending); fallback para
arquivo local permanece ativo (fail-closed). Fallback é acionado
automaticamente quando o Supabase falha (já é o comportamento do repo).

### 7. Gates
```
npm test:          1448 pass / 0 fail (incl. 17 novos + teste de feedback)
npx tsc --noEmit:  OK
npm run build:     OK
git diff --check:  OK
secret scan:       limpo (nenhum secret em código/tests)
```

### 8. Estado final do Supabase (catálogo canônico intacto)
```
products=14 | candidates=0 | evidence=0 | affiliate_links=0
telegram_pending_reviews=2 (somente reviews de prova, status=pending,
expiram naturalmente em 1h — nenhuma limpeza via rota, conforme autorizado)
KEY TEMPORÁRIA RENDER rnd_AQsU...6CEQ: revogada (HTTP 401)
```

### 9. Arquivos alterados (Fase 23 + correção)
```
 server/routes/previewTelegramRoutes.ts        (NOVO, 373 linhas)
 server/services/telegramBot.ts                (+30 handler approve_only, fix feedback)
 server/repositories/telegramRepository.ts     (+28 hooks de teste)
 server/commercial/affiliate/shopeeApiClient.ts (+8 export extractOfferNodes)
 server.ts                                     (+6 registro da rota)
 tests/previewTelegramRoutes.test.ts           (NOVO, 492 linhas, 17 testes)
```
Nenhuma alteração em N14/N15, thresholds, weights, scores, contracts,
governança, fluxo de aquisição/publicação, Seller API ou scraping.

### 10. Limitações registradas
1. A Affiliate API NÃO fornece imagens no nó de oferta — o card informa
   explicitamente; nada foi inventado.
2. price permanece quality=UNKNOWN, unit=string_price_unscaled,
   scale=UNVERIFIED — confirmado na resposta (priceScaleVerified=false).
3. Reviews vivem no Supabase E no arquivo local do runtime (dupla
   persistência; arquivo é efêmero entre deploys — o banco é a fonte
   de auditoria).
4. Idempotência por URL normalizada impede reteste do mesmo card (design).

### 11. Próximos passos possíveis (dependem de nova autorização)
- Encaminhamento manual do produto aprovado ao fluxo de publicação
  existente (fora do escopo desta fase).
- Persistir também imagens quando a fonte oficial passar a fornecê-las.
- N14/N15 seguem bloqueados por dimensões contratuais ausentes
  (2ª dimensão comercial Shopee ainda não disponível oficialmente).

ENCERRAR FASE 23. NÃO avançar para aquisição, publicação ou N16/N18 sem
autorização explícita.
