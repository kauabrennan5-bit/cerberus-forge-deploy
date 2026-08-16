# BLOCO 16 — FASE C — AGENT RUNTIME EXECUTION CORE

**STATUS: READY FOR REVIEW**

Nenhum commit, push, deploy, migration ou escrita em produção foi realizado. Todos os agentes permanecem desabilitados. O desenvolvimento ocorreu exclusivamente local, com produção verificada somente em leitura.

---

## 1. Objetivo

Transformar o contrato da Fase A do Bloco 16 em um **núcleo de execução controlado**, utilizando exclusivamente os contratos já aprovados e o **Policy Engine do Bloco 15 como único autorizador**. O Runtime passa a ser a única porta futura pela qual qualquer agente poderá solicitar execução, fechando a cadeia:

```
AGENT → RUNTIME → POLICY ENGINE → DECISION → LIFECYCLE → EXECUTION PLAN → TOOL ADAPTER (ainda não executado)
```

A Fase C **não habilita agentes** (todos permanecem `enabled: false`, `status: DRAFT`) e **não conecta executores** (Telegram, publicação, marketplace, LLM, job real).

## 2. Baseline (capturada antes de qualquer código)

| Item | Valor comprovado |
|---|---|
| Branch / HEAD | `main`, SHA `981a2c9` |
| Produção (frontend e backend) | `/health` retornando SHA `981a2c93fc56732c716f368539e42b0816133eb4` nas duas instâncias |
| Catálogo | 12 produtos `published` (envelope `GET /api/products`) |
| `policy_evaluations` | 1 registro (audit record do Bloco 15, preservado) |
| `job_queue` | 0 registros |
| `commercial_artifacts` / signals | 0 registros |
| `product_*_observed` (4 tabelas Bloco 13) | 0 registros, RLS ativo |
| Telegram | webhook respondendo (POST 200 imediato, processamento assíncrono) |
| Registry | 10 agentes, todos `enabled: false`, contratos congelados |
| Suíte anterior | 375/375 testes (Fase A inclusa) |

## 3. Auditoria obrigatória pré-implementação (achados e divergências registradas)

Antes de escrever código, foram lidos: `server/agentRuntime/` (Fase A), `server/agentRegistry/` (registry completo + reason codes do runtime), `server/policyEngine/` (engine, types, `toolActionMap` com `POLICY_REASON_CODE_CATALOG`), `server/repositories/` (journal do Bloco 15), o design review do Bloco 16, os testes da Fase A e os mecanismos de `jobQueue`/`pendingApprovals` do Operator.

Divergências registradas e tratadas:

1. **`execution_id` no contrato da Fase A.** O `AgentRuntimeRequest` da Fase A não continha `execution_id`, apenas `requestId`/`correlationId`. A geração determinística de `execution_id` foi implementada em módulo próprio (`execution.ts`), derivada de `intentionKey + identityContext` — o mesmo `intention_key` nunca gera execuções independentes, sem usar timestamp como única identidade.
2. **`PolicyEvaluationChecks` exige os 8 checks na ordem do engine** (`request, agent, enabled, version, tool, action, scope, risk`, tipo `"PASS" | "FAIL"`). Os fakes dos testes foram construídos contra esse shape real — não houve divergência, apenas confirmação do contrato do Bloco 15.
3. **Catálogo de reason codes.** O engine usa `POLICY_REASON_CODE_CATALOG` fechado (ex.: `POLICY_ALLOW`, `AGENT_DISABLED`, `APPROVAL_REQUIRED`, `TOOL_ACTION_MISMATCH`). O runtime usa seu próprio catálogo fechado (`IDENTITY_*/REQUEST_INVALID/TARGET_TABLE_AMBIGUOUS/TABLE_NOT_ALLOWED/TRANSITION_FORBIDDEN*/PLAN_CREATED_EXECUTOR_NOT_CONNECTED/EXECUTOR_NOT_CONNECTED`), sem duplicar o catálogo do engine e sem criar interseção indevida.

