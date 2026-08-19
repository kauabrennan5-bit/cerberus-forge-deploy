# BLOCO N14 — COMMERCIAL BRAIN (CANDIDATE SCORER) — ESPECIFICAÇÃO OFICIAL

**Versão do contrato:** commercial_brain_v1
**Versão dos pesos:** cb_weights_v1
**Versão das faixas de preço:** cb_price_ranges_v1
**Autor:** Manus AI
**Data:** 19/08/2026
**Status:** FASE 1 CONCLUÍDA (implementação local validada — aguardando autorização para prova viva)

---

## 1. OBJETIVO

O N14 implementa o **Commercial Brain**: motor determinístico de avaliação comercial de candidatos que passaram pelo gate de curadoria N13. Para cada candidato com veredicto `PASS` no N13, o N14 calcula:

1. Um **score comercial determinístico** entre `0.0000` e `1.0000`.
2. Uma **banda comercial** (`HIGH`, `MEDIUM`, `LOW` ou `INSUFFICIENT`).
3. Um **rationale explicável** e canônico que registra todas as dimensões usadas, desconhecidas e fatores de risco.
4. Uma **avaliação persistida** com `idempotencyKey` e `digest` estáveis (replay de mesmo snapshot → mesma saída).

O N14 é **apenas leitura/avaliação**: não cria produtos, não cria affiliate links, não publica, não cria jobs e não dispara Telegram.

---

## 2. INVARIANTES GOVERNADOS

1. **CANDIDATE != FACT CANÔNICO**: a avaliação comercial não altera nenhum produto canônico.
2. **Gate N13 obrigatório (fail-closed)**: somente candidatos com veredicto `PASS` no `n13:curator_v1` podem ser avaliados. Qualquer outro estado (`FAIL`, ausente, erro) → `gate_failed` sem score.
3. **Determinismo e replay**: mesmo snapshot (mesmo candidato, mesmas evidências, mesma data de referência) → mesmo `assessment_id`, mesmo `digest`, mesmo score/band/rationale.
4. **Isolamento**: o N14 nunca toca `products`, `affiliate_links`, `publication`, `job_queue`, Telegram ou N8/N15/N16. Testes verificam zero importação de módulos de efeitos.
5. **Fail-closed de dados**: dados insuficientes → band `INSUFFICIENT` (score não é reportado como comercial).
6. **UNKNOWN ≠ 0**: dimensões sem evidência são EXCLUÍDAS do score e registradas em `dimensionsUnknown`; nunca viram zero nem neutro.
7. **Proveniência obrigatória**: sinais sem provenance rastreável são rejeitados para `UNKNOWN` (ou entram como fator de risco explícito quando KNOWN sem provenance).
8. **Sem IA generativa**: 100% determinístico, sem LLM.

---

## 3. TAXONOMIA DE SINAIS (6 DIMENSÕES)

| Dimensão | O que mede | Fonte de evidência | Status inicial |
|---|---|---|---|
| price | Atratividade do preço comprovado (BRL) | candidate.observed_price + evidence | KNOWN se número 0–20.000.000 |
| commission | Fração de comissão do provider afiliado (0–1) | Somente via provider afiliado (N8) com provenance | UNKNOWN persistente sem evidência real |
| seller | Reputação do vendedor (rating 0–5, reviews) | candidate.observed_rating/_rating_count | KNOWN se rating numérico |
| market | Movimentação de mercado (reviews/vendas comprovados) | Somente via evidência comercial real com provenance | UNKNOWN persistente sem evidência real |
| availability | Disponibilidade comprovada | candidate.observed_availability (IN_STOCK/OUT_OF_STOCK) | KNOWN se IN/OUT; UNKNOWN caso contrário |
| competition | Concorrência na categoria | Somente via evidência real (não implementado nesta versão; weight 0) | UNKNOWN por ausência de evidência |

Regras específicas do N14:

