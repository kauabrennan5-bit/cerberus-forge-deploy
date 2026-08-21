# N17 Fase 20 — Design técnico do elo Evidence Bridge → N14 (AUTORIZADO, pré-implementação)

PROOF_RUN_ID (fase 20): N17_PHASE20_EVIDENCE_BRIDGE_N14_20260820
Autorização do usuário: criar SOMENTE o elo mínimo candidate_evidence → N14, conforme 12 regras obrigatórias no Pasted_content_100.txt.

## Fatos contratuais confirmados (auditoria local)

1. **candidate_evidence** (server/repositories/candidateEvidenceRepository.ts):
   - `listCandidateEvidence(candidateId)` → { ok, reason?, evidence: EvidenceRecord[] } (limit 200, todas evidências)
   - `listFieldEvidence(candidateId, fieldName)` → { ok, reason?, evidence: EvidenceRecord[] }
   - EvidenceRecord: evidence_id, candidate_id, research_id, kind, field_name, field_value (Record<string,unknown>|null), field_state, source_url, source_type, collection_method, observed_at, evidence_hash, field_hash, quality, unit, evidence_note, metadata, created_at
   - Persistência pelo research: `field_value: { value, unknown }` (adapter price KNOWN salva value=number; UNKNOWN vira {value:null, unknown:true})
   - Provenance oficial gravada em `source_type="api"`, `collection_method="API"`, `evidence_note`, e `metadata` (http_status, endpoint=affiliate_graphql, operation=productOfferV2, discovery_block=N3). NÃO existe coluna root `provenance` na tabela.
   - `deleteEvidenceForProof` = cleanup administrativo; bridge NÃO escreve nada.

2. **N14 signals** (server/commercial/commercialBrain/contract.ts + normalizers.ts):
   - `CommercialSignalsInput`: price/commission/availability/market/seller/competition, cada um `Omit<CommercialSignal,"category"> | null`
   - `CommercialSignal`: value, reviewCount?, status (KNOWN/UNKNOWN/CONFLICT), source (string legível ex. "evidence:evi-..."), observedAt?, provenance (string), currency (BRL|USD|EUR|UNKNOWN), note?, priceRange?
   - `normalizePrice`: value number in [PRICE_MIN=0, PRICE_MAX=20.000.000] OK; provenanceValid → null = signal UNKNOWN mesmo com value OK ("price_without_provenance" / "price_unknown_value"). currency default UNKNOWN aceito. status conhecido + numberOk null → UNKNOWN.
   - `normalizeSignalsInput` combina por override com `...normalizeOverrides(signalsInput)` (evaluateCommercialBrain linha ~198: `{...deriveSignalsFromCandidate(candidate), ...normalizeOverrides(signalsInput ?? {})}`).
   - engine `dimensionsKnown` = dimensões com status===KNOWN && normalizedValue!==null && sem conflito. MIN_DIMENSIONS_KNOWN=2 (intocado).
   - Evidence refs: N14 persiste `evidenceRefs: []` (não populado).

3. **Adapter Shopee** (sources/shopee/adapter.ts):
   - Preço KNOWN: value=number (priceMinorUnits retornado pelo cliente/parser), state=KNOWN, quality=UNKNOWN, unit="string_price_unscaled", note="OBSERVED_STRING_PRICE_SHAPE; SCALE_UNVERIFIED_CONTRACT_UNSPECIFIED"
   - Title: state=KNOWN, quality=HIGH (não é dimensão comercial N14 — não transportar como dimensão)
   - Demais: UNKNOWN.

4. **Regras obrigatórias da Fase 20** (resumo):
   - Permitido: localizar evidências do candidate avaliado; selecionar elegíveis; transformar em sinais; preservar source/provenance/evidence_id/observed_at/metadados; auditoria no assessment.
   - Proibido: contract.ts/engine.ts/weights/thresholds/N13/N15/N16/N17/N8/N6/schema/catálogo/scheduler/Telegram/credenciais. Não criar sinais novos. Não promover UNKNOWN→KNOWN. Price preserva unit/quality/note/UNVERIFIED; NÃO converter minor_units; NÃO assumir BRL. Title não vira dimensão. availability/commission/competition/market UNKNOWN/BLOCKED sem evidência elegível. Identidade exata do candidate_id (sem cross-market). Falha de leitura → UNKNOWN/INSUFFICIENT. Duplicatas: usar regra existente, senão UNKNOWN+registrar ambiguidade. Persistência read-only (sem criar/modificar evidências/candidates). N14: não alterar score/threshold/classificação; só transportar dados. Sem N15/N17/N8/N6/aquisição.
   - Testes A–H exigidos. Gates completos. SEM commit/push/deploy; entregar relatório pré-commit.

