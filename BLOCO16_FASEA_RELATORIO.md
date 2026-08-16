# BLOCO 16 — FASE A — CONTRATO DO AGENT RUNTIME

**Projeto:** Cerberus Finds Archive (cerberus-forge-deploy)
**Data:** 16 de agosto de 2026
**Autor:** Manus AI
**Status:** **READY FOR REVIEW** — contrato local, sem commit, sem push, sem deploy, sem migration, sem produção alterada, sem agentes habilitados, sem executores conectados.

---

## 1. Escopo autorizado e o que esta fase NÃO é

A Fase A do Bloco 16 implementa exclusivamente o **contrato tipado e determinístico do Agent Runtime**: os tipos, interfaces e funções puras de validação que definirão como toda execução futura de agente será conduzida. Conforme a autorização recebida e o design review (BLOCO16_DESIGN_REVIEW.md, decisão D-6), o runtime **não possui rota HTTP pública nesta fase** — é um módulo TypeScript puro, sem Express, sem Supabase, sem Telegram, sem Operator runtime, sem Job Queue runtime, sem SafeAutoHeal, sem LLM e sem filesystem. Nenhuma execução de agente foi ativada: os nove agentes do registry permanecem com `status: "DRAFT"` e `enabled: false`. Nenhum executor real foi conectado.

## 2. Arquivos criados e modificados

| Arquivo | Natureza | Conteúdo |
|---|---|---|
| `server/agentRuntime/types.ts` | Criado | Tipos e catálogos congelados: `ExecutionLifecycleState` (13 estados, catálogo `Object.freeze`), `ApprovalDecisionState`, `BudgetContract`, `MemoryScopeContract`, `ApprovalContract`, `ArtifactContract`, `ArtifactProvenance`, `ToolAdapterContract`, `ExecutionLifecycleStates` e `AGENT_RUNTIME_CONTRACT_VERSION = "1.0"` |
| `server/agentRuntime/contracts.ts` | Criado | Interfaces formais: `AgentRuntimeRequest` (9 campos críticos obrigatórios), `PolicyDecisionRecord`, `ExecutionPlan`, `ExecutionResult`, `ExecutionIntent`, `LifecycleTransition`, `ExecutionAuditView`, `ArtifactSchemaValidation`, `AgentIdentityCheck` |
| `server/agentRuntime/validation.ts` | Criado | Funções puras: `checkAgentIdentity`, `validateRequest`, `checkMemoryScope`, `checkBudget`, `guardDecisionFlow`, `canTransition` (tabela fechada de 16 transições), `deriveIntentionKey`, catálogos de reason codes (`RUNTIME_REASON_CODES`, 17 codes fechados) |
| `tests/agentRuntime.test.ts` | Criado | 42 testes determinísticos (zero banco, zero HTTP), 42/42 passando |
| `server/agentRegistry/types.ts` | Não modificado | Apenas importação de tipos estáticos |
| `server/policyEngine/*` | Não modificado | Apenas importação de `PolicyDecision` e `ACTION_TOOL_MAP` |

Todos os arquivos de contrato são **imutáveis por construção**: catálogos com `Object.freeze`, retornos de validação com `Object.freeze`, sem setters, sem estado interno.

## 3. Princípios aplicados

O contrato é **default deny em todos os pontos de decisão**. O `validateRequest` rejeita qualquer campo crítico ausente ou fora do catálogo fechado; `checkAgentIdentity` exige, simultaneamente, agente conhecido, versão coincidente, agente habilitado, action no `allowedActions`, tool no `allowedTools` e compatibilidade com o `ACTION_TOOL_MAP` do Policy Engine (qualquer incompatibilidade = `TOOL_ACTION_MISMATCH`); `checkMemoryScope` exige `requested ⊆ allowed`; `checkBudget` aplica a semântica da decisão D-1 (zero = não alocado = fail-closed, com rejeição também de valores negativos); `guardDecisionFlow` proíbe matematicamente qualquer transformação de `DENY → ALLOW` e de `REQUIRES_APPROVAL` não aprovado em execução. A máquina de estados de lifecycle é fechada: apenas as 16 transições da `TRANSITION_TABLE` são válidas — caminhos perigosos como `DENIED → PLANNED`, `SUCCEEDED → RUNNING` e `EXPIRED → PLANNED` são rejeitados por default deny.

## 4. Revalidação das decisões D-1 a D-8

