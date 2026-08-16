# BLOCO 15 — FASE B — POLICY ENGINE
## RELATÓRIO FINAL — READY FOR REVIEW

**Data:** 16/08/2026, ~03:30 UTC
**Escopo executado:** somente o avaliador determinístico de política (Policy Engine), conforme o design aprovado na Fase 0 e a autorização da Fase B. Função pura, sem rotas, sem persistência, sem decision journal, sem migração, sem escrita em produção, sem commit/push/deploy. A tabela de agentes do Curator foi corrigida em contrato durante a execução (seção 7) — a mudança é declarativa, local e coberta pelos testes.

---

## 1. Baseline (verificada antes e depois)

| Item | Antes | Depois | Status |
|---|---|---|---|
| Produção (`/health`) | `f75eff4` ok | `f75eff4` ok | ✔ intacta |
| Products (banco, fonte canônica) | 12 | 12 | ✔ idênticos |
| Products (lista de IDs) | baseline dos 12 | mesma lista | ✔ paridade |
| `public/data/products.json` | md5 `80593c3f019f71eefb63962b8b9c8be2` | md5 idêntico | ✔ inalterado |
| `job_queue` | 0 | 0 | ✔ intacta |
| Cliques reais | 14 | 14 | ✔ preservados |
| Observações Bloco 13 | 0/0/0/0 | 0/0/0/0 | ✔ sem resíduos |
| Commercial Brain Bloco 14 | 0/0 | 0/0 | ✔ sem resíduos |
| Operator (`/api/telegram/status`) | READY | READY | ✔ intacto |
| Telegram | `webhookConfigured=false`, `apiHealthy=false` (divergência conhecida) | idem | ✔ fora de escopo, inalterado |
| Backend SHA servido | `f75eff4…` | `f75eff4…` | ✔ idêntico |
| Working tree | arquivos Fase A não commitados | + arquivos Fase B (não commitados) | ✔ sem modificações de código existente |
| Migrations aplicadas | nenhuma nova | nenhuma nova | ✔ confirmado |
| Operações de produção | — | nenhuma executada | ✔ cumprido |

## 2. Arquivos criados/modificados

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `server/policyEngine/types.ts` | criado | tipos do avaliador, reason codes versionados (`POLICY_ENGINE_VERSION`, `POLICY_ENGINE_REASON_CODE_VERSION`), `PolicyRequest`/`PolicyDecision` |
| `server/policyEngine/toolActionMap.ts` | criado | mapa fechado de compatibilidade tool/action (16 ações → 1 tool única cada) + derivada pura `toolAllowedActions()` |
| `server/policyEngine/policyEngine.ts` | criado | avaliador puro `evaluatePolicy(input, clockProvider)` — cadeia de 9 verificações |
| `tests/policyEngine.test.ts` | criado | 39 testes determinísticos (30 validações do prompt + 9 estruturais) |
| `server/agentRegistry/agents.ts` | **modificado (contrato)** | correção do contrato do curator-agent (seção 7) |

**Nenhum outro arquivo existente foi modificado.** `server.ts`, Telegram, Operator, watchdog, lifecycle, job_queue, productsRepository, commercialBrain e catálogo permanecem byte-a-byte inalterados. Nenhuma rota foi registrada — o engine é alcançável apenas como import de módulo (limitação conhecida da Fase B, decidida na Fase 0, D-2).

## 3. Arquitetura do Policy Engine

O avaliador é uma **função pura**: recebe `(PolicyRequest, ClockProvider)` e devolve `PolicyDecision`. Não há I/O, não há estado global mutável, não há dependência de banco, rede, Express, Supabase ou Telegram — a auditoria de imports (testes 31) prova a ausência por regex sobre os arquivos fontes com comentários removidos.

A cadeia de decisão executa **9 verificações ordenadas**, cada uma com `checks` próprio (`PASS`/`FAIL`) e interrupção imediata no primeiro `DENY` com reason code explicável:

