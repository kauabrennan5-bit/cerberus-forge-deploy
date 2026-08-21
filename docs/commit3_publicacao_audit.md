# Commit 3 — Auditoria da Publicação Real (E2E do usuário)

## Estado de produção
- SHA servido: d242e0a (commit do Commit 3) ✓
- Webhook: configurado, 0 pending ✓
- Produto publicado: prod-1787286088338, ref REF-015, preco 97, status=published ✓

## ACHADO CRÍTICO 1 — link publicado NÃO é o affiliate link
- `link` no products = `https://shopee.com.br/product/1530442944/23794344926`
  (URL pública ORIGINAL, não o affiliate link)
- Affiliate link oficial: `https://s.shopee.com.br/40ftCq9rTu`
  (está APENAS dentro do texto da descricao como proveniência)
- Hipótese: o productPipeline.publish (createCanonicalProduct) usa
  review.normalizedUrl (ou affiliateUrl?) como `link`. Verificar:
  - server/services/productPipeline.ts: mapeamento link na publicação
  - server/services/productAutomation.ts: createCanonicalProduct
- O botão "ADQUIRIR PEÇA OFICIAL" no site usa `link` → usuário NÃO ganha
  comissão. Corrigir para preservar affiliateUrl da review quando existir
  (fonte: shopee affiliate preview). NÃO inventar: se affiliateUrl ausente,
  usar productLink original (autoridade Affiliate API).

## ACHADO CRÍTICO 2 — metadados internos expostos no site
- `descricao` do produto publicado = texto raw de proveniência:
  "affiliate_preview · source=/shopee · batch=shopee-mt2eoarf · position=1 ·
  link oficial retornado pela Affiliate API: https://s.shopee.com.br/40ftCq9rTu
  · enriquecimento scraper: 9 imagem(ns) · preço com escala não verificada ·
  auditoria identidade: shop_id=1530442944 item_id=23794344926"
- Badge "AFFILIATE_PREVIEW" renderizada no front (tag interna de proveniência
  derivada da descricao/slug? verificar client que renderiza badge).
- Correção proposta (falhar fechado, sem perda de proveniência):
  a) Não publicar `descricao` raw de proveniência como conteúdo público —
     a descrição pública do produto deve ser vazia/limpa OU a proveniência
     deve ir para coluna separada (ex.: proveniencia/origem) interna, não exibida.
  b) Front: nunca renderizar badge a partir de prefixos técnicos; remover o
     bloco "ESPECIFICAÇÕES DA PEÇA" raw ou movê-lo para área admin.
  c) Manter a proveniência completa armazenada no registro (auditoria) —
     apenas separar apresentação pública.

## Origem provável do texto
- Persistido no PendingReview (data) pela Fase 24 (preview-telegram rota)
  como `descricao` com proveniência raw.
- productAutomation.createCanonicalProduct copia review.descricao → products.descricao.

## Colunas da tabela products (Supabase)
id, ref, produto, categoria, preco, imagens, link, ativo, destaque, status,
created_by, slug, descricao, pagina_ponte_url, created_at

## Colunas telegram_pending_reviews
id, chat_id, sender_id, first_name, username, created_at, expires_at, status,
data (jsonb), inserted_at, updated_at
(reviewId é campo dentro de data JSON)

## Reviews pendentes restantes (para cleanup pós-prova)
affprev-124vbe6-mt29szbp, mt29epid, mt29cny3, mt29as8k (todas pending,
produto Porta Talher, preco 79.9 ou 0)

## Próximos passos (aguardando autorização do usuário)
1. Corrigir mapeamento link → affiliateUrl preservado (publish).
2. Separar proveniência interna da descricao pública (productAutomation + bot
   /publicar que monta payload).
3. Front: badge/texto raw não exibidos (verificar client/src onde badge
   AFFILIATE_PREVIEW é renderizado).
4. Manter governança: preços continuam escala não verificada; preço do produto
   publicado veio do ajuste manual do usuário via Telegram (97) ✓.

## ACHADOS TÉCNICOS DETALHADOS (fluxo confirm_pub → publish)

### Onde o link errado é decidido
- server/services/productPipeline.ts linha ~216-223 (createProductionProductPipeline):
  createCanonicalProduct faz: link: candidate.normalizedUrl, descricao: candidate.descricao
- Ou seja: `link` = review.normalizedUrl (URL pública original da Shopee),
  SEMPRE. O affiliateUrl da review NUNCA é usado para o link publicado.

### Onde a descrição raw sobrevive
- server/services/productLifecycle.ts, normalizeCandidate (linha 94+):
  descricao: containsRawPayloadMarkers(rawDescription) ? "" : rawDescription
  → A descrição publica é vazia SOMENTE se tiver "raw payload markers".
  O texto de proveniência "affiliate_preview · source=/shopee · ..." NÃO tem
  esses markers → publicado como-is.
