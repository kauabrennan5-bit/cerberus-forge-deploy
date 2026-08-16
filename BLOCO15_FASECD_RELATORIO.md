# Bloco 15 — Fases C e D (Decision Journal + Integração Read-Only)

## RELATÓRIO FINAL — READY FOR REVIEW

**Data:** 16/08/2026, ~04:00 UTC
**Escopo executado:** Fase C (Decision Journal com migration aditiva e repository puro) e Fase D (superfície read-only `POST /api/policy/evaluate` + `GET /api/policy/journal` com autenticação administrativa), conforme o design aprovado na Fase 0 e a autorização das Fases C e D. Trabalho exclusivamente local: **nenhum commit, push, deploy ou migration aplicada em produção**. A trilha auditável passa a existir, mas a governança permanece declarativa — nenhuma rota de execução é criada (POLICY ≠ EXECUTION).

---

## 1. Baseline (verificada antes e depois)

| Item | Antes | Depois | Status |
|---|---|---|---|
| Produção (`/api/telegram/status`) | `backendReady: true`, `operatorState: READY` | `backendReady: true`, `operatorState: READY` | ✔ intacta |
| Backend SHA servido | `f75eff4` | `f75eff4` | ✔ idêntico |
| Products (fonte canônica, Supabase) | 12 | 12 | ✔ idênticos |
| `job_queue` | 0 | 0 | ✔ intacta |
| Telegram token/whitelist | configurados | configurados | ✔ inalterados |
| Webhook Telegram | `webhookConfigured: false` (divergência conhecida, backend separado) | idem | ✔ fora de escopo, inalterado |
| Working tree | arquivos Fases A/B não commitados | + arquivos Fases C/D (não commitados) | ✔ sem modificações indevidas |
| Migrations aplicadas em produção | nenhuma nova | nenhuma nova | ✔ confirmado |
| Operações de produção | — | nenhuma executada | ✔ cumprido |

## 2. Arquivos criados/modificados

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `supabase/migrations/20260816_policy_evaluations.sql` | criado | migration aditiva da `policy_evaluations` (padrão Blocos 13/14: RLS ON, zero policies públicas, FKs textuais, sem backfill). **Não aplicada.** |
| `server/repositories/policyJournalRepository.ts` | criado | repository puro do Decision Journal: persistência com idempotência determinística, sanitização de secrets e consultas read-only (638 linhas) |
| `server/routes/policyEngineRoutes.ts` | criado | rotas read-only: `POST /api/policy/evaluate` e `GET /api/policy/journal`, com `requireAdminAuth` e catálogo fechado de inputs (314 linhas) |
| `server.ts` | **modificado (integração mínima)** | import + injeção do client (`setPolicyJournalClient`) + registro das rotas antes do SPA fallback |
| `package.json` | **modificado (devDependency)** | adicionados `supertest` e `@types/supertest` (somente testes) |
| `tests/policyJournal.test.ts` | criado | 20 testes determinísticos do repository |
| `tests/policyRoutes.test.ts` | criado | 17 testes de rota via express em memória + supertest |

As demais modificações de `server.ts` são exatamente duas linhas de integração (injeção do client e registro das rotas), ambas após `registerCommercialBrainRoutes` e antes do Vite middleware/SPA fallback — a ordem que impede o fallback de capturar as rotas de API, conforme a lição da Fase B. Nenhuma outra rota, handler, tabela ou serviço foi alterado.

## 3. Fase C — Decision Journal

### 3.1. Migration aditiva

A migration `20260816_policy_evaluations.sql` segue estritamente o padrão dos Blocos 13/14: tabela nova `policy_evaluations` com `id` (PK serial), `evaluation_id` (TEXT, UNIQUE — rede de segurança da idempotência), fingerprints (`request_fingerprint`, `decision_fingerprint`), campos declarativos completos (`agent_id`, `agent_version`, `policy_version`, `policy_engine_version`, `policy_reason_code_version`, `decision`, `reason_code`, `reason`, `tool`, `action`, `risk`, `target_table`, `memory_scope`), `approval_state`, `correlation_id`/`causation_id` para proveniência, `context` sanitizado, `checks` e `serialized` (JSONB —snapshot completo da decisão para auditoria futura sem reavaliação), `schema_version` e `evaluated_at`/`created_at`. RLS habilitada com **zero policies públicas** — ninguém lê ou escreve fora do service role; nenhuma migration altera tabelas existentes; sem backfill.

### 3.2. Repository puro

`policyJournalRepository.ts` expõe quatro operações (`insertEvaluation`, `getEvaluation`, `listEvaluations`, `sanitizeText` reutilizável) e adota o mesmo padrão injetável dos Blocos 13/14: client Supabase injetado via `setPolicyJournalClient` (produção) e `setPolicyJournalClientForTests` (testes). Os comportamentos críticos:

