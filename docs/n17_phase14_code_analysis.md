# Fase 14 — Análise do código real do N14 (arquivo/função/condição)

## Contrato (`server/commercial/commercialBrain/contract.ts`)

- `SIGNAL_CATEGORIES` (linha ~90): `price`, `commission`, `availability`, `market`, `seller`, `competition` — 6 dimensões.
- `SIGNAL_STATUSES`: `KNOWN`, `UNKNOWN`, `CONFLICT`.
- `CommercialSignal`: `value: number | null` (null = UNKNOWN), `status`, `source`, `observedAt`, `provenance`, `currency`, `priceRange` (apenas price).
- `MIN_DIMENSIONS_KNOWN = 2` (linha ~193) — condição exata do gate.
- `SCORE_MIN/MAX = 0/1`; `BAND_HIGH_MIN = 0.75`; `BAND_LOW_MAX = 0.4`.
- Currencies: `BRL`, `USD`, `EUR`, `UNKNOWN`.

## Motor (`server/commercial/commercialBrain/engine.ts`)

- `scoreComponents` (~linha 240): KNOWN = `status === "KNOWN" && normalizedValue !== null && !conflictDimensions`; UNKNOWN são EXCLUÍDOS (não valem 0). `dimensionsKnown` = contagem de KNOWN sobre 6 dimensões; `coverage = dimensionsKnown / 6`.
- `buildBand` (linha ~302): a CONDIÇÃO BOOLEANA EXATA de SUFFICIENT é:
  ```
  if (components.dimensionsKnown < MIN_DIMENSIONS_KNOWN) return INSUFFICIENT
  ```
  Ou seja: `dimensionsKnown >= 2` E sem conflito/penalty que expulsa dimensões → score real → band HIGH/MEDIUM/LOW.
- `detectConflicts` (linha ~145): conflitos canônicos: sellerZero && marketKnown; availabilityOutOfStock && marketKnown.
- `computeRiskFactors` (linha ~166): penalty 10% por fator, piso 0.5; fatores: conflitos, dimensões sem provenance, sinais >90 dias, fatores adicionais.
- Normalizações: price (faixa da categoria se existente; absoluta 0–20M senão), commission (fração direta), availability (0/1), seller (rating/5), market (log10(1+v)/8 saturado 1), competition (1/(1+v), weight v1 = 0).
- `getDimensionWeights` (weights registry): competition v1 weight = 0 → competition KNOWN não conta para coverage/score, mas continua exigindo evidência para ser KNOWN.

## Conclusão da condição exata

Para sair de INSUFFICIENT, o N14 precisa de 2+ dimensões KNOWN com provenance rastreável entre: price, commission, availability, market, seller (competition com peso 0 não ajuda).
Não há bug de implementação vs. contrato: a implementação reflete o contrato (UNKNOWN≠0, exclusão de conflitantes, penalty visível).

## Fontes existentes já mapeadas (Fases 10–13)

- Affiliate productOfferV2: price=STRING sem unidade/moeda/escala comprovadas → não pode ser KNOWN. availability/commission/market/competition sem contrato verificável → UNKNOWN/NOT_AVAILABLE.
- Seller/Open API v2 (get_item_base_info): price_info.currency/original_price/current_price, stock_info_v2.total_available_stock — oficial, mas exige access_token Seller da loja correspondente; SEM adapter, OAuth ou prova de vínculo com o mesmo source_shop_id/source_product_id no ambiente; sem contrato para commission/market/competition.
- N2/N3 discovery/research Shopee: não transporta 2 dimensões comerciais KNOWN; rating/availability observados não existem em candidatos Shopee reais.
- Catálogo products: preço canônico ML; produtos Shopee não têm preço KNOWN com provenance suficiente.
- Evidence/observations tables: observações de preço e disponibilidade Shopee existentes foram consultadas; nenhuma com proveniência suficiente para KNOWN no N14.

## Caminhos legítimos restantes (a decidir)

