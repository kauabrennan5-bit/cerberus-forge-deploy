# N17 — Fase 23 — Auditoria do fluxo operacional básico e proposta da menor alteração

**Data:** 20 de agosto de 2026
**Escopo:** validar ponta a ponta Shopee Affiliate API → produto real → affiliate link → Telegram → decisão manual [✅ PUBLICAR] / [❌ DESCARTAR].
**Condição de entrega:** relatório ANTES de qualquer alteração de código, commit, push ou deploy. Linha Seller/2ª dimensão pausada.

## Resultado da auditoria (A–E)

### A) Operações Affiliate já disponíveis

O cliente oficial (`server/commercial/affiliate/shopeeApiClient.ts`) expõe três operações, todas autenticadas com SHA-256 pelas credenciais `SHOPEE_AFFILIATE_APP_ID/SECRET` já propagadas ao runtime Render:

| Operação | Tipo | Conteúdo retornado | Observação |
| --- | --- | --- | --- |
| `lookupProduct({shopId, itemId})` | Query read-only | `itemId`, `shopId`, `productName`, `price`, `productLink`, `offerLink` | A chamada que sustentará o teste — traz produto + link de afiliado + identidade em **uma única chamada oficial** |
| `acquireAffiliateLink({shopId, itemId})` | Leitura + mutation de fallback | `affiliateUrl`, `acquisition_ref`, `response_digest` | Parseia o `offerLink` do nó; faz a mutation `generateShortLink` apenas quando `offerLink` ausente |
| `generateShortLink(input)` | Mutation oficial | `shortLink`, `longLink` | Aceita `subIds` customizáveis (ex.: `shopee_test`) |

### B) Discovery atual

O N3 Research (`server/commercial/discovery/research.ts`) já resolve a identidade `(shop_id, item_id)` a partir de uma URL Shopee (padrões `/product/{shopid}/{itemid}`, `/i.{shopid}.{itemid}`, etc.), executa `lookupProduct` e persiste evidências em `candidate_evidence` **sem tocar** o catálogo canônico nem links de afiliado. Já foi exercitado em produção nas provas das Fases 15 e 20.

### C) Obtenção do affiliate link

O link de afiliado vem do campo `offerLink` do nó retornado pela própria query read-only — ou seja, **na primeira fase do teste não é necessária nenhuma mutation de aquisição**: a mesma chamada que traz o produto traz o link oficial da conta afiliada. A mutation `generateShortLink` permanece como fallback oficial caso `offerLink` esteja ausente.

### D) Telegram — o que já existe

O bot (`server/services/telegramBot.ts`, 1621 linhas) roda via webhook com `TELEGRAM_BOT_TOKEN` e usuários autorizados (`TELEGRAM_ALLOWED_USER_IDS`), e já possui **infraestrutura completa de revisão manual**: repositório `PendingReview` (`telegramRepository.ts` com estados `pending/published/cancelled/rejected/error`), card de revisão formatado e teclado inline com `[✅ Confirmar & Publicar]` e `[❌ Rejeitar]`.

**Achado crítico para a regra 11 do seu prompt:** o handler atual `confirm_pub:` (linha 1082) executa o pipeline canônico completo e **publica automaticamente no site** (`pipeline.publish`). Para o teste, PUBLICAR deve apenas **registrar a decisão** sem publicar — o caminho existente não serve como está.

**Achado sobre imagens:** o nó oficial `productOfferV2` **não retorna imagem** (selection set fixo: `itemId shopId productName price productLink offerLink`). A regra do prompt ("imagem, se disponível") implica comunicar explicitamente a ausência, sem inventar imagem.

### E) Menor alteração necessária

Uma única rota administrativa nova, `POST /api/commercial/preview-telegram` (autenticada por `x-admin-password`, como as demais), que encadeia componentes já existentes sem modificar nenhum deles:

```
/admin POST { url } ──► resolveShopeeIdentity (existente)
                    ──► lookupProduct  (1 chamada oficial read-only)
                    ──► offerLink do nó (link oficial já com sua marca)
                    ──► PendingReview com source "affiliate_preview" (repositório existente)
                    ──► Card Telegram com teclado [✅ PUBLICAR] [❌ DESCARTAR]
```

Detalhes do design, todos fail-closed:

| Item | Decisão |
| --- | --- |
| Domínios não-Shopee | rejeitados (whitelist Shopee existente do identity resolver) |
| Falha na API | card não enviado; erro reportado ao admin; nenhum registro parcial |
| `offerLink` ausente | card enviado informando "link de afiliado não elegível"; sem mutation |
| `✅ PUBLICAR` | novo callback `approve_only:{reviewId}`: valida callback, marca review como `published` (apenas decisão registrada, **sem** `pipeline.publish`) e confirma ao usuário que o produto foi encaminhado ao fluxo manual |
| `❌ DESCARTAR` | reutiliza o callback `cancel_rev:` existente → review `cancelled` |
| Preços | exibido como número com a nota fixa **"escala não verificada"** (unidade `string_price_unscaled`; jamis rotulado como R$ nem convertido) |
| Imagem | ausente oficialmente; card indica "imagem não fornecida pela fonte oficial" |
| Arquivos alterados | ~3: nova rota handler + módulo utilitário do card; N13/N14/N15/N16/N17/N8, contract, engine e weights **intactos** |
| Persistência | somente `PendingReview` existente; sem tabela nova, sem efeito colateral no catálogo |

## Critério de sucesso do teste

```
SHOPEE AFFILIATE API (lookupProduct, 1 chamada)
   ↓ produto real (nome, preço UNVERIFIED, productLink, item_id+shop_id)
   ↓ offerLink oficial da sua conta
   ↓ Telegram: card com [✅ PUBLICAR] [❌ DESCARTAR]
   ↓ você vê o produto
   ↓ você escolhe PUBLICAR (registro apenas) ou DESCARTAR
```

Nenhuma publicação automática, nenhuma aquisição irreversível, nenhum scrape, nenhuma alteração de N14/N15.

## Aguardando sua autorização para

1. Implementar a rota `preview-telegram` e o novo callback `approve_only` localmente;
2. Rodar `npm test`, `npx tsc --noEmit`, `npm run build`, `git diff --check` e secret scan;
3. Executar o teste ponta a ponta com a oportunidade real (ex.: `https://shopee.com.br/product/1530442944/23794344926`);
4. Submeter o diff completo à sua revisão antes de qualquer commit/push/deploy.
