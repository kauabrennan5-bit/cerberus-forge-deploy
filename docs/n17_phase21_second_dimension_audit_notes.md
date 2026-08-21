# N17 — Nova Fase — Auditoria da 2ª Dimensão Comercial (notas internas)

## 1. Superfícies oficiais auditadas (local)

### A) Selection set real do `productOfferV2` (shopeeApiClient.ts, linha 198)
```
{ productOfferV2(itemId, shopId, limit:1) { nodes { itemId shopId productName price productLink offerLink } } }
```
Campos disponíveis no nó da oferta solicitados ao contrato GraphQL oficial:
- `itemId` (identidade)
- `shopId` (identidade)
- `productName` (title — transportado como evidência KNOWN, mas title NÃO é dimensão comercial do N14)
- `price` (string real → KNOWN via evidenceSignals.ts, quality UNKNOWN, unit string_price_unscaled, scale UNVERIFIED)
- `productLink` (URL, não é dimensão)
- `offerLink` (URL de afiliado, usada apenas na aquisição N8; não é dimensão comercial N14)

**Conclusão parcial A**: do selection set atual, ÚNICA dimensão comercial N14 elegível = price. offerLink NÃO é dimensão do N14 (é a própria aquisição N8). productName/title é excluído por design (regra do usuário: "title não deve ser usado como dimensão comercial").

### B) Campos adicionalmente solicitados na Fase 14 (probe read-only)
O probe da Fase 14 expandiu o selection set para incluir `stockInfo, seller, sellerId, sellerName, sellerRating` — TODOS rejeitados pela policy oficial 10010 (categoria D: campo rejeitado pela policy 10010). A Fase 14 também registrou os campos NÃO bloqueados: campos do nó que não são price/productName (ex.: itemId/shopId/productLink/offerLink — identidade/URLs, não dimensões).

### C) Adapter (adapter.ts + contracts.ts)
- `SHOPEE_EVIDENCE_FIELD_NAMES` = [title, price, images, seller, rating, review_count, availability, category] — 8 campos cobertos pelo contrato de evidência.
- `fieldValueFor`: title → KNOWN se non-empty; price → KNOWN se number finito (string decimal pura via parseShopeePriceString). Todos os demais → UNKNOWN (result não possui os dados).
- `buildOfficialShopeeEvidencePayload` transporta: title (name), price (priceMinorUnits), seller=null, availability=null, images=null, rating=null, review_count=null, category=null.
- O resultado do client (`ShopeeProductLookupResult`) contém APENAS: shopId, itemId, name, priceMinorUnits, productLink — ou seja, o que o selection set fornece.

### D) Evidence Bridge (evidenceSignals.ts)
- `TRANSPORTABLE_FIELDS = [price, seller, availability]` — os 3 únicos que seriam transportados se houvesse evidência KNOWN.
- price já transportado (evidência única real). seller/availability: nenhuma evidência KNOWN existe (adapter registra UNKNOWN porque o nó não possui esses dados).
- Regra: qualidade (HIGH/UNKNOWN) NÃO é critério de elegibilidade — o que bloqueia é field_state.

### E) Signal derivation do N14 (service.ts)
- `deriveSignalsFromCandidate`: observed_price, observed_rating, observed_availability do registro candidate (sempre null para fonte api → UNKNOWN).
- Fase 20 integrou `resolveEvidenceSignals` + `evidenceRefs` populados. Nada mais.

## 2. Classificação preliminar das dimensões prioritárias (conforme prompt)

| Dimensão | Categoria | Base |
| --- | --- | --- |
| availability | D/E (não existe no selection set; nunca observado; sem contrato oficial — Fases 20/21: BLOCKED — CONTRACT UNSPECIFIED) | Fase 21 audit |
| seller | D (existiu no selection set expandido da Fase 14; rejeitado pela policy 10010) | Fase 14 probe |
| commission | E (não comprovado existir; Fase 22: BLOCKED — CONTRACT UNSPECIFIED) | Fase 22 audit |
| market | E (não comprovado; Fase 24: BLOCKED — CONTRACT UNSPECIFIED) | Fase 24 audit |
| competition | E (não comprovado; Fase 23: BLOCKED — CONTRACT UNSPECIFIED) | Fase 23 audit |
| offerLink (bônus) | A (retornado e verificado, mas é a aquisição N8, não dimensão N14) | Fase 15 |

## 3. Verificações de transporte não utilizado (prompt: "dimensão que o N14 já considera KNOWN por definição mas não transportada")
- title: KNOWN no evidence, deliberadamente EXCLUÍDO do bridge (regra explícita).
- productLink/offerLink: URLs, não mapeadas para nenhum sinal do N14 (sem dimensão correspondente no contract.ts).
- identity (itemId/shopId): usada pelo N14? Verificar se candidate_identity/evidence de identidade conta como dimensão. O N14 não tem dimensão "identity". O identity check é pré-condição do N13 (evidence identity OK) — já satisfeita, mas não é dimensão comercial.
- rating/review_count: KNOWN apenas se o scraper do N3 retornasse (fail-soft: N3 scraper não preenche). Fonte oficial não oferece.
- category: não é dimensão do N14.