| Decisão | Tratamento na Fase A |
|---|---|
| D-1 (0 = sem orçamento, fail-closed) | **Aplicado**: `checkBudget` rejeita qualquer campo ≤ 0; `validateRequest` rejeita negativos; o runtime nunca amplia budget |
| D-2 (ampliar catálogo do reliability-agent) | **Adiado deliberadamente**: ampliar `AGENT_ACTION_CATALOG` do Bloco 15 é fora do escopo do contrato; o runtime trata actions não catalogadas como DENY, preservando o catálogo congelado |
| D-3 (Operator no journal) | **Adiado com contrato preparado**: o campo `requestedBy` aceita o namespace `operator`/`operator-admin` sem modificar o registry; a persistência no journal fica para fase futura |
| D-4 (aprovação humana) | **Contrato fechado**: `ApprovalContract` com `approvalId`, `expiresAt`, `state` e ligação explícita ao `policyEvaluationId` |
| D-5 (tabela agent_artifacts) | **Referência, sem storage**: `ArtifactContract` carrega `contentReference: {kind:"by-ref"|"none"}` — nunca conteúdo bruto; a migration é fase futura |
| D-6 (rota interna, sem HTTP) | **Aplicado**: nenhum Express, nenhuma rota; o runtime é módulo |
| D-7 (validador de artifact por tipo) | **Contrato definido**: `ArtifactSchemaValidation` por `artifact_type`/`schema_version`; a implementação por tipo é fase futura |
| D-8 (execution_id no journal) | **Contrato definido**: `ExecutionResult` com `resultReference`; a escrita no journal é fase futura |

## 5. Gates e verificação

Os gates locais foram executados integralmente. A suíte completa roda agora com **375 testes, 375 passando, 0 falhando** (333 anteriores + 42 novos do contrato). O TypeScript compila sem erros (`npx tsc --noEmit`), o build do Express fecha em ~15 ms, `git diff --check` não reporta problemas e a working tree contém apenas os arquivos novos da fase mais os `pnpm-*` não rastreados pré-existentes.

A produção foi verificada somente por leitura. O `/health` responde 200 nas duas instâncias (frontend e backend) servindo o SHA `981a2c9`, idêntico ao branch `main` e ao `origin/main`. O catálogo devolve os **12 produtos canônicos published**, sem criação, alteração ou exclusão. Nenhuma requisição de escrita foi enviada a nenhuma rota de produção.

| Gate | Resultado |
|---|---|
| npm test | 375/375 pass |
| tsc | sem erros |
| build | ok (esbuild, ~15 ms) |
| diff-check | ok |
| Working tree | sem alterações de código do Bloco 15 ou anterior |
| Produção /health (2 instâncias) | 200, SHA 981a2c9 |
| Produtos em produção | 12/12 published |
| Registry em produção | 9 agentes DRAFT, enabled false (inalterado) |

## 6. Divergências encontradas e corrigidas durante a fase

Duas divergências foram encontradas e corrigidas dentro do escopo da fase. A primeira foi um bug no próprio contrato em desenvolvimento: a validação de budget aceitava números finitos negativos (`Number.isFinite(-1) === true`), o que contrariava o fail-closed; corrigido para rejeitar valores negativos no `validateRequest` (mantendo zero como "não alocado", rejeitado no `checkBudget`). A segunda foi a descoberta de que a combinação `READ_PRODUCT + catalog.read` — usada na fixture inicial — é deliberadamente `TOOL_ACTION_MISMATCH` pelo `ACTION_TOOL_MAP` do Bloco 15 (READ_PRODUCT mapeia para `products.read`); as fixtures de teste foram alinhadas ao catálogo congelado. Nenhuma mudança foi feita no catálogo do Bloco 15: ele permanece a fonte da verdade.

## 7. Pendências para autorização

A Fase A está pronta para revisão. A publicação (commit + push + deploy) requer sua autorização explícita e, quando concedida, seguirá o protocolo de consolidação padrão: commit único descritivo, push sem force, aguardo do deploy do Render, validação de `/health` nas duas instâncias, confirmação dos 12 produtos e entrega de relatório final. As fases seguintes (B: runtime de decisão que consome o engine como único caller; C: approval flow com o Operator; D: Tool Adapters; E: persistência e fechamento do loop) **não foram iniciadas** e permanecem dependentes de revisão e autorização.

MEMORY != AUTHORITY · OBSERVATION != FACT CANÔNICO · RECOMMENDATION != ACTION · AGENT != AUTHORITY