Nenhum arquivo protegido (productsRepository, jobQueue, Telegram, Operator, watchdog, lifecycle de produto, commercialBrain, policyEngine, agentRegistry) foi modificado.

## 4. Arquitetura implementada

```
server/agentRuntime/
  types.ts       — tipos base (Fase A)
  contracts.ts   — AgentRuntimeRequest, ExecutionPlan, RuntimeResult (Fase A + extensão documentada)
  validation.ts  — checks estruturais, budgets, memory scope, guard de decisão, intention key (Fase A)
  execution.ts   — execution_id determinístico (FNV-1a, 36 chars), input fingerprint, schema version 1.0
  lifecycle.ts   — máquina fechada da Fase A com funções de transição
  idempotency.ts — ExecutionRecord, ExecutionStore (interface), InMemoryExecutionStore (TEST-ONLY)
  toolAdapter.ts — ADAPTER_REGISTRY congelado vazio, resolveToolAdapter → NOT_CONNECTED
  approval.ts    — ApprovalProvider (interface) + NeverApproveProvider (default)
  pipeline.ts    — orquestração fechada de 10 estágios
  runtime.ts     — entry point puro (injeção de dependências obrigatória)
```

O `pipeline.ts` importa **apenas**: `../policyEngine/types`, `../agentRegistry/agents` (registryLookup), `../agentRegistry/types`, e módulos internos do `agentRuntime/`. Nenhuma dependência de Supabase, Express, Telegram, LLM, filesystem ou Operator.

## 5. Pipeline fechada (10 estágios, ordem obrigatória)

| # | Estágio | O que faz | Falha → |
|---|---|---|---|
| 1 | REQUEST_VALIDATION | Validação estrutural (7 campos críticos + catálogos fechados) | `REQUEST_INVALID`, lifecycle `REQUESTED` |
| 2 | AGENT_IDENTITY | Conhecido + habilitado (default deny) | `IDENTITY_DISABLED`, engine **não consultado** |
| 3 | VERSION_COMPATIBILITY | Versão congela com o registry | `IDENTITY_VERSION_MISMATCH` |
| 4 | ACTION_TOOL_COMPATIBILITY | `ACTION_TOOL_MAP` do Bloco 15 | `IDENTITY_TOOL_ACTION_MISMATCH` |
| 5 | BUDGET_CHECK | Budget alocado > 0 para executar; negativo rejeitado | `REQUEST_BUDGET_INVALID` |
| 6 | MEMORY_SCOPE_CHECK | `requested ⊆ allowed` | `MEMORY_SCOPE_NOT_ALLOWED` |
| 7 | POLICY_EVALUATION | **Única consulta obrigatória ao Policy Engine** | segue a decisão exata |
| 8 | LIFECYCLE_PLANNING | Transições da máquina da Fase A | `TRANSITION_FORBIDDEN` / `BY_GATE` |
| 9 | EXECUTION_PLAN_CREATION | Plano imutável + execution_id + intention_key | — |
| 10 | EXECUTION_GATE | Tool Adapter; nesta fase: `NOT_CONNECTED` | `PLAN_CREATED_EXECUTOR_NOT_CONNECTED` |

O invariante formal é garantido: `DENY → DENY`, `REQUIRES_APPROVAL → WAITING_APPROVAL`, e **nunca** `DENY → ALLOW`. Nenhuma etapa posterior pode transformar uma decisão negativa em positiva — os estágios 8–10 só executam quando a decisão é `ALLOW`.

## 6. Integração com o Policy Engine

O `evaluatePolicy` é **dependência injetada e obrigatória** (inexistência → erro imediato, sem fallback). O Runtime **não recria regras de política**: as validações estruturais (identidade, versão, action/tool) protegem a request antes da consulta, e a decisão de política vem exclusivamente do engine do Bloco 15. Registros da decisão (`policy_evaluation` no `RuntimeResult`) carregam agent/policy/tool/action/risk/decision/reason/correlation_id — o journal linkage exigido pelo prompt fica pronto para a fase de persistência (decisão D-8 do design review, adiada por falta de autorização de schema).