- Badge "AFFILIATE_PREVIEW": é prefixo do texto da descricao ("affiliate_preview ·")
  → o front/cliente provavelmente exibe o bloco inteiro como "ESPECIFICAÇÕES DA
  PEÇA". Verificar renderização no client (busca por "affiliate_preview" ou badge).

### Onde a proveniência é criada
- preview-telegram (Fase 24): persistPreviewReview armazena review.descricao =
  texto de proveniência raw. Bot /publicar copia review para evaluate com
  descricao: review.descricao (mesmo raw).

### Opções de correção (menor alteração, fail-closed)
1. link: no createCanonicalProduct, se candidate.link contém "affiliate" não
   faz sentido; melhor: passar affiliateUrl na entrada do evaluate (campo
   extra) e usar candidate.affiliateUrl || candidate.normalizedUrl.
   → exige tocar normalizeCandidate (aceitar affiliateUrl?) OU tocar apenas
   productPipeline.createProductionProductPipeline + evaluate input.
   Mais simples: no confirm_pub (telegramBot), já que lá monta o evaluate,
   NÃO tocar; o link deve vir do adapter: mudar createCanonicalProduct para
   link: candidate.normalizedUrl (mantém contrato) e adicionar passo:
   o bot confirm_pub pode pré-normalizar review.affiliateUrl no candidato.
   DECISÃO PROPONDO: adicionar campo `affiliateLink` ao candidate? NÃO —
   mudar contrato. Alternativa mínima: no createCanonicalProduct,
   link = candidate.normalizedUrl mantém; a correção certa é no bot:
   ao montar evaluate, passar { link: review.affiliateUrl || review.normalizedUrl }
   e normalizeCandidate usa input.link como fallback. Isso preserva contrato
   (normalizeCandidate já aceita link) e o pipeline continua canônico.
2. descricao: filtrar proveniência raw antes do evaluate (no /publicar e
   persistPreviewReview mantem raw para auditoria):
   stripProvenanceMetadata(descricao) → "" no payload público.
   OU: fazer containsRawPayloadMarkers reconhecer "affiliate_preview ·".
   Melhor: função dedicada stripRawProvenance no productLifecycle (local,
   determinística, documentada), chamada no normalizeCandidate.
3. Front (client): verificar render do bloco "ESPECIFICAÇÕES DA PEÇA" — se
   usa product.descricao raw, a correção backend já resolve; ainda assim
   revisar o badge AFFILIATE_PREVIEW (tag pode ser gerada do ref/slug?).

### Preço do produto publicado: 97 (input manual do usuário via Telegram) ✓
### Affiliate link oficial no texto publicado: https://s.shopee.com.br/40ftCq9rTu ✓ (proveniência)

## PLANO DE CORREÇÃO CONSOLIDADO (após auditoria completa)

### Causa raiz dos 2 problemas
1. BADGE "AFFILIATE_PREVIEW": renderização do campo `categoria` (ProductDetail linha 266-268).
   A categoria de toda review affiliate é fixa: "affiliate_preview" (shopeeCommand linha 636).
   → Correção: usar categoria humana legível na exibição: manter storage "affiliate_preview"
   (usado pelo bot p/ decisões), mas na publicação mapear para categoria pública
   (ex.: review.categoria → "Casa & Cozinha"? NÃO inventar categoria — usar
   "Afiliado Shopee" OU deixar categoria pública vazia? Decisão: mapear
   "affiliate_preview" → categoria display "Afiliado" no publish (pipeline),
   sem alterar contratos; categoria do candidate continua a da review).
   MAIS SIMPLES e fiel: mudar no createProductionProductPipeline:
   categoria: mapPublicCategory(candidate.categoria).
2. BLOCO "ESPECIFICAÇÕES DA PEÇA": description public = review.descricao raw.
   → containsRawPayloadMarkers não reconhece "affiliate_preview ·".
   Correção mínima: adicionar markers "affiliate_preview", "link oficial retornado",
   "enriquecimento scraper", "auditoria identidade" ao RAW_PAYLOAD_MARKERS?
   Risco: silencia qualquer descricao legítima com essas palavras.
   MELHOR: função dedicada `stripRawAffiliateProvenance` no productLifecycle
   (determinística, documentada, somente prefixo "affiliate_preview ·") chamada
   no normalizeCandidate: se descricao inicia com "affiliate_preview ·" → "".
   Mantém storage raw no PendingReview (auditoria) e no lifecycle candidate
   description fica vazio → descricao publica vazia → bloco some do site.
3. LINK DO SITE = URL pública original:
   productPipeline linha ~222: link: candidate.normalizedUrl.
   Correção: no confirm_pub (telegramBot linha ~1147), passar
   link: review.existingProduct?.affiliateUrl || review.normalizedUrl
   (review.existingProduct.affiliateUrl já é salvo pelo shopeeCommand!)
   normalizeCandidate usa input.link como fallback → candidate.normalizedUrl = affiliate.
   pipeline.createProductionProductPipeline continua link: candidate.normalizedUrl.
   Sem tocar contrato do pipeline.