- `commission`, `market` e `competition` NUNCA são derivadas do candidato. Só entram KNOWN com evidência real e proveniente (ex.: `n14:affiliate:shopee`). Sem isso, permanecem `UNKNOWN` e não penalizam.
- `competition` v1 tem peso 0: dimensão preparada, sem participação no score até haver evidência.
- Domínios: price 0–20.000.000; commission 0–1; rating 0–5; availability {0, 1}; market 0–∞ (saturação log); competition 0–∞.
- Values impossíveis (negativos, NaN, fora do domínio) → sinal rejeitado com `rejectedReason` canônico e status `UNKNOWN`.

---

## 4. FAIXAS DE PREÇO POR CATEGORIA (cb_price_ranges_v1)

Registro versionado (`server/commercial/commercialBrain/priceRanges.ts`). Quando a categoria do candidato tem faixa registrada, o preço é normalizado RELATIVO à faixa (mínimo da faixa = 1, máximo = 0, clampado nos extremos). Sem faixa registrada, usa-se a normalização absoluta e o rationale registra `price_range:unknown` para auditoria. A faixa NUNCA é inventada.

```
Registry cb_price_ranges_v1 (faixas plausíveis do varejo BR, baseline):
- Casa e decoração           → 9.90   – 499.00
- Eletrônicos                → 19.90  – 2999.00
- Informática / computadores → 49.90  – 5999.00
- Esportes e lazer           → 9.90   – 599.00
- Beleza e saúde             → 29.90  – 1499.00
- Brinquedos / infantil      → 29.90  – 1299.00
- Moda / roupas / acessórios → 39.90  – 2499.00
- Livros / mídia             → 29.90  – 999.00
- Supermercado / alimentos   → 9.90   – 799.00
- Ferramentas / automotivo   → 19.90  – 1999.00
```

Lookup por keyword normalizada (lowercase, sem acentos). Categoria sem entrada → priceRange=null → normalização absoluta (0–20M) e rationale `used:price:...,price_range:unknown`.

---

## 5. REGISTRY DE PESOS (cb_weights_v1)

```
price        0.25
commission   0.25
seller       0.20
market       0.15
availability 0.15
competition  0.00   (sem evidência nesta versão — peso 0 não penaliza)
SOMA         1.0000 (validada em runtime no boot do registry)
```

Nota de auditoria (`COMMERCIAL_BRAIN_WEIGHTS_NOTE`): pesos são baseline determinístico inicial; NÃO são otimizados empiricamente e NÃO representam o peso econômico real do negócio.

---

## 6. ALGORITMO DE SCORE (motor puro)

Passo 1 — **Normalização de sinais**: cada input vira `NormalizedSignal` com `value`, `status` (KNOWN/UNKNOWN), `source`, `observedAt`, `provenance`, `note`; `normalizedValue` é o valor no domínio da dimensão (null quando UNKNOWN). Provenance ausente → `UNKNOWN` (exceto commission/market/competition que já nascem UNKNOWN).

Passo 2 — **Detecção de conflitos**: contradições canônicas entre sinais KNOWN (ex.: seller rating 0 com market > 0; availability OUT_OF_STOCK com market > 0). Dimensões conflitantes saem do score e entram em `dimensionsUnknown`.

Passo 3 — **ScoreComponents**:
- Normalização intra-dimensão: price → relativo à faixa da categoria (min=1, max=0, clamp); commission → direto; availability → 0/1; seller → /5; market → log saturação; competition → 1/(1+v).
- Score = média ponderada das dimensões KNOWN não conflituosas, com pesos renormalizados pela cobertura (soma 1 dentro das avaliáveis).
- `coverage = dimensões_KNOWN / 6`.

Passo 4 — **Risk penalty** (multiplicador visível 0.5–1.0):
- Cada fator canônico reduz 10% do multiplicador, piso em 0.5:
  - `conflict_dimensions:<dims>`
  - `unprovenanced_dimension:<dim>` (dimensão KNOWN sem provenance rastreável)
  - `stale_signal:<dim>:<Nd>` (sinal com mais de 90 dias da referência)