## 7. Lifecycle

Uso exclusivo da máquina da Fase A: 13 estados, transições fechadas. Comprovado nos testes (suíte D e property tests):

- `DENIED → PLANNED`: impossível (`TRANSITION_FORBIDDEN`);
- `EXPIRED → PLANNED` / `CANCELLED → RUNNING`: impossíveis;
- `PLANNED → RUNNING`: só com `executorConnected = true` — nesta fase o gate proíbe (`TRANSITION_FORBIDDEN_BY_GATE`);
- Nenhuma função permite modificar o estado ignorando a máquina (estado é um tipo imutável, transição produz novo estado).

## 8. Execution Plan

`ExecutionPlan` imutável (Object.freeze) contém: `executionId`, `intentionKey`, `requestId`, `agentId`, `agentVersion`, `policyVersion`, `tool`, `action`, `risk`, `approvalState`, `inputReference`, `outputSchemaVersion`, `budget`, `createdAt`, `correlationId`, `lifecycleState`, `approvalRequirement`, `inputFingerprint`, `schemaVersion ("1.0")`. **Não contém** secrets, tokens, Authorization headers, prompts privados ou credenciais — o input é referenciado por `inputReference`/`inputFingerprint`, nunca carregado.

## 9. Execution ID e idempotência

`generateExecutionId({intentionKey, identityContext})` → `exec-` + FNV-1a (36 chars). Comprovado: mesma intenção + mesmo contexto relevante = mesmo id; alteração relevante = novo id; timestamp nunca é usado como identidade.

Casos de idempotência (teste F):

1. primeira solicitação → registrada, `conflict: NONE`;
2. segunda solicitação idêntica → `DUPLICATE_SAME_INTENTION`, retorna o mesmo registro;
3. mesma `intentionKey` + contexto diferente → `INTENTION_CONFLICT`, rejeitado;
4. `execution_id` incompatível é derivado deterministicamente — não existe "injeção" de id arbitrário.

A `ExecutionStore` é uma **interface** (`resolveByKey`); a `InMemoryExecutionStore` é marcada TEST-ONLY, documentada como fronteira, e não usada como persistência em produção. Nenhuma migration foi criada.

## 10. Approval boundary

`ApprovalProvider` é a única abstração. O provider padrão é `NeverApproveProvider`: nunca aprova (`PENDING` para requisições de aprovação, `NOT_REQUIRED` quando não exigida). `approved=true` fornecido pelo próprio agente **não é** prova suficiente — a aprovação permanece autoridade externa. `REQUIRES_APPROVAL` resulta em `WAITING_APPROVAL`, sem executar.

## 11. Tool Adapter boundary

Fronteira explícita: Runtime → Tool Adapter → EXECUTOR FUTURO. O `ADAPTER_REGISTRY` está **congelado e vazio** por projeto; `resolveToolAdapter` retorna `NOT_CONNECTED / EXECUTOR_NOT_CONNECTED` com `externalInvocation: null` para qualquer tool. Proibido nesta fase: Telegram, publicação, preço, products, marketplace, job real, LLM executando ação, mensagens externas, infraestrutura.

## 12. Security (fail-closed)

Qualquer falha de verificação → negação: agente desconhecido, disabled, versão inválida, tool/action inválida, incompatibilidade, budget inválido, scope inválido, policy DENY, contexto ausente obrigatório, estado inválido, approval inválida. O engine **nunca é consultado** para requests estruturalmente inválidas ou agentes desabilitados (testes B provam que um engine "corrompido" que sempre retorna ALLOW nunca é chamado). Não existe caminho "se não conseguir verificar, permite".

## 13. Authority boundaries