| Comportamento | Implementação |
|---|---|
| Idempotência determinística | Consulta explícita `evaluation_id` **antes** do insert; registro existente → `resolveDuplicate` compara fingerprints e checks: idêntico → `identical_duplicate` (a segunda avaliação não grava duplicata), divergente → `conflict_rejected` (falha auditável, nunca sobrescreve) |
| Ausência de efeitos colaterais na decisão | A persistência nunca altera, atrasa ou falha silenciosamente a decisão do Policy Engine: `missing_supabase` e `database_error` retornam `journalFailure: true` com a decisão intacta |
| Sanitização de secrets | `sanitizeText` remove padrões de credenciais (`Bearer`, `sk-`, `tok-`, chaves hex) e `sanitizeChecks` expurga chaves sensíveis (`token`, `secret`, `api_key`, `prompt`, `raw_content`…) — `reason`, `context`, `checks` e `serialized` nunca carregam secrets em texto plano |
| Validação antes da gravação | `validateEvaluationRecord` rejeita `decision`/`reason_code`/`risk` fora dos catálogos fechados → `conflict_rejected` (a trilha só contém estados canonizados) |
| Sem fallback silencioso | Toda falha retorna outcome explícito com `journalFailure` — nunca um registro inventado ou omitido sem sinal |

Durante a implementação, um defeito de design foi descoberto e corrigido: a primeira versão resolvia duplicidade **apenas** via exceção de constraint da PK — comportamento invisível para bancos/fakes sem a constraint. A versão final verifica duplicidade explicitamente **antes** do insert (determinístico em qualquer ambiente), mantendo a constraint UNIQUE como rede de segurança em produção.

## 4. Fase D — Integração Read-Only

### 4.1. `POST /api/policy/evaluate`

Rota administrativa (`x-admin-password`, mesmo padrão do Bloco 14). Recebe 8 campos declarativos obrigatórios (`agent_id`, `agent_version`, `policy_version`, `tool`, `action`, `target_table`, `risk`, `memory_scope`) mais `approval_state` (catálogo fechado: `NONE`, `PENDING`, `APPROVED`, `REJECTED`, `EXPIRED`) e `persist` (`"true"`/`"false"`). O payload é validado **antes** de qualquer avaliação: campos ausentes/vazios/inválidos → `400 INVALID_PAYLOAD` com lista de erros, **sem executar a avaliação** (a trilha não grava rejeições sintáticas). A avaliação em si segue exatamente a decisão real do engine — sem atalhos nem mocks — e a resposta traz `decision`, `reason_code`, `reason` declarativo, `evaluationId` determinístico, `checks` e o resultado do journal (`persisted: true` + `{outcome, evaluation_id}` ou `warning` + `persisted_actual: false`).

### 4.2. `GET /api/policy/journal`

Superfície **exclusivamente read-only**: consulta por `evaluation_id` (`200 {evaluation}` / `404 EVALUATION_NOT_FOUND` / `500 JOURNAL_ERROR`) e listagem paginada (`page`, `page_size` limitado, filtro opcional `decision`) com contagem total exata. Não existe rota de write: `PUT`, `PATCH` e `DELETE` sobre o journal retornam 404 — testado explicitamente (D16) e garantido por construção (nenhum handler é registrado). Qualquer exceção é convertida em `500 POLICY_ROUTE_ERROR` sem vazar stack trace.

### 4.3. Integração em `server.ts`

A injeção do client é condicional (apenas quando `productsRepository.supabase` existir, padrão idêntico ao do Bloco 14) e o registro das rotas usa o mesmo `requireAdminAuth` já existente — nenhum novo mecanismo de autenticação foi criado.

## 5. Correções e decisões durante a execução

Dois ajustes relevantes além do design aprovado. Primeiro, o defeito de idempotência do repository (seção 3.2), que tornaria o journal silenciosamente não idempotente fora do Postgres com constraint. Segundo, durante os testes, foi corrigida uma expectativa errada do teste D05 (que esperava `identical_duplicate` na primeira avaliação, sempre `inserted` por definição) — a correção tornou o teste fiel ao contrato: primeira iteração `inserted`, segunda `identical_duplicate` com `evaluationId` idêntico.

Foi também descoberto, e deliberadamente **não corrigido**, que os subtests do test runner do Node executam concorrentemente por padrão: os testes que compartilham o client singleton do journal usavam `test()` sem serialização, gerando corridas (cliente substituído por `null` por outro arquivo durante a avaliação). Todos os 17 testes de rota e os 20 do repository agora usam `{ concurrency: false }`. Este é um risco de teste, não de produção — mas o incidente reforça a disciplina de que shared state + concorrência exige explicitação.