1. Se o parser/adapter do Affiliate estiver descartando campos REAIS já retornados e normalizáveis (ex.: price string se houver contrato), normalizar no ponto correto.
2. Se o contrato local definir regras UNKNOWN/NOT_AVAILABLE que o service não está aplicando, corrigir implementação (prompt item 5).
3. Se não houver dado legítimo, reportar: arquivo=engine.ts linha 308 + contract.ts linha 193; função=buildBand/scoreComponents; condição=dimensionsKnown < 2; dados ausentes=2 dimensões KNOWN com provenance; alteração mínima=adapter Seller/Open API com OAuth + vínculo de identidade ou contrato Affiliate com semântica de price; autorizável=SOMENTE com access_token Seller da mesma loja e autorização explícita.

## Estado atual (linha de base)

- Runtime Render: SHA cf7225e6cd1d37f64ab164a56ffa65a66ce1fefe, health 200.
- Baseline Supabase: products=14; candidates/evidence/assessment/affiliate_links/job_queue/publication_executions/commercial_cycles=0.
- Provider: affprv-shopee=ACTIVE, provenance=admin:manual.
- Gates base: 1407/1407 testes; tsc; build; diff-check todos PASS.

## Service N14 (`server/commercial/commercialBrain/service.ts`)

A função `deriveSignalsFromCandidate` (linha ~114) deriva apenas três dimensões diretamente do candidato: `price` (candidate.observed_price number), `seller` (candidate.observed_rating + observed_rating_count) e `availability` (candidate.observed_availability IN_STOCK/OUT_OF_STOCK). Todas herdando provenance do metadata.provenance canônico (com fallback metadata.source legacado). Commission, market e competition exigem evidência comercial real e proveniente (provider afiliado/API oficial) — nunca derivadas do candidato.

O merge de sinais permite overrides via `normalizeOverrides` (signalsInput externo), ou seja, sinais de evidência externa podem ser injetados na avaliação. Os fatores de risco adicionam `unprovenanced_dimension:X` para qualquer dimensão KNOWN sem provenance.

## Síntese do ponto de correção (Fase 14)

1. O código real não apresenta bug em relação ao contrato: UNKNOWN≠0, exclusão de conflitantes, penalty visível e band INSUFFICIENT com coverage<2 estão implementados como especificado.
2. A saída de INSUFFICIENT para Shopee é causada por DADOS: o funil N2/N3/adapter Shopee não preenche observed_price/observed_availability/observed_rating (price string sem unidade no Affiliate; seller/availability ausentes), então as 3 dimensões derivadas ficam UNKNOWN e commission/market/competition sem evidência → dimensionsKnown=0 < MIN_DIMENSIONS_KNOWN=2.
3. A dimensão mais barata de resolver no código existente é a combinação price + availability ou price + seller, mas ambas exigem EVIDÊNCIA REAL (price numeric BRL com provenance; availability observada; rating do seller). Nenhuma delas existe hoje para Shopee sem inferência.
4. Se o adapter/research real observasse availability (ex.: campo real da resposta) e o parser promovesse price com unidade comprovada, o mínimo de 2 dimensões seria atingido SEM alterar policy/pesos/thresholds — alteração apenas no ponto de ingestão (adapter/parser), preservando UNKNOWN no restante.
5. Alteração mínima proposta (se implementável com contrato): normalizar price string p/ number com currency/escala COMPROVADA + transportar availability observada real do response ao candidato. Caso contrário: bloqueio exato permanece em engine.ts:308 (buildBand) alimentado por dados ausentes mapeados acima.

## Linha exata do bloqueio (contrato — sem bug)

`server/commercial/commercialBrain/contract.ts:193` — `MIN_DIMENSIONS_KNOWN = 2` com `coverage` = fração de dimensões KNOWN. Para Shopee hoje: price (string sem unidade comprovada → UNKNOWN), availability/seller (funil não preenche) → UNKNOWN, commission/market/competition sem evidência → UNKNOWN. dimensionsKnown = 0 < 2 → band INSUFFICIENT em `engine.ts` (buildBand). O contrato e a implementação são CONSISTENTES; o dado ausente é price numérico BRL com provenance + availability observada real (ou seller rating real).

## Menor alteração autorizável

Somente no ponto de ingestão (adapter Shopee/Evidence Bridge): transportar availability real observada (se o response a contém com semântica comprovada) e normalizar price string→number COM currency/escala comprovada. Política N14, pesos, thresholds e N15 permanecem intactos. Se a semântica continuar não comprovada, permanece UNKNOWN por projeto (fail-closed) e o bloqueio persiste com causa objetiva.