### Pontos exatos de alteração
A. server/services/telegramBot.ts (confirm_pub, ~linha 1147):
   - descricao: stripRawAffiliateProvenance(review.descricao)  [importar]
   - link (novo campo do evaluate): review.existingProduct?.affiliateUrl || review.normalizedUrl
   → Sem isso, affiliate só usado em "AUDITORIA" interna.
B. server/services/productLifecycle.ts:
   - novo const RAW_AFFILIATE_PROVENANCE_PREFIX = "affiliate_preview"
   - export stripRawAffiliateProvenance(desc): se desc?.trimStart().startsWith(prefix) → ""
   - normalizeCandidate: descricao: stripRawAffiliateProvenance(rawDescription) (antes do containsRawPayloadMarkers)
C. server/services/productPipeline.ts (~linha 219 createProductionProductPipeline):
   - categoria: publicCategoryMapping(candidate.categoria) → "affiliate_preview" → "Afiliado"
   (ou manter: categoria pública = mesma; alternativa: não mudar categoria e
   corrigir só o front... front usa product.categoria; decisão: mapear para
   "Afiliado" no publish, storage unchanged.)
D. (opcional front) src/components/ProductDetail.tsx linha 266-268: manter.
E. Tests: atualizar/criar testes para stripRawAffiliateProvenance, e o
   publishCommand.test.ts continua com descricao do fake controlada.

### Regras de governança mantidas
- Preços continuam escala não verificada; proveniência preservada no registro
  (PendingReview data + lifecycle) — apenas separação apresentação pública.
- Nenhum valor inventado; affiliateUrl é a autoridade oficial (Affiliate API).
- Não alterar N14/N15/thresholds.

## CHECKPOINT 4 — CORREÇÃO DA PUBLICAÇÃO IMPLEMENTADA (local, ainda NÃO commitada)

### Alterações feitas
1. server/services/telegramBot.ts (confirm_pub, ~linha 1146-1160):
   - affiliateLink = review.existingProduct?.affiliateUrl || ""
   - evaluate recebe link: affiliateLink || review.normalizedUrl
   - descricao: stripRawAffiliateProvenance(review.descricao)
   - import stripRawAffiliateProvenance de ./productLifecycle (linha 12)
2. server/services/productLifecycle.ts:
   - stripRawAffiliateProvenance: "" se descricao inicia com "affiliate_preview" (case-insensitive); senão preserva intacta
   - publicCategoryMapping: affiliate_preview → "Afiliado" (storage interno unchanged)
   - normalizeCandidate usa ambas (descricao + categoria)
3. tests/publishCommand.test.ts: +2 testes
   - confirm_pub publica com affiliate link oficial + descricao limpa + categoria "Afiliado"
   - descricao legítima preservada intacta

### Falta fazer
- npm test (esperar 1497/1497) · tsc OK (já passou) · build · git diff --check · secret scan
- Entrega relatório A-J para autorização (formato copyable, sem tabelas)
- Após autorização: commit isolado + push + deploy + VALIDAR PRODUTO EXISTENTE
  (prod-1787286088338 tem link/descricao/categoria ERRADOS → corrigir via UPDATE
  SQL no Supabase? OU republicar? Decisão: corrigir o registro existente via
  produto existente: UPDATE products SET link=affiliate url, descricao='', categoria
  via API administrativa? Melhor: corrigir diretamente no Supabase o produto da
  prova (mesmo produto da screenshot) — link → https://s.shopee.com.br/40ftCq9rTu,
  descricao → '', categoria → 'Afiliado'. Perguntar/autorizar separadamente?
  Incluir no relatório como cleanup da prova.
- SHA atual de produção: d242e0a; commit anterior: e866564 (commit2), 308a5ac (commit1 correção preview)
- URL produção: https://cerberus-forge-deploy-backend.onrender.com
- /health na RAIZ (não /api/health): retorna {status, service, version=SHA}

### Contexto importante do produto de prova
prod-1787286088338: ref REF-015, preco 97 (manual user), link atual = shopee.com.br/product/1530442944/23794344926
(NEED FIX → s.shopee.com.br/40ftCq9rTu), descricao raw (NEED FIX → ''), categoria
"affiliate_preview" (NEED FIX → "Afiliado"), status published, ativo presumably true.
O catálogo estático public/data/products.json é regenerado no build (generate-static-catalog.js
lê do Supabase com syncCatalogAndDeploy) → após corrigir o registro + retrigger
sync (o site serve produtos.json estático!) → necessário re-executar syncCatalogAndDeploy
ou re-deploy após correção. Produto corrigido no DB não aparece no site até novo sync/deploy.

### Nota sobre sync do catálogo
O site em produção serve public/data/products.json (gerado no BUILD).
Deploy na Render regenera (build script roda generate-static-catalog.js).
Portanto: corrigir registro no Supabase + novo deploy → site atualizado.
Alternativa: API admin /api/admin/sync? (verificar catalogSync rotas).