## 4. Decisão sobre a prova read-only real (Fase 3)
Único candidato a prova: expandir o selection set na mesma operação oficial (sem nova operação GraphQL — apenas campo adicional no mesmo selection set) para confirmar shape de campos já não bloqueados (ex.: verificar se há campo adicional não tentado). MAS: a Fase 14 já provou que os únicos campos adicionais tentados são 10010-blocked. Campos nunca tentados no selection set não têm contrato comprovado → adicionar seria inventar nome de campo (proibido: "Não criar endpoint... não invente nomes"; regra 5: não endpoint alternativo — mas expandir selection set do MESMO operation é "inspeção read-only" autorizada na Fase 14? A Fase 14 já permitiu expansão read-only uma vez).
- Risco: criar qualquer field novo sem contrato oficial oficializado = E.
- Conclusão provável: não executar prova nova; reportar SECOND_DIMENSION=NOT_AVAILABLE com a matriz.

## 5. Dados confirmatórios da Fase 14 (runtime autenticado)
- 25 campos extras testados por bissection (incluindo mapeamento oficial de discovery e `__fakeField`): TODOS rejeitados com código oficial 10010 (FORBIDDEN).
- Conclusão contratual observada: policy GLOBAL da plataforma bloqueia qualquer campo além do mapeamento oficial de 6 campos (itemId, shopId, productName, price, productLink, offerLink), independentemente do nome. Não existe seleção estendida autorizada para apps afiliadas.
- Campos observados do nó: itemId=number, shopId=number, productName=string(non-empty), price=string(non-empty), productLink=string(url-like), offerLink=string(url-like). currency NÃO retornado (inexistente no selection set autorizado).

## 6. Decisão sobre nova prova read-only (Fase 3 do plano)
NÃO executar nova prova. Motivo: a Fase 14 já executou a expansão máxima legítima do selection set (25 campos extras testados via bissection, em runtime autenticado com credenciais reais), e todos os campos extras falharam com 10010. Nenhum campo adicional jamais tentado possui candidatura razoável: o mapeamento oficial de discovery foi coberto, e a policy é global (um campo inventado recebeu o MESMO erro — qualquer campo novo seria rejeitado).

## 7. Matriz final A–E

| field | API/operation | real_observed | identity_confirmed | official_contract | policy_status | same_item_proven | safe_for_N14 | category | reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| availability | productOfferV2 | false | — | — | não existe no selection set; nunca observado | — | NO | D/E | não existe no mapeamento oficial de 6 campos; Fase 21: BLOCKED — CONTRACT UNSPECIFIED |
| seller | productOfferV2 | false | — | — | 10010 FORBIDDEN (Fase 14 bissection: stockInfo, seller, sellerId, sellerName, sellerRating rejeitados) | — | NO | D | policy global bloqueia |
| commission | productOfferV2 | false | — | — | não existe no selection set; Fase 22: BLOCKED — CONTRACT UNSPECIFIED | — | NO | E | sem contrato comprovado |
| market | productOfferV2 | false | — | — | não existe no selection set; Fase 24: BLOCKED — CONTRACT UNSPECIFIED | — | NO | E | sem contrato comprovado |
| competition | productOfferV2 | false | — | — | não existe no selection set; Fase 23: BLOCKED — CONTRACT UNSPECIFIED | — | NO | E | sem contrato comprovado |
| offerLink | productOfferV2 | true (string url-like) | true (Fase 14) | A — mapeamento oficial | permitido | yes (mesmo nó) | NO (não é dimensão N14; é a aquisição N8) | A | é a própria operação de aquisição N17/N8, não dimensão comercial |
| productName | productOfferV2 | true | true | A | permitido | yes | NO (excluído por design — não é dimensão comercial N14) | A | title é evidência de identidade/curadoria, não dimensão |
| price | productOfferV2 | true | true | A | permitido | yes | YES (única) | A | já transportada pela Fase 20 |

## 8. Verificação de transporte não utilizado (segunda parte do prompt)
- title: KNOWN na evidência, deliberadamente NÃO transportado (regra explícita do usuário — "title não deve ser usado como dimensão comercial").
- productLink/offerLink: URLs sem dimensão correspondente em CommercialSignalsInput.
- identity (itemId/shopId): verificação pré-N13, não é dimensão do N14.
- rating/review_count/category/images: sem evidência KNOWN possível da fonte oficial (adapter registra UNKNOWN; selection set não fornece).
- currency: não retornado pela API (inexistente no selection set autorizado) — currency do N14 permanece UNKNOWN, correto.
→ NÃO existe dimensão KNOWN legítima presa no Evidence Bridge sem transporte.

## 9. Dependência externa exata (se SECOND_DIMENSION=NOT_AVAILABLE)
Desbloquear N14 exige UMA dimensão comercial adicional com contrato oficial verificável para o mesmo (item_id, shop_id). Opções reais:
(a) Campo adicional na Affiliate API `productOfferV2` autorizado pela plataforma (ex.: disponibilidade/estoque) — hoje bloqueado por policy global 10010; dependeria de a Shopee liberar campos para afiliados (decisão da plataforma, não do projeto).
(b) Outra API Shopee oficial com vínculo de identidade comprovável para (item_id, shop_id) + contrato explícito dos campos (ex.: Seller API — exige conta seller própria com autorização; sem vínculo com a conta afiliada atual, o identity binding não é demonstrável).
Para desbloquear N14= SUFFICIENT é preciso UMA dimensão comercial adicional com contrato oficial Shopee verificável para o MESMO (item_id, shop_id), ex.:
- campo oficial de disponibilidade/estoque na Affiliate API (atualmente 10010-blocked para seller/stockInfo); ou
- documento contratual Shopee especificando semântica/scale do price string (converteria price em 2 dimensões? NÃO — continua 1 dimensão; apenas resolveria SCALE_UNVERIFIED).
