# BLOCO 15 — POLICY ENGINE + AGENT REGISTRY
## FASE 0 — DESIGN REVIEW / AUDITORIA
### READY FOR REVIEW

**Data:** 16/08/2026, ~02:40 UTC
**Autor:** Manus AI (sob governança Cerberus)
**Escopo desta fase:** somente auditoria e design. Nenhum código, commit, push, deploy, migration ou escrita em produção foi executado.

---

## 1. Estado atual auditado

A auditoria foi realizada contra o repositório local sincronizado com `origin/main`, o ambiente de produção no Render e o banco Supabase em tempo real. Nenhum valor foi presumido; cada afirmação abaixo foi verificada por consulta direta.

| Item auditado | Valor verificado | Fonte |
|---|---|---|
| SHA em produção (`/health`) | `f75eff4c2721c174346d7f536fadffda2c4d25aa` | Render |
| SHA local (`HEAD`) | `f75eff4…` (idêntico ao remoto) | `git rev-parse HEAD` / `origin/main` |
| Working tree | **Limpa** (sem alterações pendentes) | `git status --porcelain` |
| Divergência local/remoto | Nenhuma | `git fetch origin` + rev-parse |
| Produtos canônicos | **12**, catálogo íntegro | `SELECT COUNT(*) FROM public.products`; `/api/products` |
| Categorias | 2 (`catalog_categories`) | SQL |
| Cliques reais preservados | 14 (`product_clicks`) | SQL |
| Job queue | **0 registros**; scheduler desligado por padrão (`enabled: false`, `JOB_QUEUE_ENABLED` não configurado) | SQL + `jobQueueScheduler.ts` |
| Observações Bloco 13 (`*_observed`) | 0/0/0/0 nas 4 tabelas — intactas | SQL |
| Commercial Brain Bloco 14 (`signals`/`artifacts`) | 0/0 — memória analítica limpa, sem resíduos | SQL |
| Eventos operacionais | 0 | SQL |
| Incidentes operacionais | 24 (histórico preservado, não tocaremos) | SQL |
| Operator state (tabela do circuito) | 0 registros; `operatorState=READY` em produção | SQL + `/api/telegram/status` |
| Recovery attempts | 0 | SQL |

Duas divergências conhecidas e já registradas no Bloco 14 permanecem documentadas, sem interferência: o webhook do Telegram está desconfigurado (`webhookConfigured: false`, `webhookLastError: Unauthorized` — causa provável: troca do token do bot) e o estado `READY` do Operator é mantido por fallback resiliente apesar disso. Nenhuma dessas divergências pertence ao escopo do Bloco 15.

## 2. Baseline

O ponto de partida confirmado para o Bloco 15 é: **produção íntegra no SHA `f75eff4`, com Bloco 13 (observações) e Bloco 14 (Cérebro Comercial V1) publicados e consolidados**, 12 produtos canônicos inalterados, catálogo íntegro, job queue existente e persistente (porém dormente), scheduler desligado por padrão, rotas comerciais protegidas por autenticação administrativa (`x-admin-password`), Commercial Brain v1 com versionamento semântico por modelo (`COMMERCIAL_BRAIN_VERSION`, modelos de prioridade, confiança e evidência versionados) e nenhuma autonomia adicional autorizada. A baseline coincide com a apresentada ao usuário ao final do Bloco 14 — **sem divergência detectada**.

## 3. Arquitetura existente relevante (o que JÁ existe e não deve ser duplicado)

A auditoria dos contratos dos Blocos 9–14 identificou mecanismos que o Policy Engine deve integrar conceitualmente em vez de substituir. Esta é a base da decisão "não reinventar".

