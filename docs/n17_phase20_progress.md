# Fase 20 — Progresso (pre-compactação)

## Implementação JÁ FEITA (arquivos alterados)
1. **server/commercial/commercialBrain/evidenceSignals.ts** (NOVO):
   - `resolveEvidenceSignals(candidateId, reader)` — reader injetável do tipo `EvidenceListReader` (ok/evidence).
   - EvidenceRow tipo mínimo (evidence_id, candidate_id, field_name, field_value{value,unknown}, field_state, quality, unit, evidence_note, observed_at, metadata).
   - Elegibilidade: field_state==="KNOWN" (quality NÃO é critério — price vem quality=UNKNOWN).
   - price: value number finito → signal KNOWN; source=`evidence:<evidence_id>`; provenance=`n14:evidence:affiliate:shopee:productOfferV2`; currency=UNKNOWN (nunca BRL); note=`unit=${unit};quality=${quality};${evidence_note}`.
   - seller: value number finito → KNOWN (N3 não persiste seller KNOWN hoje).
   - availability: só unit==="IN_STOCK" (1) ou "OUT_OF_STOCK" (0).
   - Múltiplas evidências KNOWN p/ mesmo campo → ambiguousFields, SEM sinal.
   - Erro leitura/candidate_id vazio → readFailure=true, sinais vazios (fail-closed).
   - Title NÃO transportado (não é dimensão comercial do N14).
2. **server/commercial/commercialBrain/service.ts** (MODIFICADO):
   - Import resolveEvidenceSignals + listCandidateEvidence.
   - Em evaluateCommercialBrain, após gate N13: resolveEvidenceSignals → normalizeOverrides(evidenceSignals) mesclado ENTRE deriveSignalsFromCandidate e override explícito da rota (precedência: derivado < evidência < override).
   - persistAssessment: `evidenceRefs: [...evidenceRefs]` (antes []).
   - metadata novo: evidenceSignalsTransported, evidenceRefsUsed, evidenceAmbiguousFields, evidenceSignalProvenance.

## Testes (pendente reescrita)
- File `tests/commercialBrainEvidenceBridgeN14.test.ts` criado mas INCOMPATÍVEL: usa jest (describe/it/expect) — repo usa `node:test` via `tsx --test tests/*.test.ts` (script npm test).
- Falha tsc: research_id não existe em EvidenceRow (remover do helper); jest globals inexistem.
- PRECISA reescrever com: `import { test } from "node:test"; import assert from "node:assert/strict";` e mocks manuais (spy via substituição — ver padrão em tests/commercialBrainN14.test.ts linha ~523: chama evaluateCommercialBrain(VALID_CANDIDATE_ID); para mockar getCandidate listCandidateAssessments persistAssessment precisa ver padrão de spy usado — linha 712 menciona "spy do mock: único efeito colateral permitido = insert". Provavelmente usa module patching. VER tests/commercialBrainN14.test.ts linhas 1-180 e 700-730 antes de reescrever.
- Cobertura A–H: A price KNOWN→sinal; B preserva unit/quality/UNVERIFIED; C outro candidate ignorado; D UNKNOWN não promovida; E ausência→comportamento atual; F erro leitura→fail-closed; G ambíguas→nenhum sinal; H title≠dimensão. + edges: value não numérico, availability unit desconhecida, id vazio; + integração evaluateCommercialBrain.

## Gates restantes
- npx tsc --noEmit (já OK antes dos testes; revalidar após reescrita)
- npm test (tsx --test)
- npm run build
- git diff --check
- secret scan (grep para SHOPEE_AFFILIATE_APP_ID/SECRET/rnd_ no diff)

## Entrega (Fase 4 do plano)
Relatório pré-commit aguardando autorização do usuário: arquivos alterados, diff resumido, testes, gates, como o bridge alimenta N14, confirmações (contract/engine/policy intocados; nada escrito no Supabase — tests usam mocks; N15/N17/N8/N6 não executados).
NÃO commitar/pushar/deployar ainda.

## Contexto pendente geral
- Cleanup do candidato de prova can-044a25b735cb3c468b36cdce (candidates=1, evidence=9, assessments=2) — após autorização.
- Revogar Render API key rnd_AQsUapT3Tsqr3U4kDx6WxFyo6CEQ.
- Deploy anterior SHA 57e7624 live; health OK.
- MCP Supabase project_id juiychcfdqxgnatffnla.
- Fluxo real a ser repetido pós-deploy: N2→N3→N13→N14→N15 com URL https://shopee.com.br/product/423833774/25690571694 via curl admin (x-admin-password) em https://cerberus-forge-deploy.onrender.com.