- Multiplicador é EXPLÍCITO no output (`riskPenalty`, `riskFactors`).

Passo 5 — **Score final**: `round(normalized * multiplier * 10000) / 10000`, clampado 0–1.

Passo 6 — **Banda**:
- coverage < minDimensionsKnown (2) → `INSUFFICIENT` (confidence LOW; score não é interpretado comercialmente)
- score ≥ 0.75 → `HIGH`; > 0.40 → `MEDIUM`; ≤ 0.40 → `LOW`
- confidence: `HIGH`, rebaixada a `MEDIUM` com conflitos ou penalty < 1.0, `LOW` com penalty ≤ 0.6.

Passo 7 — **Rationale canônico**: cláusulas ordenadas por dimensão (`used:`/`conflict:`/`unknown:`) + `risk:<fatores>` + `insufficient:` quando aplicável; `used:price:...;price_range:<min>-<max>` (ou `price_range:unknown`) para auditoria da faixa usada.

---

## 7. DIGEST E IDEMPOTÊNCIA

```
digest = sha256(JSON({
  candidateId,
  contractVersion,
  weightsVersion,
  score,
  bandBasis: { dimensionsUsed, dimensionsUnknown, conflictDimensions,
               penaltyMultiplier, coverage },
  referenceDateIso
}))
```

- `assessment_id = cb-<candidate_id sem prefixo "can-">`.
- `idempotencyKey` = hash do snapshot (sinais + decisão + `n13AssessmentId`): replay do mesmo snapshot → idênticos. Snapshot **não** inclui horário de avaliação (only evaluatedAt).
- `referenceDateIso` entra no digest (replay com a mesma referência → mesmo digest; data de referência é parte do snapshot).

---

## 8. PERSISTÊNCIA

- Tabela `candidate_assessment` (reutilizada), com `filter_version = "n14:commercial_brain_v1"`.
- Campos: `score`, `band`, `coverage`, `confidence`, `contractVersion`, `weightsVersion`, `rationale`, `digest`, `classification` (`COMMERCIAL_HIGH/MEDIUM/LOW`, null se INSUFFICIENT), `classificationBasis`, `snapshot` (JSON com sinais, dimensões e risco), `idempotencyKey`, `evaluatedAt`.
- Migration: `supabase/migrations/20260819_commercial_brain_candidates.sql` (apenas para a fase 2, com autorização; NÃO aplicada na fase 1).
- Leitura: somente o assessment N13 mais recente (ordenação `evaluated_at DESC`).
- Write-once: assessment já existente (mesmo assessment_id) não é sobrescrito sem mudança de snapshot — comportamento idempotente.

---

## 9. ROTA

```
POST /api/commercial/curation/candidates/brain/evaluate
Body:   { "candidate_id": "can-<hex 24-32>" }
Auth:   x-admin-password (N6)

Sucesso: { ok: true, decision: { contractVersion, weightsVersion,
         candidateId, score, coverage, band, confidence, conflict,
         conflictDimensions, dimensionsUsed, dimensionsUnknown,
         riskPenalty, riskFactors, rationale, assessmentId, digest,
         idempotencyKey, n13AssessmentId }, assessment_id, digest }

Falha:   { ok: false, outcome: "gate_failed",
         gateReason: invalid_candidate_id | candidate_not_found |
                     n13_verdict_fail | n13_assessment_missing |
                     n13_eligibility_fail }
         ou { ok: false, outcome: "error" }
```

- Sem `x-admin-password` → 401 (fail-closed).
- O endpoint é registrado em `server.ts` sob `/api/commercial/curation` (mesmo domínio do N13).

---

## 10. ARQUITETURA DE CAMADAS