| Mecanismo existente | Onde | O que oferece ao Policy Engine |
|---|---|---|
| Catálogo fechado de ações de fila | `jobQueueRepository.ts` | `JobQueueType`: `catalog_sync`, `telegram_send`, `product_ingest_review`, `operational_recovery`, `maintenance` — catálogo fechado, versionado (`JOB_SCHEMA_VERSION = "1.0"`), com `idempotencyKey` e `correlationId` |
| Vocabulário de risco | `safeAutoHealEngine.ts` | `AutoHealRisk`: `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` — exatamente o vocabulário fechado de risco que o Bloco 15 precisava |
| Modos de autonomia | `safeAutoHealEngine.ts` + Telegram | `AutoHealMode`: `OBSERVE`, `SAFE_AUTO_HEAL`, `ADMIN_APPROVAL`, `DRY_RUN` — controlado via callbacks `operator_mode:X` no Telegram |
| Aprovação humana | `cerberusOperator.ts` + `telegramBot.ts` | `requestOperatorApproval(actionId, incidentId?, requestedBy)` → `PendingApproval`; `approveOperatorAction(id, adminId)`; callbacks `operator_approve:ID`/`operator_reject:ID`; painel de curadoria `product_approvals:N` |
| Autoria nominal de agentes | `jobQueueRepository.ts` | `JobCreatedBy` já inclui `"agent"` — a job queue já é capaz de atribuir origem agencial |
| Ações seguras registradas | `safeAutoHealEngine.ts` | `SafeAction<T>`: ações previamente registradas, executáveis apenas no modo apropriado; rejeita shell/SQL/secrets/caminhos externos |
| Aprove de produto | `productPipeline.ts` + Lifecycle | `LifecycleRecord` com `status: approved | pendingApproval | …`; `approve(record)` obrigatório para publicar |
| Circuit breaker / watchdog | `operatorStateStore.ts` + `cerberusOperator.ts` | Estados `CLOSED`/`OPEN` persistidos, cooldown de 30 min, `persistenceStatus: READY | SAFE_MODE` |
| Versionamento analítico | `commercialBrain/types.ts` | Precedente de versionamento semântico (brain, priority, confidence, evidence) — o Policy Engine deve seguir o mesmo padrão |
| Guardas operacionais | `operationalGuards.ts` | Rate limiter e orçamento de chamadas externas — precedentes de controle determinístico |

O que **não existe** hoje, e que o Bloco 15 deve criar: (a) registry de agentes com identidade e versão; (b) políticas versionadas e imutáveis por versão; (c) avaliador determinístico de decisão (`ALLOW`/`DENY`/`REQUIRES_APPROVAL`) com explicação estruturada; (d) permissões granulares por tabela/ferramenta; (e) decision journal auditável.

## 4. Agent Registry proposto

O registry será um módulo puro (`server/policy/agentRegistry.ts`) que descreve agentes como **artefatos versionados e imutáveis em memória de contrato**, registrados em código como constantes `Object.freeze`. Nenhum agente será criado por requisição HTTP, por agente ou por qualquer outro mecanismo runtime — a única forma de registrar um agente é alteração de código em `main`, com revisão humana no GitHub. Isso elimina por construção o risco de auto-registro e elevação.

O registro de um agente contém exatamente os campos exigidos pelo prompt, com valores padrão deliberadamente restritivos:

| Campo | Tipo | Padrão/Restrição |
|---|---|---|
| `agentId` | string (slug kebab-case) | obrigatório, único |
| `version` | string semântica | obrigatório |
| `role` | string descritiva | obrigatório |
| `description` | string | obrigatório |
| `status` | `DRAFT` \| `REGISTERED` \| `SUSPENDED` | default `DRAFT` |
| `allowedTools` | `ToolName[]` (catálogo fechado) | default `[]` |
| `allowedTables` | `TableName[]` (catálogo fechado) | default `[]` |
| `allowedActions` | `ActionName[]` (catálogo fechado) | default `[]` |
| `maxRisk` | `LOW` \| `MEDIUM` \| `HIGH` \| `CRITICAL` | default `LOW` |
| `tokenBudget` | número (limite analítico declarativo) | default 0 (zero significa nenhum orçamento declarado) |
| `timeBudgetMs` | número | default 0 |
| `memoryScope` | `MemoryScope[]` (catálogo fechado) | default `[]` |
| `policyVersion` | string semântica | obrigatório, linka à política |
| `createdAt` / `registeredAt` | ISO | automáticos |

Nenhum campo permite autodeclaração em runtime. O registry expõe apenas leitura: `getAgent(agentId)`, `getAgentVersion(agentId, version)`, `listAgents()`. **Não há função de registro dinâmica.**

## 5. Policy Engine proposto

O Policy Engine (`server/policy/policyEngine.ts`) é um avaliador **puro, determinístico e sem efeitos colaterais**: recebe uma `PolicyEvaluationInput` e devolve uma `PolicyDecision` com explicação estruturada. Não executa, não enfileira, não envia, não altera estado.

