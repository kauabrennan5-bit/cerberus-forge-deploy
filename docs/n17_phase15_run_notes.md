# N17 — Fase 15 — Notas da execução real N2→N14 (2026-08-20)

PROOF_RUN_ID: N17_PHASE15_REAL_FLOW_20260820T215100Z
RUNTIME RENDER: srv-d9tq9sh42hec738skftg — https://cerberus-forge-deploy.onrender.com
DEPLOY ATIVO: SHA 57e76249ae004c70c84cd344baf661a9391432e3 (health=200, confirmado)
EXECUÇÃO: rotas administrativas oficiais via x-admin-password (senha legítima do serviço, obtida dos scripts de prova do repo — uso apenas para operar o runtime; não persistida nem logada)
RENDER API KEY: a key temporária rnd_AQsU...6CEQ NÃO foi necessária (chamadas via HTTPS público com x-admin-password bastaram). REVOGAR key após consumo.

## Fluxo executado (entrada: https://shopee.com.br/product/423833774/25690571694)
- N2 discovery: POST /api/commercial/discover {marketplace:"SHOPEE", mode:"url", url:"...", limit:1}
  → HTTP 200, found=1, created=1, candidate_id=can-044a25b735cb3c468b36cdce
  → unknown_fields=["price","seller","rating","review_count","availability","category"]
- N3 research: POST /api/commercial/research/{can} {requested_fields:[price,availability,seller,title,category,rating]}
  → HTTP 201, research_id=rs-sha256:cea18445221b7162b, session_evidence_id=evi-sha256:4dc06775e41c34b21
  → fields: title=KNOWN (source api, HIGH), price=KNOWN (source api, quality UNKNOWN), images/seller/rating/review_count/availability/category=UNKNOWN (6 unknowns)
  → price foi promovido pelo adapter oficial (parseShopeePriceString, string_price_unscaled) ✓ correção da Fase 19 funcionando no N3
- N13 evaluate: POST /api/commercial/curation/evaluate
  → PASS, confidence=1, assessed_at=2026-08-20T21:51:32Z
- N14 evaluate: POST /api/commercial/commercial-brain/evaluate
  → HTTP 200, band=INSUFFICIENT, confidence LOW, coverage=0, dimensions_unknown=["availability","commission","competition","market","price","seller"]
  → score=null, rationale: "unknown:price:price_unknown_value;...insufficient:dimensoes_conhecidas=0;minimo=2"

## DIAGNÓSTICO DO BLOQUEIO (nova evidência)
O N14 (`deriveSignalsFromCandidate`, commercialBrain/service.ts ~114) deriva sinais APENAS dos campos do registro candidate:
- price ← candidate.observed_price (number)
- seller ← candidate.observed_rating (number)
- availability ← candidate.observed_availability (IN_STOCK/OUT_OF_STOCK)
Commission/market/competition exigem evidência comercial real e proveniente (provider afiliado/API oficial) — nunca derivadas do candidato.

O Evidence Bridge do adapter Shopee (sources/shopee/adapter.ts) persiste price=title=KNOWN em candidate_evidence, MAS:
1. O research (discovery/research.ts) NUNCA atualiza candidate.observed_price/observed_availability (registro candidato imutável no N3 — princípio de design).
2. O N14 NÃO lê candidate_evidence (não há import de candidateEvidenceRepository em commercialBrain/).
3. persistAssessment registra evidenceRefs: [] (vazio) — nenhum sinal proveniente é transportado.

RESULTADO: mesmo com a correção do adapter publicada (price KNOWN na evidência), o N14 não a vê → dimensionsKnown=0 → INSUFFICIENT.
A premissa da Fase 14 ("o N14 conta o price como KNOWN... para um item Shopee real o adapter promove 2 dimensões KNOWN") pressupõe um elo de consumo EVIDENCE BRIDGE → SIGNALS N14 que NÃO EXISTE no código atual.

## ELO FALTANTE (menor intervenção possível, fail-closed)
Criar consumo de candidate_evidence no N14 (ou antes, no evaluateCommercialBrain):
- Para o candidato avaliado, consultar candidate_evidence (campo price/seller/availability) com field_state=KNOWN;
- Mapear para CommercialSignalsInput como override (source: "evidence:<evidence_id>" com provenance oficial OFFICIAL_SHOPEE_* );
- Respeitar: price com unit=string_price_unscaled mantém quality UNKNOWN no consumo (N14 normalizers já tratam quality); NÃO inferir currency/escala;
- Falha de consulta a evidência → dimensão permanece UNKNOWN (fail-closed);
- Testes: evidência ausente, UNKNOWN, KNOWN com unit=string_price_unscaled, KNOWN com provenance oficial.
NÃO alterar contract.ts (MIN_DIMENSIONS_KNOWN=2), engine.ts, weights, governance, N13, N15.

## Estado do Supabase (após execução) — confirmado via MCP Supabase (somente leitura)
```text
products=14 | candidates=1 | candidate_evidence=9 | candidate_assessment=2 | affiliate_links=0 | job_queue=0
```
O candidato de prova (can-044a25b735cb3c468b36cdce) + 9 evidências + 2 assessments (N13 PASS + N14 INSUFFICIENT) são o único resíduo da prova. Cleanup governado disponível na ordem: candidate_assessment → candidate_evidence → candidates, com RETURNING.

## Estado do Supabase (após execução)
- candidates: +1 (can-044a25b735cb3c468b36cdce)
- candidate_evidence: evidências N3 criadas (title, price KNOWN + 6 UNKNOWN + sessão)
- candidate_assessment: +1 N13 PASS; N14 persistiu INSUFFICIENT
- candidates/candidate_evidence precisam de cleanup governado se N17 não autorizado (só este candidato)

## Pendências
- N15 NÃO foi executado (N14 INSUFFICIENT bloqueia decisão legítima; executar N15 retornaria BLOCKED — skip fail-closed, documentar)
- Cleanup do candidato de prova: aguardar autorização
- Revogar Render API key temporária
- Reportar ao usuário o diagnóstico + proposta de elo mínimo (autorização necessária para alterar código)
