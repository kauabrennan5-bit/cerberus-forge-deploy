# N17 — Fase 20 — Elo Evidence Bridge → N14 (Pré-Commit)

**PROOF_RUN_ID:** `N17_PHASE20_EVIDENCE_BRIDGE_N14_20260820`
**STATUS:** `READY FOR PHASE 21` (aguardando autorização explícita de commit/push/deploy)
**Escopo da fase:** implementar somente o elo mínimo de transporte de evidências comerciais oficiais (`candidate_evidence`) para os sinais do Commercial Brain/N14, conforme as 12 regras obrigatórias autorizadas.

## 1. Diagnóstico que motivou a fase

A prova real da Fase 15 (deploy `57e7624`) confirmou que a normalização de `price` do adapter Shopee funciona corretamente no N3 — o preço oficial `productOfferV2` é persistido em `candidate_evidence` com `field_state=KNOWN`, `quality=UNKNOWN`, `unit=string_price_unscaled`. O N14, porém, retornou `INSUFFICIENT` com cobertura 0 porque `deriveSignalsFromCandidate` deriva sinais apenas de `observed_price`/`observed_rating`/`observed_availability` do registro `candidates`, e nenhum módulo transportava as evidências oficiais para essa camada. O elo estava especificado na intenção da Fase 14, mas ausente no código — a implementação desta fase fecha esse elo com a menor intervenção possível.

## 2. Implementação

A intervenção se limita a dois arquivos no módulo do Commercial Brain, sem tocar `contract.ts`, `engine.ts`, `weights`, thresholds, política N15, N13, N15, N16, N17, N8, N6, repositórios ou banco de dados.

| Arquivo | Natureza | Resumo |
|---|---|---|
| `server/commercial/commercialBrain/evidenceSignals.ts` | Novo (somente leitura) | `resolveEvidenceSignals(candidateId, reader)` — lê `candidate_evidence` do candidato avaliado e transporta evidências elegíveis para sinais comerciais. |
| `server/commercial/commercialBrain/service.ts` | Modificação mínima (+32 / −1 linha) | Invoca o bridge após o gate N13 e antes do merge de sinais; popular `evidenceRefs` e metadados de auditoria no `persistAssessment`. |

### Regras de transporte (todas fail-closed)

A elegibilidade considera exclusivamente `field_state === "KNOWN"` do registro de evidência — `quality` não é critério de elegibilidade, pois o preço oficial chega com `quality=UNKNOWN` justamente por causa da escala UNVERIFIED, e a regra 4 da autorização exige que essa bandeira seja preservada. Title é deliberadamente excluído do transporte por não ser dimensão comercial do N14. Evidências de outro `candidate_id` jamais são consideradas: a consulta do repositório filtra por `candidate_id` na camada SQL, sem nenhum identity matching cross-market. Quando duas ou mais evidências `KNOWN` disputam o mesmo campo, nenhum sinal é transportado e a ambiguidade é registrada (`ambiguousFields`), sem regra nova de precedência. Qualquer falha de leitura (`ok=false`) ou `candidate_id` inválido produz `readFailure=true` e sinais vazios — o N14 permanece exatamente como antes (`UNKNOWN`/`INSUFFICIENT`), sem inventar dados.

### Transporte do preço

O valor numérico `value` da evidência é transportado com `status=KNOWN`, `source=evidence:<evidence_id>`, `provenance=n14:evidence:affiliate:shopee:productOfferV2`, `currency=UNKNOWN` (nunca BRL) e `observedAt` herdado da evidência. A nota preserva explicitamente a proveniência da escala: `unit=string_price_unscaled;quality=UNKNOWN;OBSERVED_STRING_PRICE_SHAPE; SCALE_UNVERIFIED_CONTRACT_UNSPECIFIED`. O normalizer do N14 aceita o shape numérico e mantém o preço `KNOWN` na forma, enquanto a escala permanece semanticamente UNVERIFIED — o N14 não trata a dimensão como comercialmente comprovada além do que o shape permite.

### Precedência de sinais

O merge no `evaluateCommercialBrain` segue a ordem: derivado do candidato < evidência oficial < override explícito da rota. O override administrativo manual continua com precedência máxima, preservando o comportamento da Fase 10.

### Auditoria da origem

