# BLOCO 15 — FASE A — CONTRATO DO AGENT REGISTRY
## RELATÓRIO FINAL — READY FOR REVIEW

**Data:** 16/08/2026, ~02:55 UTC
**Escopo executado:** somente o contrato declarativo do Agent Registry, conforme a autorização da Fase A. Nenhuma rota, nenhum Policy Engine operacional, nenhum decision journal, nenhuma migração, nenhuma escrita em produção, nenhum commit/push/deploy.

---

## 1. Baseline (verificada antes e depois)

| Item | Antes | Depois | Status |
|---|---|---|---|
| Produção (`/health`) | `f75eff4` ok | `f75eff4` ok | ✔ intacta |
| Products (banco) | 12 | 12 | ✔ idênticos |
| Products (IDs canônicos) | baseline dos 12 | mesma lista de IDs | ✔ paridade |
| `public/data/products.json` | md5 `80593c3f019f71eefb63962b8b9c8be2` | md5 idêntico | ✔ inalterado |
| `job_queue` | 0 | 0 | ✔ intacta |
| Cliques reais | 14 | 14 | ✔ preservados |
| Observações Bloco 13 | 0/0/0/0 | 0/0/0/0 | ✔ sem resíduos |
| Commercial Brain Bloco 14 | 0/0 | 0/0 | ✔ sem resíduos |
| Operator | READY | READY | ✔ intacto |
| Incidentes operacionais | 24 | 26 (+2 naturais) | ✔ legítimos |
| Telegram | webhookConfigured=false, apiHealthy=false | idem | ✔ fora de escopo, inalterado |
| Working tree | limpa | novos arquivos (não commitados) | ✔ sem modificações de código existente |
| Migrations aplicadas | nenhuma nova | nenhuma nova | ✔ confirmado |
| Operações de produção | — | nenhuma executada | ✔ cumprido |

Os 2 incidentes a mais (INC-3440 `Telegram_DOWN`/`Unauthorized` e INC-3442 `Site_DEGRADED`/`fetch failed`, 02:40 UTC, fonte `cerberusOperator`) são o comportamento natural do watchdog contra a divergência conhecida do webhook do Telegram — ocorridos durante as verificações de /health, sem qualquer relação com o código do Bloco 15.

## 2. Arquivos criados/modificados

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `server/agentRegistry/types.ts` | criado | tipos, catálogos fechados, versão do contrato |
| `server/agentRegistry/agents.ts` | criado | registros congelados dos 9 agentes, leitor read-only |
| `tests/agentRegistry.test.ts` | criado | 30 testes determinísticos (24 validações obrigatórias do prompt + 6 estruturais) |
| `BLOCO15_DESIGN_REVIEW.md` | criado (Fase 0) | design aprovado |

**Nenhum arquivo existente foi modificado.** `server.ts`, Telegram, Operator, watchdog, lifecycle, job_queue, productsRepository e catálogo permanecem byte-a-byte inalterados.

## 3. Contrato final do Agent Registry

O contrato é definido em `types.ts` como tipos fechados + constantes `Object.freeze`, com duas versões congeladas:

```
AGENT_REGISTRY_CONTRACT_VERSION = "1.0"
AGENT_REGISTRY_POLICY_VERSION   = "1.0"
```

`AgentDefinition` contém exatamente os campos do modelo aprovado: `agentId`, `version`, `role`, `description`, `status`, `enabled`, `allowedTools`, `allowedTables`, `allowedActions`, `maxRisk`, `tokenBudget`, `timeBudgetMs`, `memoryScope`, `policyVersion`. O registry expõe apenas `getAgent(id)`, `listAgents()` e a constante `AGENT_REGISTRY` — **sem nenhuma função de registro em runtime**.

## 4. Agentes registrados (exatamente os 9 previstos)