O Runtime não altera: products (criar/apagar/publicar/preço), catálogo, policies, Agent Registry, maxRisk/allowedTools/allowedActions/memory scopes/policy versions, job_queue, Telegram. Ele não se habilita nem habilita agentes. Ele apenas **planeja e controla o fluxo de execução** — comprovado pela auditoria estrutural de imports (seção 14) e pelo resultado `EXECUTOR_NOT_CONNECTED` mesmo com ALLOW.

## 14. Auditoria estrutural (testes K)

Os 10 módulos do runtime foram lidos em disco e auditados contra os imports proibidos: `telegramBot`, `jobQueueRepository`, `safeAutoHealEngine`, `productAutomation`, `supabase`, `llm`, `createClient`, `productPipeline`, `productLifecycle`, `operatorState`. Resultado: **zero imports proibidos em todos os arquivos**. A `pipeline.ts` também foi auditada linha a linha: todos os imports pertencem ao conjunto autorizado.

## 15. Testes

Novo arquivo `tests/agentRuntimeExecution.test.ts`: **130 testes em 11 suítes**, todos PASS. Cobertura mapeada aos casos obrigatórios do prompt:

| Caso do prompt | Suíte / teste |
|---|---|
| A–H (request válida/inválida, agente desconhecido/desabilitado, versão, action, tool, mismatch) | A, B (identidade antes do engine), J |
| I, J (budget zero/negativo) | já cobertos pela Fase A; regressão herdada (375 testes) |
| K (scope fora do permitido) | Fase A (herdado) |
| L, M, N (DENY / REQUIRES_APPROVAL / ALLOW) | B, C |
| O, P (DENY nunca vira ALLOW; REQUIRES_APPROVAL nunca vira RUNNING) | C (guard), D (máquina) |
| Q (lifecycle inválido) | D |
| R, S (idempotência / intention conflict) | F |
| T, U (execution_id determinístico / determinismo) | E, M (10 execuções idênticas comparadas) |
| V (execução não conectada) | A (ALLOW → `PLAN_CREATED_EXECUTOR_NOT_CONNECTED`) |
| W (ausência de efeitos externos) | A + K (imports) + J (engine corrompido nunca chamado) |
| X, Y (sem mutação de products/registry) | K (imports auditados) + engine corrompido |
| Z (sem Telegram) | K |
| AA (sem Job Queue) | K |
| AB (sem LLM) | K |
| AC (sem secrets no plano) | E (plano carrega somente referências/fingerprint) |
| AD (journal linkage) | A/B (record carrega agent/policy/tool/action/risk/decision/reason/correlation_id) |
| AE (correlation_id preservado) | A/E (plano preserva correlationId do request) |
| AF (schema version preservado) | E/L (schemaVersion 1.0 imutável) |

Além disso: property-like tests de lifecycle (suíte D), **teste crítico de bypass** (suíte J: engine corrompido ALLOW — request inválido e agente desabilitado nunca alcançam o engine), testes estruturais de imports (K), testes de imutabilidade (L) e determinismo (M).

## 16. Gates

| Gate | Resultado |
|---|---|
| `npm test` | **505/505 PASS** (375 anteriores + 130 novos; regressão zero) |
| `tsc --noEmit` | OK |
| `npm run build` | OK |
| `git diff --check` | OK |
| Auditoria de imports/exports | OK (seção 14) |
| Auditoria de efeitos externos | OK (executores não conectados, engine corrompido neutralizado) |

## 17. Arquivos criados