```
server/commercial/commercialBrain/
  contract.ts    — contrato, bandas, versões, notas de auditoria
  weights.ts     — registry cb_weights_v1 (set/get/test-only overrides)
  priceRanges.ts — registry cb_price_ranges_v1 (lookup determinístico)
  normalizers.ts — funções puras de validação/normalização de sinais
  engine.ts      — motor puro (conflitos, score, penalty, bandas, rationale, digest)
  service.ts     — orquestração: gate N13, derivação do candidato,
                   persistência, idempotência, sem efeitos colaterais
  routes.ts      — rotas HTTP (completa na rota shared N13)
tests/
  commercialBrainN14.test.ts — 41 testes unitários e de integração
  curationMocks.ts           — mocks Supabase híbridos (read/write + idempotência)
  _proofN14.ts               — prova local controlada (11 cenários A–K)
```

Isolamento verificado: nenhum módulo do N14 importa módulos de efeitos (products, affiliate, jobs, telegram, worker, scheduler, N8/N15/N16, publication).

---

## 11. PORTES E LIMITAÇÕES CONHECIDAS (UNKNOWNs)

1. `commission`, `market` e `competition` ficam `UNKNOWN` até haver integração com o provider afiliado (N8) e evidência comercial real com provenance. NENHUM valor foi presumido.
2. Faixas de preço (cb_price_ranges_v1) são baseline documentado, NÃO otimizadas empiricamente.
3. Pesos (cb_weights_v1) são baseline documentado, NÃO representam o peso econômico real.
4. Sem scheduler/agente: o N14 é avaliado sob demanda via API/Telegram; a integração com o pipeline N13 (auto-avaliação pós-curação) é objeto da Fase 2 (prova viva).
5. `competition` v1 tem weight 0 — dimensão estruturada mas inerte até evidência.

---

## 12. GATES DE FASE 1 (LOCAIS)

| Gate | Resultado |
|---|---|
| Suíte N14 específica | 41/41 PASS |
| Prova controlada local (_proofN14) | 11/11 PASS (A–K) |
| Suíte completa do projeto | 1212/1212 PASS |
| `tsc --noEmit` | 0 erros |
| `npm run build` | OK |
| DDL em produção | NÃO (autorização pendente) |
| Commit/push/deploy | NÃO (autorização pendente) |

---

## 13. PROVA CONTROLADA LOCAL (cenários A–K)

A) N13 PASS → N14 executa com score e cria assessment;
B) N13 FAIL → gate `n13_verdict_fail`;
C) sem N13 → gate `n13_assessment_missing`;
D) candidate não encontrado → `candidate_not_found`;
E) candidate_id inválido → `invalid_candidate_id`;
F) INSUFFICIENT: menos de 2 dimensões KNOWN → band INSUFFICIENT, score não reportado comercialmente;
G) conflito de sinais → dimensões conflitantes excluídas, confidence MEDIUM;
G2) conflito + penalty + rationale rastreável;
H) penalty por dados antigos (stale_signal >90d) e unprovenanced dimension;
I) replay idempotente: mesmo snapshot → mesmo assessment_id, digest e idempotencyKey;
J) snapshot alterado (preço 129.90 → 99.90) → score 0.8644 → 0.8900, novo digest e nova idempotencyKey (sensibilidade validada);
K) zero efeitos comerciais: módulos N14 não tocam product/affiliate/jobs/telegram/worker/scheduler/N8/N15/N16/publication.

---

## 14. PRÓXIMOS PASSOS (PENDENTES DE AUTORIZAÇÃO)

1. Fase 2 — Prova viva controlada em produção (com autorização explícita):
   - validar baseline N1–N13 intacto;
   - aplicar migration `20260819_commercial_brain_candidates.sql`;
   - avaliar candidato de prova artificial via rota com autenticação admin;
   - provar idempotência (replay);
   - provar fail-closed (N13 FAIL/ausente);
   - provar INSUFFICIENT com dados parciais;
   - provar bandeamento e rationale em produção.
2. Fase 3 — Limpeza integral dos dados de prova (assessments N14 artificiais).
3. Fase 4 — Commit + push + deploy Render (com autorização), validação pós-deploy e fechamento do N14.