| # | Check | Bloqueia com |
|---|---|---|
| 1 | `REQUEST_VALID` — request malformado/campo vazio | `REQUEST_INVALID` |
| 2 | `RISK_VALID` — risk fora do vocabulário `LOW/MEDIUM/HIGH/CRITICAL` | `RISK_UNKNOWN` |
| 3 | `AGENT_EXISTS` — agente registrado | `AGENT_NOT_FOUND` |
| 4 | `VERSION_MATCH` — `agentVersion` + `policyVersion` conferem | `AGENT_VERSION_MISMATCH` / `POLICY_VERSION_MISMATCH` |
| 5 | `TOOL_ALLOWED` — tool no catálogo e nas `allowedTools` | `TOOL_UNKNOWN` / `TOOL_NOT_ALLOWED` |
| 6 | `ACTION_ALLOWED` — action no catálogo e nas `allowedActions` | `ACTION_UNKNOWN` / `ACTION_NOT_ALLOWED` |
| 7 | `TOOL_ACTION_COMPAT` — ação só com sua tool declarada única | `TOOL_ACTION_MISMATCH` |
| 8 | `SCOPE_ALLOWED` — `targetTable` + `memoryScope` nas listas do agente | `TABLE_UNKNOWN` / `TABLE_NOT_ALLOWED` / `MEMORY_SCOPE_UNKNOWN` / `MEMORY_SCOPE_NOT_ALLOWED` |
| 9 | `RISK_FLOOR` — risk ≤ `maxRisk` do agente e ≥ piso da ação; `APPROVAL_STATE` conforme política | `RISK_EXCEEDS_MAX` / `ACTION_RISK_MISMATCH` / `APPROVAL_REQUIRED`/`APPROVAL_REJECTED`/`APPROVAL_EXPIRED` |
| 10 | `ENABLED_GATE` — agente habilitado? | `AGENT_DISABLED` |

O catch-all final é `DENY` (`POLICY_DENY`): **nenhum caminho pode cair em "provavelmente permitido"**. A decisão carrega `decision`, `reasonCode` (catalogado e versionado), `reason` em linguagem natural (formato declarativo: afirma o que NÃO aconteceu), `checks`, `evaluationId` determinístico (derivado do input + versão da lógica), `evaluatedAt` do clock fornecido e `policyVersion`. O reason code tem catálogo próprio versionado (`POLICY_ENGINE_REASON_CODE_VERSION`) — alteração da semântica de códigos exige nova versão, conforme o padrão do Bloco 14.

A correção da Fase A (`RISK_UNKNOWN` movido para o início da cadeia) se confirma aqui: risco fora do vocabulário agora **nunca** chega a causar exceção interna; é um `DENY` explicável com `checks.risk = FAIL`.

## 4. Integração com o Agent Registry (Fase A)

O engine importa apenas os tipos e as listas congeladas do registry — sem acoplamento a execução. Duas regras de governança herdadas: **DEFAULT DENY** (tudo o que não é permitido é negado) e **RISK FLOORING** (piso de risco por ação em `AGENT_ACTION_MIN_RISK`, p.ex. `PUBLISH_PRODUCT = HIGH`, `RUN_RECOVERY = CRITICAL`, `CREATE_RECOMMENDATION = MEDIUM`). A permissão da action nunca pode estar abaixo do piso da categoria — testado estruturalmente.

## 5. Correção contratual do Curator Agent (única mudança na Fase A)

Durante a implementação, os testes expuseram uma **incoerência no contrato declarado** do `curator-agent` (agente DRAFT): suas `allowedActions` (`READ_COMMERCIAL_SIGNAL`, `READ_COMMERCIAL_ARTIFACT`) mapeiam, pelo `ACTION_TOOL_MAP`, exclusivamente à tool `commercial.signals.read`, que **não** estava entre suas `allowedTools` (`commercial.recommend`, `lifecycle.read` na época). Um contrato assim é **inexecutável por construção** — qualquer request legítimo do curador cairia em `TOOL_NOT_ALLOWED` mesmo antes do gate de habilitação.

A correção aplica o princípio do **contrato fechado** (cada action pertence a exatamente uma tool): `allowedTools` do curador passou a `[commercial.signals.read]`, removendo `lifecycle.read` (sem action compatível ainda — permanece DRAFT) e `commercial.recommend` (tool da action `CREATE_RECOMMENDATION`, que o curador não possui). **Nenhuma permissão foi ampliada**: o curador continua com `enabled: false`, `maxRisk: LOW` e as mesmas actions/tables — a mudança apenas torna o contrato internamente consistente. Todos os 69 testes da Fase A + B seguem passando, incluindo as auditorias estruturais da Fase A, e o relatório da Fase A está atualizado com a observação desta correção (o contrato descrito naquele documento reflete o estado pré-correção; a versão em vigor é esta).