| Agente | agentId | Tools | Tables | Actions | maxRisk | Memory scope |
|---|---|---|---|---|---|---|
| Discovery | `discovery-agent` | catalog.read, observations.read | products, product_clicks | READ_PRODUCT, READ_OBSERVATION | LOW | PRODUCT, OBSERVATIONS |
| Research | `research-agent` | commercial.signals.read | commercial_signals, commercial_artifacts | READ_COMMERCIAL_SIGNAL, READ_COMMERCIAL_ARTIFACT | LOW | COMMERCIAL_SIGNALS, COMMERCIAL_ARTIFACTS |
| Product Analyst | `product-analyst` | products.read, commercial.analyze | products, product_clicks | READ_PRODUCT, ANALYZE_PRODUCT | LOW | PRODUCT |
| Curator | `curator-agent` | commercial.recommend, lifecycle.read | commercial_signals, commercial_artifacts | READ_COMMERCIAL_SIGNAL, READ_COMMERCIAL_ARTIFACT | LOW | COMMERCIAL_SIGNALS, COMMERCIAL_ARTIFACTS |
| Pricing Analyst | `pricing-analyst` | commercial.signals.read | commercial_signals, commercial_artifacts | READ_COMMERCIAL_SIGNAL, READ_COMMERCIAL_ARTIFACT | LOW | COMMERCIAL_SIGNALS |
| Marketing Analyst | `marketing-analyst` | observations.read | product_clicks | READ_PRODUCT, READ_OBSERVATION | LOW | PRODUCT, OBSERVATIONS |
| Analytics Analyst | `analytics-analyst` | operational.read, job_queue.read | operational_events, job_queue | READ_OPERATIONAL_EVENT, READ_JOB_QUEUE | LOW | OPERATIONAL_EVENTS, JOB_QUEUE |
| Reliability | `reliability-agent` | operational.read | operational_events, operational_incidents, operational_recovery_attempts, operator_state | READ_OPERATIONAL_EVENT | LOW | OPERATIONAL_EVENTS, OPERATIONAL_OPERATIONS |
| Security | `security-agent` | operational.read, operator.mode.read | operational_events, operator_state | READ_OPERATIONAL_EVENT | LOW | OPERATIONAL_EVENTS |

Todos os 9 agentes estão com `status: "DRAFT"` e `enabled: false` — `enabled` é declarativo e não representa execução automática. Nenhuma permissão foi inventada: quando uma capacidade não estava explicitamente definida, a lista ficou vazia (default deny). Ações de risco acima do piso de LOW (DELETE_PRODUCT, UPDATE_PRICE, RUN_RECOVERY, PUBLISH_PRODUCT, SEND_TELEGRAM, ENQUEUE_JOB, UPDATE_PRODUCT) permanecem fora das listas permitidas — o teste estrutural prova que nenhuma ação permitida excede o `maxRisk` do seu agente.

## 5. Catálogos fechados utilizados

**15 tools** (`AGENT_TOOL_CATALOG`): catalog.read, observations.read, commercial.analyze, commercial.recommend, commercial.signals.read, job_queue.read, job_queue.enqueue, telegram.send, telegram.status, products.read, products.write, operational.read, operator.approve, operator.mode.read, lifecycle.read. **16 actions** (`AGENT_ACTION_CATALOG`) com risco mínimo por ação (`AGENT_ACTION_MIN_RISK`), e.g. DELETE_PRODUCT=CRITICAL, RUN_RECOVERY=CRITICAL, ENQUEUE_JOB=MEDIUM. **14 tabelas reais** (`AGENT_TABLE_CATALOG`), auditadas em produção. **7 memory scopes** (`AGENT_MEMORY_SCOPE_CATALOG`).

## 6. Política de risco

Vocabulário único reutilizado do sistema existente: `LOW < MEDIUM < HIGH < CRITICAL` (`AGENT_RISK_ORDER`, consistente com `AutoHealRisk` do Safe Auto-Heal Engine). Regra: ação com risco acima do `maxRisk` do agente é bloqueada — comprovada por teste estrutural sobre todos os 9 agentes. Todos os agentes desta fase operam com teto LOW, o piso máximo de defesa.

## 7. Versionamento

Contrato `1.0`, política `1.0`, versão de cada agente `1.0`. Todos congelados; mudança = novo commit em `main` com revisão humana. Teste estrutural prova que versões são explícitas e semânticas.

## 8. Testes realizados