| Arquivo | Papel |
|---|---|
| `server/agentRuntime/types.ts` | Tipos base (Fase A) |
| `server/agentRuntime/contracts.ts` | Contratos; extensão documentada `targetTable` + campos do plano |
| `server/agentRuntime/validation.ts` | Checks estruturais + machine + guard (Fase A) |
| `server/agentRuntime/execution.ts` | execution_id, fingerprint, schema version |
| `server/agentRuntime/lifecycle.ts` | Máquina fechada com transições |
| `server/agentRuntime/idempotency.ts` | Store interface + InMemoryExecutionStore TEST-ONLY |
| `server/agentRuntime/toolAdapter.ts` | Fronteira do adapter (vazia, NOT_CONNECTED) |
| `server/agentRuntime/approval.ts` | Provider interface + NeverApproveProvider |
| `server/agentRuntime/pipeline.ts` | Orquestração de 10 estágios |
| `server/agentRuntime/runtime.ts` | Entry point puro com DI obrigatória |
| `tests/agentRuntimeExecution.test.ts` | 130 testes determinísticos |

## 18. Arquivos modificados

**Nenhum arquivo pré-existente foi modificado.** A única ampliação foi interna ao contrato local do runtime (`contracts.ts`, já não publicado, com extensão documentada de `targetTable` e campos do plano — decisão D-5 do design review preparada, sem alterar registry/engine/journal).

## 19. Produção (verificação somente leitura)

| Verificação | Resultado |
|---|---|
| `/health` frontend | 200, SHA `981a2c9…` |
| `/health` backend | 200, SHA `981a2c9…` |
| `GET /api/products` | 12 produtos, todos `published` (zero mutação) |
| Telegram webhook | 200 imediato (comportamento assíncrono intacto) |
| Banco | não consultado nesta rodada (nada do Bloco 16 foi persistido) |

Nenhuma migration, SQL, commit, push, deploy, alteração de env/secrets ou ativação de agente.

## 20. Agentes

Todos os 9 agentes congelados do registry + security-agent (DRAFT) permanecem `enabled: false`, `status: DRAFT`, com contratos intactos (allowedTools/allowedActions/maxRisk inalterados). Nenhuma permissão foi ampliada. A confirmação foi feita por leitura direta do arquivo `agents.ts` e da tree git.

## 21. Riscos e resíduo

1. **Store em memória:** a idempotência desta fase é exercitável, mas a fronteira `TEST-ONLY` documenta que produção exigirá a `ExecutionStore` real (decisão D-8) — risco de dupla execução **inexistente hoje**, pois o Runtime não tem nenhum caller real (ainda não conectado).
2. **Contexto sem persistence:** sem persistência autorizada, decisões de execução não entram no journal; o linkage está preparado no `RuntimeResult`.
3. **Fingerprint do input:** `inputFingerprint` cobre identidade do contexto relevante; mudanças de campos não-canônicos do input não geram idempotência — comportamento documentado.

## 22. Limitações

- Runtime ainda sem rota HTTP: não há ponto de entrada externo — por design (a conexão será tratada na fase de autorização de rotas).
- `targetTable` opcional com derivação canônica: ambiguidade é negada (`TARGET_TABLE_AMBIGUOUS`).
- Approval real (Operator/PendingApproval) não conectado — somente a abstração.
- Job Queue: o Runtime não toca `job_queue`; a integração futura passará pelo mesmo gate.

## 23. Decisões pendentes

- **D-8 (design review):** quando autorizar persistência do estado de execução (nova migration `agent_executions`) e o caller real do Runtime.
- **D-3:** aprovação real via Operator/PendingApproval — adapter pronto, provider conectado na fase autorizada.
- **D-5:** `targetTable` obrigatório no contrato público — mantido opcional nesta fase, com negação em ambiguidade.

## 24. Próximos passos (dependem de autorização)

1. Fase D: persistência do estado de execução (migration + integration com journal) — requer autorização explícita.
2. Fase E: conexão de Tool Adapters por autorização individual.
3. Fase F: entrada HTTP do Runtime atrás de autenticação.

---

## Decisão recomendada

Publicar o pacote (11 arquivos) em commit único para main, com push + deploy, após sua autorização explícita. Sem a publicação, o core permanece local e sem caller — nenhum risco operacional ativo, mas também sem valor em produção.

**STATUS: READY FOR REVIEW — aguardando autorização explícita.**