## Design do elo mínimo

Novo módulo: `server/commercial/commercialBrain/evidenceSignals.ts` (SOMENTE leitura, sem dependência Supabase além do repositório já existente):
```ts
export interface EvidenceSignal {
  signal: CommercialSignalsInput;      // sinais transportados (price/seller/availability se elegíveis)
  evidenceIds: string[];               // ids das evidências usadas (auditoria)
  ambiguousFields: string[];           // campos com múltiplas evidências KNOWN → nenhum sinal
  readFailure: boolean;                // falha de leitura → nenhum sinal (fail-closed)
}
export async function resolveEvidenceSignals(
  candidateId: string,
  opts: { listCandidateEvidence?: typeof listCandidateEvidence }
): Promise<EvidenceSignal>
```
Regras de seleção (fail-closed):
- kind==="FIELD" e field_state==="KNOWN" e value numérico (price) → preço sinal;
- seller/availability: só se o N3/servidor persistiu field_state KNOWN com value próprio (seller rating number; availability IN_STOCK/OUT_OF_STOCK no metadata.unit ou field_value) — na prática o N3 atual só cria KNOWN para title/price; availability permanece UNKNOWN → permanece UNKNOWN no N14.
- price: value do field_value {value:number}; status="KNOWN"; source=`evidence:<evidence_id>`; provenance=provenance oficial derivada do metadata (endpoint+operation+marketplace → "n14:affiliate:shopee:productOfferV2") ou evidence_note; observedAt=evidence.observed_at; currency=UNKNOWN (NÃO assumir BRL); note=evidence_note (contém SCALE_UNVERIFIED).
- Título: NÃO transportar como dimensão (H).
- Múltiplas evidências KNOWN para o mesmo campo → ambiguousFields (nenhum sinal, sem regra nova de precedência).
- Erro/ok=false do repositório → readFailure=true, signal vazio (N14 permanece como hoje).
- Evidência de outro candidate_id: listCandidateEvidence já filtra por candidate_id (Filtro SQL eq candidate_id) → regra 7 satisfeita.

Integração em `evaluateCommercialBrain` (service.ts ~196):
- Após gate N13, chamar `resolveEvidenceSignals(candidateId)`; mesclar `...normalizeOverrides(signalsInput ?? {})` JÁ aplicado; inserir evidência signals POR ÚLTIMO? NÃO: a rota `/api/commercial/commercial-brain/evaluate` aceita overrides explícitos (signalsInput) que devem ter precedência sobre derivação de candidato? Atualmente candidate vem primeiro e override depois. Evidências oficiais devem ter precedência sobre candidate_derived (provenance oficial); overrides administrativos manuais continuam por cima. Ordem: deriveCandidate < evidenceSignals < explicitOverride.
- Populair `evidenceRefs` no persistAssessment com evidenceIds (auditoria da origem) — NÃO altera score/threshold.

## Testes A–H (novo arquivo tests/commercialBrainEvidenceSignals.test.ts)
A. field price KNOWN → signal price KNOWN no N14 (mock listCandidateEvidence)
B. price preserva unit string_price_unscaled, quality UNKNOWN, UNVERIFIED no note
C. evidência de outro candidate_id → ignorada (mock retorna registro de outro id → não transportado)
D. evidência UNKNOWN → não promovida
E. ausência (lista vazia) → comportamento atual (signals vazio, UNKNOWN)
F. erro de leitura → readFailure, nenhum sinal inventado
G. múltiplas evidências ambíguas (2 KNOWN para price) → nenhum sinal + ambiguousFields
H. title KNOWN → não aparece como dimensão comercial
+ integração: evaluateCommercialBrain com mock retorna band/rationale com price KNOWN via evidence; evidenceRefs populado no snapshot? (snapshot input não muda; persiste evidenceRefs)

## Injeção de dependência
`setEvidenceListClientForTests`-like: resolverEvidenceSignals aceita injetar listCandidateEvidence; production usa a real (set via `setCandidateEvidenceClientForTests` padrão do repo).

## Status
- Fase 19 (relatório anterior): N14 INSUFFICIENT confirmado em produção (SHA 57e7624); bloqueio = N14 não consome candidate_evidence.
- Esta fase: implementação local; entrega relatório; AGUARDAR autorização de commit/push/deploy.
- Cleanup do candidato de prova (can-044a25b735cb3c468b36cdce) e revogação da Render key pendentes.