`persistAssessment` agora grava `evidenceRefs` com os `evidence_id` transportados e os metadados `evidenceSignalsTransported`, `evidenceRefsUsed`, `evidenceAmbiguousFields` e `evidenceSignalProvenance`. Nenhuma escrita ocorre fora de `candidate_assessment` (o mesmo que o N14 já persistia).

## 3. Testes

O novo arquivo `tests/commercialBrainEvidenceBridgeN14.test.ts` cobre os oito casos obrigatórios e mais quatro cases de fronteira, todos no padrão `node:test` do repositório, com mocks read-only via `curationMocks` e sem efeitos colaterais no Supabase real.

| Teste | Regra autorizada | Resultado |
|---|---|---|
| A. price KNOWN → N14 enxerga o sinal | Transporte básico | PASS |
| B. price preserva unit/quality/UNVERIFIED | Regra 4 (fail-closed semântico) | PASS |
| C. evidência de outro candidate_id ignorada | Regra 7 (identidade exata) | PASS |
| D. evidência UNKNOWN não promovida | Regra 5 (sem promoção) | PASS |
| E. ausência → comportamento atual | Regra 8 (sem fallback) | PASS |
| F. erro de leitura → fail-closed | Regra 9 | PASS |
| G. duplicatas KNOWN → ambiguidade sem sinal | Regra 10 | PASS |
| H. title não vira dimensão comercial | Regra 6 | PASS |
| Edge: value não numérico, unit não comprovada, candidate_id vazio | Fail-closed | PASS |
| Integração: override prevalece sobre evidência | Precedência | PASS |
| Integração: provenance oficial evita fator de risco | Auditoria | PASS |

## 4. Gates

Todos os gates passaram sem alteração de contrato, threshold ou downstream.

| Gate | Resultado |
|---|---|
| `npx tsc --noEmit` | PASS (0 erros) |
| `npm test` (1.430 testes, 92 suítes) | PASS (0 falhas) — o total subiu de 1.417 para 1.430 com os 13 novos testes |
| `npm run build` | PASS |
| `git diff --check` | PASS |
| Secret scan (diff dos arquivos alterados) | PASS — nenhum App ID/Secret/key Render em código ou testes |

## 5. Confirmações obrigatórias

`contract.ts`, `engine.ts`, `weights.ts` e `priceRanges.ts` permanecem intactos; `MIN_DIMENSIONS_KNOWN=2` inalterado; política N15, TTL e autoridade de aquisição intocados; N13, N15, N16, N17, N8 e N6 não foram executados nesta fase; nenhuma migration, write no Supabase, agendamento ou Telegram foi criado; `price` continua com `currency=UNKNOWN` e escala UNVERIFIED na nota; title não virou dimensão; os testes usam mocks read-only e nada é persistido neles.

## 6. O que o N14 passará a classificar

Com a evidência oficial de price transportada e mais nenhuma dimensão comercial KNOWN (seller/availability/competition/market/commission seguem sem evidência elegível), o N14 de uma oportunidade Shopee típica passa a registrar **1 dimensão KNOWN (price)** e permanece `INSUFFICIENT` — sem relaxamento de threshold. Quando uma segunda dimensão com contrato verificável existir (por exemplo, seller rating com evidência KNOWN de outra operação oficial futuramente autorizada), o N14 atinge `MIN_DIMENSIONS_KNOWN=2` e produz score real. O bridge não fabrica a segunda dimensão; ela precisa de evidência real.

## 7. Próximos passos mínimos (aguardando sua autorização)

1. Commit isolado dos 2 arquivos novos/alterados + relatório.
2. Push para `main` e deploy em produção; confirmar `/health` e SHA servido = SHA publicado.
3. Repetir o fluxo real `N2 → N3 → N13 → N14` com a oportunidade Shopee real (mesma URL da Fase 8/15) e observar o N14 real: esperado `dimensionsUsed=[price]`, `band=INSUFFICIENT` (1 dimensão KNOWN), `evidenceRefs` populado.
4. Se o N14 se comportar como esperado, avaliar a origem da segunda dimensão KNOWN antes de considerar N15 — permanece `BLOCKED` até lá, por design.
5. Cleanup do candidato de prova (`can-044a25b735cb3c468b36cdce`) e revogação da key Render `rnd_AQsU...6CEQ` (pendências herdadas da Fase 15).

Nenhum commit, push ou deploy foi executado nesta fase.