## 6. Teorema central comprovado: avaliar política ≠ executar ação

O caminho `ALLOW` da cadeia (após o gate `ENABLED`) existe no código e é coberto por teste de unidade, mas **nenhum agente real da Fase A pode atingi-lo** — todos os 9 agentes estão com `enabled: false` (default deny operacional). Os testes provam: (a) com request totalmente válido e agente com as permissões, a decisão chega negada por `AGENT_DISABLED` com os 9 checks anteriores em `PASS`; (b) nenhuma avaliação altera o registry (testes tentam mutação pós-avaliação e comparam referências byte-a-byte); (c) nenhum export do engine executa, persiste, enfileira ou envia; (d) `reason` de nenhuma decisão afirma execução (regex estrutural que exclui os negados declarativos como "no action executed").

## 7. Cobertura de testes — 39 testes, 39 passando

As 30 validações do prompt estão cobertas: reason codes de cada etapa da cadeia (1–16), piso de risco (17), combinação válida (18), approval state (19–22), determinismo com clock fixo (23–24), explicabilidade (25–26), self-modification sem efeito (27–28), privilege escalation via request citando permissões de outro agente (29), agent impersonation (30) — mais 9 testes estruturais: auditoria de imports sem Supabase/Express/Telegram/Operator/jobQueue/lifecycle/autoHeal/LLM (31), catálogo de reason codes fechado e versionado (32), ausência de exports executáveis no engine (33), imutabilidade de `toolActionMap` e sua derivada pura (34), determinismo do `evaluationId` (35), monotonia do `riskIndex` (36), `toolAllowedActions` cobre todas as tools com actions (37), reason codes únicos e sem colisão (38), e cobertura de 100% dos reason codes do catálogo em pelo menos um teste (39).

## 8. Gates finais

| Gate | Resultado |
|---|---|
| npm test | **293/293 passando** (19 suítes, incluindo 30 Fase A + 39 Fase B + suíte de produção 254) |
| npx tsc --noEmit | limpo |
| npm run build | ok (dist gerado, sem erros) |
| Working tree | novos arquivos não commitados; nenhum código existente modificado além do contrato do curator-agent |
| production untouched | 12 produtos, catálogo md5 idêntico, job_queue = 0, Telegram/Operator inalterados, nenhuma migration nova, nenhuma escrita |

## 9. Divergências

Nenhuma divergência introduzida pela Fase B. Registro de contexto já presente desde o Bloco 14: webhook do Telegram desconfigurado (`webhookConfigured: false`, `webhookLastError: Unauthorized`) — o estado `READY` do Operator é mantido por fallback resiliente. Fora do escopo do Bloco 15.

## 10. Riscos residuais

O engine avalia, mas **não controla a execução** — os call sites reais (enqueue, publish, send) ainda não consultam o engine; ele permanece um observador até a Fase D (integração read-only), documentado como limitação conhecida. O caminho `ALLOW` é atingível somente por agente `enabled=true` (inexistente na Fase A); quando a Fase D o expuser via rota, a rota exigirá autenticação administrativa (`x-admin-password`), no mesmo padrão do Bloco 14. A incoerência do contrato do curador corrigida (seção 5) mostra que contratos declarativos exigem validação cruzada contínua — os testes estruturais da Fase A já capturariam futuros casos (cobertura do reason `TOOL_NOT_ALLOWED` por agente incoerente agora é explícita no teste 2).

## 11. Próximas autorizações necessárias

**Fase C (Decision Journal)** — persistir decisões de avaliação em `policy_evaluations` (migration aditiva, RLS ON, zero policies públicas, FKs explícitas, sem backfill), somente se a trilha auditável for justificada; e **Fase D (Integração)** — rota read-only `POST /api/policy/evaluate` com admin-auth e hook points de consulta nos mecanismos existentes, sem acoplamento. Sem autorização, o Bloco 15 permanece em READY FOR REVIEW e nenhuma fase adicional é iniciada.

---

## GATES FINAIS DA FASE B — TODOS VERDES

**BLOCO 15 — FASE B — READY FOR REVIEW**

POLICY != EXECUTION · EVALUATION != ACTION · RECOMMENDATION != ACTION · AGENT != AUTHORITY · MEMORY != AUTHORITY · DEFAULT DENY · DECLARED IDENTITY · RISK FLOORING

*Aguardando autorização explícita antes de qualquer Fase C ou D.*