## 6. Cobertura de testes — 38 testes novos, 38 passando

**Fase C (20 testes, `tests/policyJournal.test.ts`, execução serial):** persistence do registro completo com fingerprints e serialized (1); sanitização de `reason`/`context`/`checks` com secrets de credenciais (2–6); validação de catálogos (`validateEvaluationRecord` rejeita reason_code/decision/risk fora do catálogo — 7–9); idempotência determinística — re-insert idêntico → `identical_duplicate` sem duplicata, sem alteração do registro original (10–12); conflito → `conflict_rejected` sem sobrescrita (13); journal indisponível (client null) → `missing_supabase` sem exceção (14); listagem paginada com filtro por decisão e contagem exata (15–17); consulta por evaluation_id (18); determinismo do `evaluationId` (19); ausência de exports executáveis no repository (20).

**Fase D (17 testes, `tests/policyRoutes.test.ts`, via supertest com express em memória e admin-auth falso, execução serial):** 401 sem autenticação nas duas rotas (D01–D02); avaliação real (agent disabled → `DENY`/`AGENT_DISABLED`, 9 checks) (D03); prova de que `POLICY != EXECUTION` — mesmo request legítimo nunca executa action (D04); idempotência ponta-a-ponta (inserted → identical_duplicate, mesmo evaluationId) (D05); `persist=false` não grava e devolve nota explícita (D06); payload inválido/parcial/estados de aprovação fora do catálogo → 400 sem avaliar (D07–D09); approval pendente → `REQUIRES_APPROVAL` (D10); reason codes da resposta pertencem ao catálogo fechado (D11); journal read-only: listagem, consulta por id, 404 em id inexistente, filtro por decisão (D12–D15); ausência total de rotas PUT/PATCH/DELETE no journal (D16); journal indisponível → resposta explícita com `warning`/`persisted_actual: false` e decisão preservada (D17).

O total do projeto passa a **331 testes em 19 suítes** (293 anteriores + 38 novas).

## 7. Gates finais

| Gate | Resultado |
|---|---|
| `npm test` | **331/331 passando** (19 suítes, incluindo 30 Fase A + 39 Fase B + 20 Fase C + 17 Fase D + 224 produção) |
| `npx tsc --noEmit` | limpo |
| build (catalog + vite + esbuild) | ok, `dist/server.cjs` gerado sem erros |
| Working tree | novos arquivos não commitados; integrações em `server.ts` e `package.json` descritas na seção 2 |
| produção untouched | 12 produtos canônicos, `job_queue = 0`, Telegram/Operator inalterados, migration não aplicada, nenhuma escrita |

## 8. Divergências

Nenhuma divergência nova. Registro de contexto persistente: webhook do Telegram desconfigurado (`webhookConfigured: false`, backend separado `cerberus-forge-deploy-backend.onrender.com`) — o Operator mantém `READY` por fallback resiliente. Fora do escopo do Bloco 15 e deliberadamente não tocado.

## 9. Riscos residuais

O journal registra a decisão, mas **ainda não é consultado pelos call sites de execução** — a Fase C/D consolida a trilha auditável e a superfície de consulta; o engate do engine nos pontos reais de execução (enfileiramento, publicação, envio) permanece fora do Bloco 15, conforme o design aprovado. A persistência depende da migration `policy_evaluations` ser aplicada em produção na publicação; sem ela, as rotas respondem com `journalFailure: true` e `persisted_actual: false`, preservando a decisão — degradação segura, nunca perda silenciosa. Os dois testes estruturais da Fase A que garantem que o journal não exporta capacidades executáveis (teste 20 da Fase C; ausência de handlers de write em D16) protegem contra deriva futura.

## 10. Próximas autorizações necessárias

**Publicação do Bloco 15 em produção** — autorizado por prompt, o passo de consolidação executa: aplicar a migration `20260816_policy_evaluations.sql` no Supabase, adicionar os arquivos ao commit, push para main (sem force), aguardar deploy do Render, validar `/health` e SHA, confirmar 12 produtos, catálogo, job_queue e Telegram/Operator intactos e as 4 tabelas de observações do Bloco 13 + a nova `policy_evaluations` com RLS ativo e zero policies públicas. Sem essa autorização, o Bloco 15 permanece em READY FOR REVIEW e nada é publicado.

---

## GATES FINAIS DAS FASES C + D — TODOS VERDES

**BLOCO 15 — FASES C + D — READY FOR REVIEW**

POLICY != EXECUTION · EVALUATION != ACTION · RECOMMENDATION != ACTION · AGENT != AUTHORITY · MEMORY != AUTHORITY · JOURNAL != CONTROL · DEFAULT DENY · DECLARED IDENTITY · RISK FLOORING

*Aguardando autorização explícita para a etapa de publicação (migration + commit + push + deploy).*