```
input:  agentId, agentVersion, policyVersion, action, resource,
        context, requestedRisk, approvalState
output: decision ∈ {ALLOW, DENY, REQUIRES_APPROVAL}
        + reason, ruleApplied, policyEvaluated, permissionsFound,
          blockingCondition, requiredApproval (quando aplicável)
        + evaluationId (determinístico, derivável do input),
          evaluatedAt
```

O fluxo de decisão é uma cadeia de verificação ordenada (cada etapa produz explicação própria):

1. **Identidade** — o agente existe? A versão declarada corresponde à registrada? `policyVersion` declarada é a atual? → `DENY` com `reason: "agent_unknown"`, `"version_mismatch"` ou `"policy_version_mismatch"`. Isso cobre **agent impersonation**, **version spoofing** e **policy bypass por versão**.
2. **Status** — agente `DRAFT`/`SUSPENDED`? → `DENY` (`status_not_active`).
3. **Catálogo de ação** — a ação pertence ao catálogo fechado? → `DENY` (`action_unknown`). Isso cobre **action spoofing**.
4. **Permissão explícita** — a ação está em `allowedActions` do agente (considerando sobreposições de escopo de tabela/ferramenta quando a ação exige recurso)? → `DENY` (`action_not_permitted`). Isso cobre **cross-agent permissions**.
5. **Risco** — `requestedRisk > maxRisk` na ordenação `LOW < MEDIUM < HIGH < CRITICAL`? → `DENY` (`risk_exceeds_max`). O agente nunca pode alterar o próprio `maxRisk`: o campo é readonly e só muda por nova versão do registro (código).
6. **Política da ação** — a política associada à ação exige aprovação humana? → `REQUIRES_APPROVAL` com `requiredApproval` descrevendo qual aprovação (mapeando ao mecanismo existente do Operator, seção 10).
7. **Estado de aprovação** — se a avaliação carrega `approvalState`: `PENDING` → `REQUIRES_APPROVAL`; `APPROVED` válido → prossegue; `REJECTED`/`EXPIRED` → `DENY` (`approval_rejected`/`approval_expired`).
8. **Catch-all** — qualquer caminho não coberto → `DENY` (`default_deny`). Nenhuma leitura pode cair em "provavelmente permitido".

O vocabulário de risco reutiliza `AutoHealRisk` (`LOW < MEDIUM < HIGH < CRITICAL`), garantindo consistência com o Safe Auto-Heal Engine existente — o Policy Engine não introduz escala paralela.

## 6. Modelo de dados

Nesta fase, o modelo de dados é **contratual, em TypeScript, sem banco**: os registros de agentes e políticas vivem como constantes versionadas no código (única fonte de autoridade), e as decisões de avaliação são objetos retornados pela função pura. Isso segue a orientação da seção 18 do prompt ("examine se Agent Registry e Policy podem inicialmente existir como contratos versionados") e o precedente do Bloco 14, em que tipos, fórmulas e regras também são contratos versionados em código.

A persistência física só será proposta na Fase C, mediante justificativa concreta. A hipótese mais provável (a ser confirmada em review) é que o **decision journal** (log de avaliações) mereça tabela própria (`policy_evaluations`), enquanto registry e políticas permanecem em código — porque persisti-los em banco criaria uma segunda fonte de autoridade e um vetor de autoelevação que o código não tem.

## 7. Versionamento

Seguindo o precedente do Bloco 14, agentes e políticas usam **versionamento semântico congelado**: cada política é uma constante nomeada com versão (`POLICY_VERSION = "1.0"`), e uma avaliação sempre declara `agentVersion + policyVersion`. Alterar o texto de uma política exige nova constante/nova versão; a antiga permanece no arquivo como histórico comentado ou constante renomeada para `POLICY_VERSION_1_0`. Não existe "atualização silenciosa": o `policyVersion` declarado na avaliação é comparado com a versão registrada do agente; divergência é `DENY`. Decisões são reproduzíveis porque todo o input e toda a lógica são determinísticos e as versões são imutáveis.

## 8. Modelo de risco