`tests/agentRegistry.test.ts`: **30 testes, 30 passando** (suíte completa: 254, 254 passando). Cobertura das 24 validações obrigatórias: campos obrigatórios (1–4), max_risk válido (5), catálogos fechados de tools/actions/tables/scopes (6–11), imutabilidade do registry e das permissões com prova de tentativa de mutação sem efeito (12–13, 15), ausência de função de registro (14), ausência de executores de ações (16), auditoria de imports por arquivo contra job_queue/Telegram/products/catálogo/rotas/autoridade nova (17–22), determinismo de `listAgents`/`getAgent` e default deny para agente inexistente (23), versões explícitas (24), adicional: enabled=false em todos, nenhuma ação excede maxRisk, campos obrigatórios presentes, detecção de registry inválido não silenciosa.

## 9. Gates

| Gate | Resultado |
|---|---|
| npm test | 254/254 passando |
| npx tsc --noEmit | limpo |
| npm run build | ok |
| git diff --check | limpo |
| production untouched | 12 produtos, catálogo md5 idêntico, job_queue=0, Telegram/Operator inalterados, nenhuma migration nova, nenhuma escrita |

## 10. Provas de imutabilidade, ausência de autoridade e de execução

**Imutabilidade:** `AGENT_REGISTRY` e todos os campos `allowed_*` são `Object.freeze`; testes tentam `push` via `Array.prototype.push.call` e sobrescrever `maxRisk` — todos lançam; o registro permanece byte-a-byte idêntico após a tentativa. **Ausência de autoridade:** nenhum import de Supabase, Operator, autoHeal, guards, requireAdminAuth, productsRepository, categoriesRepository, catalogSync; auditoria de imports é feita por arquivo com comentários removidos (distinguindo nomes declarativos legítimos do catálogo de dependências reais). **Ausência de execução:** nenhum export com nome de executor (execute/run/dispatch/perform/invoke/apply); nenhum registro de rotas Express; o módulo só exporta `AGENT_REGISTRY`, `getAgent`, `listAgents`.

## 11. Divergências

Nenhuma divergência introduzida pela Fase A. Registro de contexto: os 2 incidentes novos em produção são do watchdog/Telegram (divergência conhecida desde o Bloco 14) e não têm relação com este código.

## 11B. Correção contratual do curator-agent (aplicada na Fase B)

Durante a implementação do Policy Engine, os testes expuseram que o contrato declarado do `curator-agent` era internamente incoerente: suas `allowedActions` (`READ_COMMERCIAL_SIGNAL`, `READ_COMMERCIAL_ARTIFACT`) mapeiam exclusivamente à tool `commercial.signals.read` pelo `ACTION_TOOL_MAP`, tool que não estava entre suas `allowedTools` — tornando qualquer request legítimo do curador inexecutável por construção (`TOOL_NOT_ALLOWED`). A correção (Fase B) tornou `allowedTools` do curador `[commercial.signals.read]`, removendo `lifecycle.read` (sem action compatível, DRAFT) e `commercial.recommend` (tool de `CREATE_RECOMMENDATION`, que o curador não possui). Nenhuma permissão foi ampliada: `enabled: false`, `maxRisk: LOW` e actions/tables inalteradas. A tabela da seção 4 deste documento reflete o estado pré-correção; a versão em vigor está no código atual.

## 12. Riscos residuais

O registry contém nomes de catálogo que citam capacidades externas (telegram.send/status, job_queue.enqueue, operator.approve, operator_state) — são strings declarativas inofensivas, e os testes comprovam que não há dependência real desses módulos. A permissão `ENQUEUE_JOB`/`job_queue.enqueue` declarada ao analytics-analyst é descritiva e bloqueada por maxRisk LOW; nenhum job pode ser criado até que uma política futura eleve o teto com aprovação. O contrato não tem validação de loading em runtime além dos testes determinísticos (decisão deliberada: validação acontece na suíte de testes, que garante falha no carregamento se qualquer regra for violada).

## 13. Pontos que exigem decisão (próximas fases)

Fase B (Policy Engine como avaliador puro — já desenhado na Fase 0, aguarda autorização); Phase D (rota read-only `/api/policy/evaluate` e decision journal — Fase C); e a calibração de riscos por `JobQueueType` quando agentes reais solicitarem enfileiramento.

---

## GATES FINAIS DA FASE A — TODOS VERDES

**BLOCO 15 — FASE A — READY FOR REVIEW**

AGENTS REGISTRY != AGENT EXECUTION · POLICY != AUTHORITY · PERMISSION != ACTION · RECOMMENDATION != ACTION · MEMORY != AUTHORITY

*Aguardando autorização explícita antes de qualquer Fase B.*