Reutilização integral de `AutoHealRisk` (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`), com ordenação total explícita em um único lugar (`RISK_ORDER` no módulo do Policy Engine, derivada do vocabulário existente). Regras: `risk_requested > maxRisk → DENY`; ações de categoria `write/execute/dispatch` herdam risco mínimo `MEDIUM` (configurável por política, nunca abaixo do piso da categoria); `maxRisk` só evolui por nova versão do registro do agente. Nenhum valor arbitrário: o vocabulário foi auditado e já está em produção no Safe Auto-Heal Engine.

## 9. Catálogo de ações

Catálogo fechado e versionado (`ACTION_SCHEMA_VERSION = "1.0"`), unificando as ações nominalmente presentes nos Blocos 9–14 e as do prompt:

| Ação | Categoria | Risco mínimo | Observação |
|---|---|---|---|
| `READ_PRODUCT` | read | LOW | já autorizada implicitamente a qualquer caller admin |
| `READ_OBSERVATION` | read | LOW | Bloco 13 |
| `ANALYZE_PRODUCT` | read | LOW | Bloco 14 (`analyze` é read-only) |
| `READ_COMMERCIAL_SIGNAL` | read | LOW | Bloco 14 |
| `READ_COMMERCIAL_ARTIFACT` | read | LOW | Bloco 14 |
| `READ_JOB_QUEUE` | read | LOW | Bloco 12 |
| `CREATE_RECOMMENDATION` | write | MEDIUM | Bloco 14 exige aprovação administrativa (persist) |
| `CREATE_SIGNAL` | write | MEDIUM | idem |
| `PUBLISH_PRODUCT` | execute | HIGH | pipeline lifecycle: `approve()` obrigatório |
| `UPDATE_PRODUCT` | write | HIGH | admin only |
| `DELETE_PRODUCT` | execute | CRITICAL | proibida por política default |
| `UPDATE_PRICE` | execute | CRITICAL | proibida por política default |
| `SEND_TELEGRAM` | dispatch | HIGH | telegramBot existente; exige modo/autorização |
| `ENQUEUE_JOB` | dispatch | MEDIUM–CRITICAL por `JobQueueType` | catalog_sync=CRITICAL, telegram_send=HIGH, product_ingest_review=HIGH, operational_recovery=CRITICAL, maintenance=MEDIUM (valores propostos, a calibrar em review) |
| `RUN_RECOVERY` | execute | CRITICAL | safeAutoHealEngine exige `ADMIN_APPROVAL` |
| `READ_OPERATIONAL_EVENT` | read | LOW | — |

A existência destes nomes **não os torna executáveis**. O Policy Engine apenas descreve e avalia; a execução permanece nos mecanismos atuais (pipeline, telegramBot, jobQueueScheduler), que o Bloco 15 não modifica.

## 10. Modelo de aprovação

Não criaremos um novo mecanismo de aprovação. O Policy Engine **mapeia seus estados ao mecanismo existente** do Operator/Telegram:

| Estado (Policy Engine) | Mapeamento |
|---|---|
| `NOT_REQUIRED` | ação está em `allowedActions` com risco dentro do limite e a política não exige aprovação |
| `PENDING` | referência a um `PendingApproval` real criado por `requestOperatorApproval` (aproveitamos a infraestrutura do Operator) |
| `APPROVED` | `PendingApproval` aprovado via `operator_approve`/`approveOperatorAction` |
| `REJECTED` | recusado no fluxo existente |
| `EXPIRED` | aprovação existente há mais que o TTL definido pela política (atributo da política, não novo mecanismo) |

O estado `approval_state` passado na avaliação é **validado contra o estado real** no momento da avaliação (o engine consulta `getPendingApprovals()` do Operator quando uma ação exige aprovação), impedindo **approval spoofing** por agente que declare "já fui aprovado".

## 11. Memory scope

Catálogo fechado derivado das tabelas reais auditadas: `PRODUCTS`, `CATALOG_CATEGORIES`, `PRODUCT_CLICKS`, `OBSERVATIONS` (as 4 `_observed`), `COMMERCIAL_SIGNALS`, `COMMERCIAL_ARTIFACTS`, `JOB_QUEUE`, `OPERATIONAL_EVENTS`, `OPERATIONAL_INCIDENTS`, `OPERATIONAL_RECOVERY_ATTEMPTS`, `OPERATOR_STATE`. Regra de ouro: **`allowedTables ≠ acesso automático** — o scope apenas declara o que um agente *poderia* consultar se uma ação de leitura o permitisse; a política continua sendo o gate da ação. Nenhum scope é concedido por conveniência; default `[]`.

## 12. Tool scope

Catálogo fechado de ferramentas, alinhado às capacidades reais do backend, sem criar novas: `catalog.read`, `observations.read`, `commercial.analyze`, `commercial.recommend`, `commercial.signals.read`, `job_queue.read`, `job_queue.enqueue`, `telegram.send`, `telegram.status`, `products.read`, `products.write`, `operational.read`, `operator.approve`, `operator.mode.read`, `lifecycle.read`. Default `[]`. Ferramentas de escrita exigem, adicionalmente, permissão de ação correspondente (duplo gate: tool **e** action).

## 13. Threat model

| Ameaça | Mitigação no design |
|---|---|
| Privilege escalation (agente amplia permissões) | Registry read-only em código; zero função de registro runtime; permissões só por commit em `main` |
| Self-modification (altera política/permissões/max_risk/budgets) | Todos os campos são readonly; nova configuração = nova versão via código; avaliação nunca altera o registry |
| Policy bypass | Cadeia de decisão ordenada com catch-all `DENY`; `policyVersion` obrigatório e verificado |
| Agent impersonation | Identidade verificada por `getAgent()`; sem autenticação por nome — um futuro caller só pode citar um `agentId` que o engine reconheça; decisão nunca confia em declaração não verificada |
| Version spoofing | `agentVersion` e `policyVersion` comparados com registros; mismatch = `DENY` explicável |
| Action spoofing | Catálogo fechado; ação não catalogada = `DENY` |
| Approval spoofing | `approvalState` é validado contra `getPendingApprovals()` do Operator em tempo real |
| Cross-agent permissions | Permissões são por `agentId`; não há herança, grupos ou wildcards |
| Acesso indevido a tabelas | `allowedTables` fechado; sem correspondência = `DENY` mesmo com `ALLOW` de leitura |
| Execução indireta via job_queue | `ENQUEUE_JOB` é uma ação avaliada; `JobQueueType` tem risco próprio (calendário: `catalog_sync`=CRITICAL, `operational_recovery`=CRITICAL); job criado com `createdBy: "agent"` mantém trilha |
| Execução indireta via Telegram | `SEND_TELEGRAM` avaliada; o telegramBot continua exigindo whitelist e modo; o engine não toca o bot |
| Autoaprovação | `operator.approve` como tool exige modo `ADMIN_APPROVAL` real do Operator; o engine nunca aprova sozinho |

## 14. Integração com Commercial Brain (Bloco 14)

O Commercial Brain produz `OPPORTUNITY`, `RISK`, `PRIORITY` e `RECOMMENDATION` — artefatos analíticos que o Policy Engine pode **referenciar como contexto de avaliação**, nunca executar. O caso de uso futuro: "esta recomendação pode virar determinada ação?" — a avaliação recebe o artifact_id como `resource`, o contexto analítico (sem alterar o artefato) e responde `ALLOW`/`DENY`/`REQUIRES_APPROVAL`. Preserva-se `RECOMMENDATION != ACTION`: a decisão do engine não publica, não altera e não dispara nada; apenas diz se uma transformação hipotética passaria pela política. As rotas `/api/commercial/*` do Bloco 14 permanecem intactas; uma futura rota `POST /api/policy/evaluate` (read-only, admin-auth) poderá expor a avaliação — fora desta fase.

## 15. Integração com Job Queue (Bloco 12)

O engine poderá avaliar "este agente pode criar este tipo de job?" usando o catálogo `JobQueueType` existente e o risco por tipo (seção 9). O scheduler continua desligado por padrão; nenhum handler, fila, worker ou `JOB_QUEUE_ENABLED` é alterado. A job queue já carrega `createdBy: "agent"` e `correlationId`, o que dá trilha de auditoria nativa quando um dia um agente real enfileirar — sob aprovação do Operator.

## 16. Integração futura com Bloco 16

O Bloco 16 (Agentes Especializados) herdará: registry para declarar os agentes listados no prompt (Discovery, Research, Product Analyst, Curator, Pricing, Marketing, Analytics, Reliability, Security), políticas por agente, e o ciclo completo `AGENT → POLICY → PERMISSION → ACTION → APPROVAL → EXECUTION`. O Bloco 15 entrega apenas a infraestrutura declarativa; nenhum comportamento inteligente de agentes é criado aqui. A decisão D-10 (seção 22) lista o que permanece deliberadamente fora.

## 17. Persistência: necessária ou não?

**Recomendação da Fase 0: nenhuma tabela nova nesta fase.** Justificativa em três partes. Primeiro, registry e políticas em banco criariam uma segunda fonte de autoridade mutável em runtime — contrariando `AGENT != AUTHORITY` e abrindo vetor de autoelevação que o código fechado não tem. Segundo, o Bloco 14 demonstrou que contratos versionados em código (tipos/fórmulas/regras) funcionam sem banco. Terceiro, os estados que *precisam* de trilha persistente (aprovações, jobs, incidentes) já são persistidos pelos mecanismos existentes do Operator e da Job Queue, que o Policy Engine consulta em tempo real em vez de replicar. A única candidata plausível a persistência no futuro é um **decision journal** (`policy_evaluations` — cada avaliação com input, decisão e explicação), que será proposto apenas na Fase C, se aprovado, com migration aditiva, RLS ON, zero policies públicas, FKs explícitas e sem backfill — conforme exigido pelo prompt.

## 18. Proposta de testes

Suíte determinística (`tests/policyEngine.test.ts` e `tests/agentRegistry.test.ts`), cobrindo: registro válido; versão inválida; política inexistente; ação desconhecida; default deny; allow explícito; requires approval; aprovação inexistente; aprovação expirada; risk > max_risk (todas as fronteiras do vocabulário); ferramenta não autorizada; tabela não autorizada; ação não autorizada; agente inexistente; versão de agente inexistente; versão de política inexistente; política incompatível; self-modification (tentativa de alterar `maxRisk`/permissões via avaliação → sem efeito); privilege escalation (agente A citando permissões do agente B → DENY); agent impersonation (agentId inventado → DENY); version/policy/version spoofing (três cenários de mismatch → DENY); cross-agent permissions; **determinismo** (mesmo input, duas chamadas, mesmo `evaluationId` e mesma decisão); **explicabilidade** (cada decisão carrega reason/ruleApplied); **ausência de efeitos colaterais** (registry imutável após avaliação; mocks que falham se qualquer escrita ocorrer). A suíte prova o teorema central: **avaliar política ≠ executar ação**.

## 19. Riscos

O risco dominante é **complexidade desnecessária antes da demanda**: criar um engine de política sem nenhum agente real pode gerar uma superfície que ninguém usa. Mitigação: manter o engine pequeno (uma função pura + registros constantes), sem rotas nem persistência nesta fase, e reavaliar na Fase C. Risco secundário: **falsa sensação de segurança** — o engine avalia, mas não controla a execução; até que os call sites reais (enqueue, send, publish) consultem o engine, ele é um observador. Isso será mitigado na Fase D (integração read-only com pontos de consulta existentes, sem acoplamento) e documentado como limitação conhecida. Risco residual: calibração dos riscos por `JobQueueType` (seção 9) é proposta e deverá ser confirmada em review — valores errados podem negar ações legítimas do Operator (default deny é o comportamento correto nesse caso, mas pode friccionar operações humanas).

## 20. Decisões pendentes (D-1 a D-10)

| Decisão | Pergunta | Recomendado | Alternativas | Impacto | Risco | Justificativa |
|---|---|---|---|---|---|---|
| D-1 | Registry contratual (código) ou persistido (banco)? | **Contratual em código** (`Object.freeze`, readonly) | Banco com RLS | Zero superfície de escrita; zero migration agora | Agentes só evoluem por commit em `main` — desejável como barreira | Banco criaria 2ª autoridade mutável e vetor de auto-registro |
| D-2 | Policy engine apenas avaliador read-only? | **Sim** — função pura, sem rotas nesta fase | Adicionar rota `/api/policy/evaluate` já na Fase A | Nenhum efeito colateral; deploy sem risco | Fica "invisível" até a Fase D; documentado como limitação | Prompt exige decisão declarativa sem execução; rota entra na Fase D após revisão |
| D-3 | Catálogo fechado de actions? | **Sim**, fechado + `ACTION_SCHEMA_VERSION = "1.0"` | Catálogo extensível por registro | Explicabilidade total; spoofing impossível fora do catálogo | Actions novas exigem código; fricção controlada | "Action spoofing" é ameaça central do threat model |
| D-4 | Modelo de risco? | Reutilizar `AutoHealRisk` (LOW/MEDIUM/HIGH/CRITICAL) do SafeAutoHealEngine | Nova escala própria | Consistência com o Operator existente; zero vocabulário paralelo | — | Auditoria confirmou que o vocabulário já está em produção e cobre os 4 níveis exigidos |
| D-5 | Modelo de approval? | **Integrar ao PendingApproval existente** do Operator (NOT_REQUIRED/PENDING/APPROVED/REJECTED/EXPIRED), validação em tempo real contra `getPendingApprovals()` | Novo mecanismo próprio | Zero duplicação de aprovação; TTL por política (atributo, não mecanismo) | Depende da API do Operator — estável e auditada | Prompt proíbe criar novo mecanismo de aprovação se equivalente existir |
| D-6 | Versionamento de agent/policy? | **Semântico, congelado** (precedente do Bloco 14); divergência de versão = DENY | Numeração sequencial | Decisões reproduzíveis; sem atualização silenciosa | Histórico de versões cresce no arquivo | Mesmo padrão dos modelos do Bloco 14; auditável por git |
| D-7 | Memory scope granular por tabela? | **Sim**, catálogo fechado das 11 tabelas reais auditadas; default `[]` | Escopo por categoria ("commercial", "operational") | Granularidade defende against over-permission | Mais campos por agente; custo marginal | Prompt exige granularidade; auditoria já listou as tabelas reais |
| D-8 | Tool scope granular? | **Sim**, 17 tools fechadas; tool de escrita exige também action permission (duplo gate) | Tools e actions no mesmo conjunto | Defesa em profundidade | Curva de aprendizado para futuros agentes | Separa "o que o agente sabe usar" de "o que pode mandar executar" |
| D-9 | Decision journal neste bloco ou no futuro? | **Apenas no futuro (Fase C)**, se aprovado — engine retorna estrutura serializável pronta para journal | Persistir desde a Fase A | Fase A/B sem migration; journal entra com schema maduro | Perda de trilha histórica das primeiras avaliações (mitigável: avaliações ficam em logs de teste) | Prompt manda só propor persistência com necessidade real; avaliação já é 100% serializável |
| D-10 | O que permanece fora do Bloco 15? | Agentes reais (Discovery…Security), workers, execução autônoma, replay, policy por LLM, autoaprovação, autoelevação, comandos Telegram, cockpit, experiment registry | — | Escopo fechado | — | Prompt, seção 24 |

---

## GATES DA FASE 0

| Gate | Resultado |
|---|---|
| Produção intacta (`/health` ok, SHA `f75eff4`) | ✔ verificado em 16/08 ~02:30 UTC |
| SHA local = remoto, sem divergência | ✔ |
| 12 produtos, catálogo íntegro | ✔ SQL + `/api/products` |
| job_queue intacta (0 registros, scheduler off) | ✔ |
| Commercial Brain intacto (0/0, memória limpa) | ✔ |
| Observações Bloco 13 intactas (0/0/0/0) | ✔ |
| Telegram/Operator não alterados | ✔ (estado idêntico ao registrado no Bloco 14) |
| Working tree limpa | ✔ |
| Nenhum commit/push/deploy/migration/write em produção | ✔ cumprido |

## PRÓXIMA AUTORIZAÇÃO NECESSÁRIA

Aprovação deste design (com possíveis ajustes nas decisões D-1 a D-10) para iniciar a **FASE A — Contrato do Agent Registry**. Sem autorização, o Bloco 15 permanece em READY FOR REVIEW e nenhuma implementação ocorre.

---

**Regra final respeitada:** nada foi inventado — capacidades, permissões, aprovações e estado de produção foram auditados do ambiente real; nenhuma autoridade implícita foi criada; recomendação não virou ação; agente não virou autoridade; policy não virou execução.

`MEMORY != AUTHORITY · OBSERVATION != FACT CANÔNICO · SIGNAL != REVENUE · RECOMMENDATION != ACTION · AGENT != AUTHORITY · POLICY != EXECUTION`
