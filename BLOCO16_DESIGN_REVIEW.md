# BLOCO 16 — AGENTES ESPECIALIZADOS

## FASE 0 — DESIGN REVIEW / AUDITORIA ARQUITETURAL

**Projeto:** Cerberus Finds Archive (cerberus-forge-deploy)
**Data:** 16 de agosto de 2026
**Autor:** Manus AI
**Status:** **READY FOR REVIEW** — sem código, sem commit, sem push, sem deploy, sem migration, sem agente habilitado, sem escrita em produção.

---

## 1. Baseline

A auditoria foi precedida da captura da baseline exigida. Todos os valores abaixo foram verificados diretamente no momento da auditoria (~04:36–04:40 UTC).

| Referência | Valor | Verificação |
|---|---|---|
| SHA local (HEAD) | `981a2c93fc56732c716f368539e42b0816133eb4` | `git rev-parse HEAD` |
| SHA remoto (origin/main) | `981a2c9` — idêntico ao local | `git rev-parse origin/main` |
| Production frontend | `981a2c9` | `/health` → `ok` |
| Production backend | `981a2c9` | `/health` → `ok` |
| Products | **12 publicados** | `/api/products` (backend) |
| Catálogo estático | `products.json` servindo (200) | backend |
| job_queue | 0 registros, scheduler desligado | banco (read-only) |
| Observações (4 tabelas) | 0 registros cada | banco (read-only) |
| Commercial Brain (signals/artifacts) | 0/0 | banco (read-only) |
| policy_evaluations | 1 registro (audit record preservado do security-agent) | banco (read-only) |
| Telegram/Operator | webhook respondendo; enfileiramento ativo | POST webhook → `{"ok":true}` |
| Working tree | 0 alterações de bloco (apenas `pnpm-lock.yaml`/`pnpm-workspace.yaml` não rastreados, sem relação com blocos) | `git status --porcelain` |

## 2. Estado atual

O Cerberus chega ao Bloco 16 com os Blocos 9–15 integralmente consolidados em produção no SHA `981a2c9` (auditoria de consolidação concluída em 04:32 UTC confirmou 100% de consolidação, sem pendências). A infraestrutura de governança está ativa: o **Agent Registry** declara nove agentes como artefatos congelados em código, o **Policy Engine** avalia solicitações de forma determinística com default deny, e o **Decision Journal** persiste decisões com idempotência canônica. Nenhum agente está habilitado; nenhum é executável hoje. O único registro do journal é um audit record deliberadamente preservado.

## 3. Arquitetura existente

A arquitetura atual (Blocos 9–15) fornece as seis fundações sobre as quais os agentes do Bloco 16 serão construídos, sem reimplementação.

| Fundação | Componente | Contrato |
|---|---|---|
| Identidade declarativa | `server/agentRegistry/` (agents.ts + types.ts) | `AGENT_REGISTRY`: 9 definições `Object.freeze`, somente `getAgent`/`listAgents`; sem registro em runtime |
| Avaliador determinístico | `server/policyEngine/` (policyEngine.ts, toolActionMap.ts, types.ts) | Função pura `evaluatePolicy`; catálogo fechado de reason codes; `ACTION_TOOL_MAP` fecha tool→action; default deny |
| Persistência de decisão | `policy_evaluations` (migration `20260816_policy_evaluations.sql`) | PK + 6 CHECKs + 7 índices, RLS ativo, zero policies públicas; `context` e `correlation_id` opcionais |
| Infraestrutura durável | `job_queue` (migration `20260816_job_queue.sql`) | 5 tipos; `created_by` já prevê `"agent"`; claim atômico, retry, dead letter; scheduler desligado |
| Sinais comerciais | `commercial_signals` / `commercial_artifacts` (migration `20260816_commercial_brain.sql`) | `schema_version` já existe no artefato comercial; 3 tipos de artefato (opportunity, risk, recommendation) |
| Memória operacional | `operational_events` / `operational_incidents` / `operational_recovery_attempts` / `operator_state` | 34 incidentes reais registrados; eventos duráveis |

O fluxo de execução hoje existente (pré-Bloco 16) passa por caminhos do Operator/Telegram que **não consultam** o Policy Engine: o bot publica via `pipeline.publish`, o SafeAutoHeal executa actions via seu próprio `actionRegistry`, e o scheduler consome jobs sem mediação. Isso não é um bug dos blocos anteriores — o engine foi projetado como observador read-only — mas é o **gap central que o Bloco 16 deve fechar** (seção 5).

## 4. Agent Registry audit

A auditoria do registry real (`server/agentRegistry/agents.ts`, linha 1) mapeia integralmente os campos exigidos. Todos os nove agentes estão com `status: "DRAFT"`, `enabled: false`, `version: "1.0"`, `maxRisk: "LOW"`, `tokenBudget: 0` e `timeBudgetMs: 0` — nenhum agente é executável.

| Agente | Version | Status | Enabled | Tools permitidas | Tabelas | Actions | MaxRisk | Budgets | MemoryScope | PolicyVersion |
|---|---|---|---|---|---|---|---|---|---|---|
| discovery-agent | 1.0 | DRAFT | false | catalog.read, observations.read | products, product_clicks | READ_PRODUCT, READ_OBSERVATION | LOW | 0 / 0 | PRODUCT, OBSERVATIONS | 1.0 |
| research-agent | 1.0 | DRAFT | false | commercial.signals.read | commercial_signals, commercial_artifacts | READ_COMMERCIAL_SIGNAL, READ_COMMERCIAL_ARTIFACT | LOW | 0 / 0 | COMMERCIAL_SIGNALS, COMMERCIAL_ARTIFACTS | 1.0 |
| product-analyst | 1.0 | DRAFT | false | products.read, commercial.analyze | products, product_clicks | READ_PRODUCT, ANALYZE_PRODUCT | LOW | 0 / 0 | PRODUCT | 1.0 |
| curator-agent | 1.0 | DRAFT | false | commercial.signals.read | commercial_signals, commercial_artifacts | READ_COMMERCIAL_SIGNAL, READ_COMMERCIAL_ARTIFACT (PUBLISH declarada em texto, bloqueada por LOW) | LOW | 0 / 0 | COMMERCIAL_SIGNALS, COMMERCIAL_ARTIFACTS | 1.0 |
| pricing-analyst | 1.0 | DRAFT | false | commercial.signals.read | commercial_signals, commercial_artifacts | READ_COMMERCIAL_SIGNAL, READ_COMMERCIAL_ARTIFACT | LOW | 0 / 0 | COMMERCIAL_SIGNALS | 1.0 |
| marketing-analyst | 1.0 | DRAFT | false | observations.read | product_clicks | READ_PRODUCT, READ_OBSERVATION | LOW | 0 / 0 | PRODUCT, OBSERVATIONS | 1.0 |
| analytics-analyst | 1.0 | DRAFT | false | operational.read, job_queue.read | operational_events, job_queue | READ_OPERATIONAL_EVENT, READ_JOB_QUEUE | LOW | 0 / 0 | OPERATIONAL_EVENTS, JOB_QUEUE | 1.0 |
| reliability-agent | 1.0 | DRAFT | false | operational.read | operational_events, operational_incidents, operational_recovery_attempts, operator_state | READ_OPERATIONAL_EVENT | LOW | 0 / 0 | OPERATIONAL_EVENTS, OPERATIONAL_OPERATIONS | 1.0 |
| security-agent | 1.0 | DRAFT | false | operational.read, operator.mode.read | operational_events, operator_state | READ_OPERATIONAL_EVENT | LOW | 0 / 0 | OPERATIONAL_EVENTS | 1.0 |

**ACHADOS do registry** (registrados como ACHADO, sem correção nesta fase):

- **A1 — Token/Time budget nulo.** Todos os agentes têm `tokenBudget: 0` e `timeBudgetMs: 0`. Se um runtime futuro interpretar `0` como "sem orçamento" de forma estrita, nenhum agente poderá trabalhar; se interpretar como "ilimitado", o controle de custo some. **Decisão pendente:** definir a semântica formal de `0` (recomendado: `0` = sem orçamento alocado → execução impossível até alocação explícita, fail-closed).
- **A2 — Reliability Agent com allowedTables mais amplo que allowedActions.** Declara leitura de 4 tabelas mas apenas `READ_OPERATIONAL_EVENT` como action; o gap (incidentes, recovery_attempts, operator_state) não tem actions mapeadas. É coerente com o estado DRAFT (leitura via observation), mas a Fase A do Bloco 16 deverá fechar essa incoerência de forma explícita, seja ampliando o catálogo de actions, seja alinhando as tabelas.
- **A3 — Não existe OPERATOR_AGENT no registry.** O Cerberus Operator existe como control plane (`cerberusOperator.ts`, `operatorAutonomy.ts`) e como criador de jobs, mas não está registrado como agente. Isso é intencional no design (seção 13), mas cria a pergunta de autoridade: quem audita as decisões do próprio Operator? O journal registra avaliações de agentes; a resposta do Operator hoje vive em `pendingApprovals` em memória.
- **A4 — Incoerência de memoryScope no discovery-agent.** O discovery-agent declara memoryScope `["PRODUCT", "OBSERVATIONS"]` e tabelas `products, product_clicks`, mas sua descrição e actions não mencionam `product_clicks` como recurso analítico de marketing (marketing-analyst usa `product_clicks` com action `READ_PRODUCT`). Registro sem drift de execução, mas os comentários deverão ser alinhados na Fase A.

Nenhum agente foi habilitado, nenhuma permissão foi alterada.

## 5. Policy Engine audit

O engine (`server/policyEngine/policyEngine.ts`) implementa a função pura `evaluatePolicy` com verificação completa (request → agent → tool → action → risk → compatibility → scope → risk floor → enabled → approval → reason code → evaluationId). O mapa `ACTION_TOOL_MAP` fecha a relação tool↔action em 15 actions, cada uma para exatamente uma tool; combinação não listada resulta em `DENY (TOOL_ACTION_MISMATCH)`. O catálogo de reason codes é fechado e versionado. A persistência (Bloco 15-C) registra cada decisão com idempotência canônica frente à reordenação de chaves do JSONB.

**Pontos em que um agente poderia potencialmente contornar o engine hoje** (registrados, sem correção automática):

- **B1 — BLOQUEANTE.** *Não existe nenhum runtime que obrigue a passagem pelo engine.* `evaluatePolicy` só é invocada pela rota `POST /api/policy/evaluate`, que é uma ferramenta de diagnóstico: qualquer código que execute uma action (publish, recovery, enqueue) hoje nunca consulta o engine. Um agente habilitado com o código atual seria apenas o Telegram/Operator de sempre com outro nome. **Mitigação projetada: o Agent Runtime do Bloco 16 será o único caminho de execução, e toda execução de action exigirá `evaluationId` válido com decisão ALLOW/APPROVED do próprio runtime.**
- **B2 — BLOQUEANTE.** *As actions do catálogo do engine não correspondem integralmente às actions executáveis reais.* O catálogo declara `PUBLISH_PRODUCT`, `UPDATE_PRICE`, `RUN_RECOVERY` etc., mas os executadores reais (pipeline de lifecycle, SafeAutoHealEngine, scheduler) usam registros próprios de actions/approvals que não são validados contra o engine. Antes de qualquer agente executar ação real, os executadores existentes precisarão ser encapados por gateways compatíveis com o catálogo do engine. **Mitigação projetada: Tool Adapters (seção 11) como única ponte entre tools declaradas e executadores reais.**
- **B3 — NÃO BLOQUEANTE.** *O Operator não passa pelo engine.* O Cerberus Operator solicita aprovação e executa recovery via seu próprio mecanismo. Como control plane futuro dos agentes, o Operator também precisará de suas próprias avaliações registradas no journal (proposta: registrar um "agent" virtual `operator` no registry ou criar namespace de avaliações operacionais — ver decisão pendente E-3).
- **B4 — NÃO BLOQUEANTE.** *O campo `approval` do journal é estado textual* (`NONE/PENDING/APPROVED/REJECTED/EXPIRED`) sem referência externa ao registro de aprovação do Operator (in-memory). A ligação evaluation↔approval real é feita por `correlation_id` declarado pelo chamador, não por FK. A Fase A do Bloco 16 deverá formalizar essa ligação quando o approval for persistido.

Todos os demais controles do engine (identidade, versão, risco, scope, floor, enabled) estão corretos e não apresentam caminhos de contorno no caminho de avaliação em si.

## 6. Decision Journal audit

A tabela `policy_evaluations` responde a quase toda a cadeia de auditoria exigida: quem solicitou (context/proveniência), qual agente e versão, qual policy, qual tool, qual action, qual risco, qual recurso (table/field), qual decisão, por que foi permitida ou negada (reason code + reason textual) e o `approval_state` declarado. O `evaluation_id` identifica cada tentativa de forma única e o design idempotente impede duplicação com conteúdo divergente.

As três respostas que o journal hoje **não** dá por construção: (a) se exigiu aprovação *no Operator real* — o estado `APPROVED` textual é declarado pelo chamador, não verificado; (b) qual execução posterior ocorreu — não há `execution_id`/`job_id`/`artifact_id` ligando a avaliação à execução; (c) qual resultado a execução teve — a execução não escreve de volta no journal. Essas lacunas serão fechadas pelo modelo de artefatos e pelo loop Runtime→Job Queue→Resultado (seções 8, 12 e 15): a execução autorizada enfileira um job com `idempotency_key` derivado do `evaluation_id`, e o fechamento do loop (job→evaluation, com resultado) é contrato da Fase A, não desta Fase 0. **Não será criado outro sistema de auditoria**: `policy_evaluations` é suficiente como coluna vertebral.

## 7. Agent Runtime proposal

O runtime será o **único caminho permitido** para executar um agente. A proposta conceitual é fechada e determinística em seus pontos de decisão; a implementação fica para a Fase A.

```
AgentRequest (contexto explícito e limitado)
   │
   ▼
[1] Identidade     → agent conhecido no registry? senão DENY (AGENT_UNKNOWN)
   ▼
[2] Versão         → agent_version == registry.version? senão DENY (VERSION_MISMATCH)
   ▼
[3] Input          → validação de schema do input declarado pelo agente; senão DENY (INVALID_INPUT)
   ▼
[4] Policy         → evaluatePolicy(request, registry) — único caller do engine em produção
   ▼
[5] Rejeição       → se DENY: journal registrado, resposta DENY, nada mais acontece
   ▼
[6] Aprovação      → se REQUIRES_APPROVAL: job entra em APPROVAL_WAIT até aprovação humana
                      com TTL; expirada → EXPIRED e reavaliação obrigatória
   ▼
[7] Execução       → somente ALLOW ou APPROVED: runtime despacha ao Tool Adapter
   ▼
[8] Artefato       → Tool Adapter devolve Artifact versionado (seção 8)
   ▼
[9] Proveniência   → correlation_id, execution_id, evaluation_id propagados
   ▼
[10] Jornal        → journal.write({…, execution_id, artifact_ref}) — fechamento do loop
   ▼
NUNCA concede permissão adicional; todo estado transitório é in-memory do runtime.
```

O contrato `AgentRequest` (proposta de tipos, sem schema ainda) cobre os campos exigidos: `agent_id`, `agent_version`, `task_id`, `correlation_id`, `input`, `requested_action`, `requested_tool`, `requested_resource`, `policy_version`. O runtime expõe **uma única rota interna** (por exemplo `POST /internal/agent/execute`, acessível somente por código do próprio servidor — jamais por API pública ou Telegram direto), garantindo que não exista caminho que chegue a uma action sem passar pelos dez estágios.

## 8. Artifact model

Cada agente produz artefatos versionados; artefato **não é autoridade** — os artefatos do Bloco 16 serão persistidos em tabelas próprias (migration futura), nunca como alteração direta de `products`. O modelo mínimo, alinhado ao precedente de `commercial_artifacts` (que já tem `schema_version`, `agent_id`, `artifact_type`, `payload`, `provenance`), é:

| Campo | Tipo | Observação |
|---|---|---|
| artifact_id | string (prefixo por tipo: `disc-`, `res-`, `pax-`, `cur-`, `prc-`, `mkt-`, `anx-`, `rel-`, `sec-`) | identidade única, determinística |
| artifact_type | enum fechado por agente | ver tabela da seção 9 |
| schema_version | text, default `1.0` | mudança de schema exige novo artifact_type ou major |
| agent_id | text | FK conceitual ao registry (conferido em código, não em banco) |
| agent_version | text | 1.0 nesta fase |
| policy_version | text | versão da policy aplicada na avaliação |
| evaluation_id | text | link ao journal — prova de que a política permitiu |
| created_at | timestamp | fonte única de tempo do servidor |
| correlation_id | text | agrupa request→evaluation→artifact→job→resultado |
| input_refs | jsonb[] | referências imutáveis aos inputs (refs, observation_ids, job_ids) |
| evidence_refs | jsonb[] | evidências que sustentam a confiança |
| confidence | numeric 0–1 | interpretável, nunca autoritativa |
| status | enum: `DRAFT | SUBMITTED | ACCEPTED | REJECTED` | somente autoridade humana pode ACCEPT |
| payload | jsonb | conteúdo tipado por artifact_type, validado por schema |
| provenance | jsonb | quem, quando, qual avaliação, quais inputs, qual versão |

A regra de ouro do status: **`RECOMMENDATION != ACTION`**. Um artefato `ACCEPTED` significa apenas que um humano o leu e decidiu agir; a ação real passa por approval e execution do fluxo padrão. `PUBLISH_DIRECTLY` não existe no modelo.

## 9. Agent capability matrix

Matriz formal AGENTE × TOOLS × ACTIONS × TABLES × RISK × OUTPUTS, derivada **exclusivamente** do registry existente, sem ampliação de permissões.

| Agente | Tools | Actions | Tables | MaxRisk | Output (artifact) | Não pode (herança do registry) |
|---|---|---|---|---|---|---|
| Discovery Agent | catalog.read, observations.read | READ_PRODUCT, READ_OBSERVATION | products, product_clicks | LOW | **CandidateArtifact** | publicar, alterar preço, alterar products, campanhas |
| Research Agent | commercial.signals.read | READ_COMMERCIAL_SIGNAL, READ_COMMERCIAL_ARTIFACT | commercial_signals, commercial_artifacts | LOW | **ResearchArtifact** | publicar, alterar produto, ações comerciais |
| Product Analyst | products.read, commercial.analyze | READ_PRODUCT, ANALYZE_PRODUCT | products, product_clicks | LOW | **ProductAnalysisArtifact** | alterar products, publicar |
| Curator Agent | commercial.signals.read | READ_COMMERCIAL_SIGNAL, READ_COMMERCIAL_ARTIFACT | commercial_signals, commercial_artifacts | LOW (PUBLISH bloqueada) | **CurationArtifact** | publicar sozinho |
| Pricing Analyst | commercial.signals.read | READ_COMMERCIAL_SIGNAL, READ_COMMERCIAL_ARTIFACT | commercial_signals, commercial_artifacts | LOW | **PricingAnalysisArtifact** | alterar preço |
| Marketing Analyst | observations.read | READ_PRODUCT, READ_OBSERVATION | product_clicks | LOW | **MarketingAnalysisArtifact** | lançar campanha sozinho |
| Analytics Analyst | operational.read, job_queue.read | READ_OPERATIONAL_EVENT, READ_JOB_QUEUE | operational_events, job_queue | LOW | **AnalyticsArtifact** | alterar dados canônicos |
| Reliability Agent | operational.read | READ_OPERATIONAL_EVENT | operational_events, operational_incidents, operational_recovery_attempts, operator_state | LOW | **ReliabilityArtifact** | alterar código, policy, registry; recovery sem autorização |
| Security Agent | operational.read, operator.mode.read | READ_OPERATIONAL_EVENT | operational_events, operator_state | LOW | **SecurityArtifact** | alterar próprias permissões, policy, desabilitar controles |

Como todos os agentes estão em DRAFT com apenas leituras no registry, o Bloco 16 inicia como um sistema **100% observacional**: nenhum agente escreve em nenhuma authority. Escaladas futuras (write tools, MEDIUM/HIGH, PUBLISH não bloqueada) exigirão novos registry versions e novas policies, registradas no journal — nada disso é assumido aqui.

## 10. Memory scopes

Memory scope é a projeção autorizada de leitura, nunca acesso irrestrito. A regra é default deny: quando um campo ou tabela não está no scope, o runtime retorna `DENY (SCOPE_VIOLATION)` antes de qualquer consulta.

| Scope | Dados cobertos | Leitura | Retenção | Escopo temporal | Artefatos | Observações | Secrets |
|---|---|---|---|---|---|---|---|
| PRODUCT | products (canônico) | read-only | não retém cópia | consulta no momento da tarefa | via evidência | não diretamente | nunca |
| OBSERVATIONS | product_clicks, product_*_observed | read-only | não retém cópia | consulta no momento | via evidência | sim (via observations.read) | nunca |
| COMMERCIAL_SIGNALS | commercial_signals | read-only | não retém cópia | consulta no momento | sim (inputs) | não | nunca |
| COMMERCIAL_ARTIFACTS | commercial_artifacts | read-only | não retém cópia | consulta no momento | sim (inputs) | não | nunca |
| OPERATIONAL_EVENTS | operational_events | read-only | não retém cópia | consulta no momento | não | não | nunca |
| OPERATIONAL_OPERATIONS | operational_operations, recovery_attempts | read-only | não retém cópia | consulta no momento | não | não | nunca |
| JOB_QUEUE | job_queue (estado de jobs) | read-only | não retém cópia | consulta no momento | não | não | nunca |

Nenhum agente recebe acesso a secrets, tokens, credentials, authorization headers ou dados administrativos não necessários. O runtime implementa isso com um **leitor por scope** (não com o cliente Supabase genérico): o adapter de cada tool só pode instanciar consultas nas tabelas do scope do agente que o invocou. A retenção é inexistente por desenho — o agente não mantém estado entre tarefas além do artifact que produz.

## 11. Tool adapters

Os agentes nunca chamam ferramentas diretamente. A ponte conceitual é:

```
Agent → Tool Request → Policy Engine (permitiu) → Tool Adapter → Tool real
```

O Tool Adapter é o guardião de execução por tool. Suas obrigações contratuais: validar argumentos contra o schema da tool; validar que a action pedida está no scope do agente; sanitizar todos os inputs (sem inventar dados, sem propagar credenciais); impedir acesso fora do contrato (tabelas fora do memory scope → DENY); produzir provenance (evaluation_id, correlation_id, agent+version); e devolver resultado estruturado tipado. A implementação real usará os executadores já existentes como destinos: `catalog.read`/`observations.read` apontam para os repositórios de leitura atuais; `commercial.signals.read`/`commercial.analyze` apontam para o Commercial Brain read-only; `operational.read` aponta para a memória operacional; `job_queue.read` consulta a fila. **Nenhuma tool de escrita será adaptada no Bloco 16** — a tabela `ACTION_TOOL_MAP` já declara `products.write`, `telegram.send`, `job_queue.enqueue` como combináveis com actions, mas nenhum agente do registry as possui; a adaptação dessas tools fica documentada como dependência das fases futuras, nunca implícita.

## 12. Agent × Job Queue

A fila durável do Bloco 12 permanece a única infraestrutura de execução agendada; não será criado scheduler novo nem duplicação de fila, e nenhum worker autônomo será ativado nesta fase. O contrato futuro é `job → agent_id → agent task → claim → runtime → policy → tool → artifact → result`. Três integrações conceituais: (a) o campo `created_by = 'agent'` já existe em `job_queue` e será o ponto de origem dos jobs de agentes; (b) jobs de agente carregarão `evaluation_id` e `idempotency_key` derivados da avaliação que os autorizou, de modo que re-execução acidental nunca duplique autoridade; (c) o resultado do job (SUCCEEDED/FAILED/DEAD_LETTER) fecha o loop de volta ao journal via `execution_result`. Os job types candidatos a associação com agentes são documentados na tabela — decisão de mapeamento é da Fase A:

| JobQueueType existente | Associação conceitual com agente | Observação |
|---|---|---|
| catalog_sync | — | permanece system/operator |
| telegram_send | — | permanece system/operator |
| product_ingest_review | Curator/Discovery (futuro, approval humano mantido) | documentação apenas |
| operational_recovery | Reliability (futuro, somente após approval) | documentação apenas |
| maintenance | — | permanece system |

## 13. Cerberus Operator

O Operator não é mais um agente — é o **control plane**: observa o estado do sistema, coordena tarefas, solicita análises aos agentes, recebe artefatos, avalia recomendações, solicita aprovação humana e aciona execuções autorizadas. No fluxo AGENT → POLICY → PERMISSION → ACTION → APPROVAL → EXECUTION, o Operator é o elo que conduz PERMISSION → ACTION → APPROVAL: ele nunca executa diretamente, nunca ignora o Policy Engine, nunca concede permissões arbitrárias, nunca altera registry ou policy. Duas definições conceituais ficam para a Fase A: (a) a fila interna de trabalho do Operator será composta por jobs do Bloco 12 com `created_by='operator'` ou `'agent'`, nunca por mecanismo paralelo; (b) a relação Operator↔registry será de consumidor: o Operator lê o registry para saber quais agentes existem e pode habilitar, mas habilitar um agente é operação administrativa humana via painel, com avaliação própria registrada no journal (agent do journal: `operator-admin`, conceito a definir na decisão E-3).

## 14. Lifecycle

Estados conceituais do agente: `DRAFT → VALIDATING → ENABLED → PAUSED → DISABLED → RETIRED`. As regras de transição seguem o princípio de que **nenhum agente transita o próprio estado**:

| Transição | Quem pode | Auditado como |
|---|---|---|
| DRAFT → VALIDATING | admin humano (painel) | avaliação no journal (tool: registry.admin, action: VALIDATE_AGENT) |
| VALIDATING → ENABLED | admin humano | avaliação no journal |
| ENABLED → PAUSED | admin humano ou Operator (via job autorizado) | avaliação no journal |
| → DISABLED | admin humano | avaliação no journal |
| → RETIRED | admin humano (irreversível por política) | avaliação no journal |

Toda transição gera uma avaliação no Decision Journal antes de se concretizar; sem avaliação ALLOW no journal, a transição é rejeitada pelo próprio painel (gate administrativo). A política que controla a transição é a **AGENT_LIFECYCLE_POLICY** do registry, versionada separadamente da policy de ações — mudar a política de lifecycle exige nova versão e revalidação dos agentes afetados.

## 15. Versioning

Cada execução preserva quatro versões amarradas ao artifact e ao journal: `agent_version` (1.0 nesta fase), `policy_version` (versão do catálogo de policies no momento), `tool_version` (versão do adapter invocado) e `artifact_schema_version` (1.0 no modelo da seção 8). A regra de imutabilidade interpretativa: se qualquer uma dessas versões mudar, a execução histórica **não pode** ser reinterpretada como se tivesse usado a nova versão — isso é garantido por código (comparação de versão determinística no engine, já existente) e por banco (versões escritas como texto nos registros do journal e dos artifacts). A mudança de qualquer versão gera nova constante congelada no código, seguindo o precedente do Bloco 14/15.

## 16. LLM boundary

Se algum agente utilizar LLM futuramente, o contrato é `LLM OUTPUT != AUTHORITY`. O LLM poderá interpretar, classificar, resumir, propor e gerar hipóteses — sempre como conteúdo **dentro** de um artifact, com `confidence` interpretável. O LLM nunca decide permissões, nunca altera policy ou registry, nunca escolhe tools livremente, nunca executa actions e nunca grava diretamente em authorities. A autorização continua sendo 100% determinística e externa ao modelo (o Policy Engine não aceita input de LLM como decisão). Esta fronteira é testável: o único ponto onde um LLM tocaria a cadeia é a geração de payload de artefato, depois da autorização já decidida.

## 17. Failure model

Fail-closed em todos os pontos do runtime, sem exceção de "best effort" para permissões:

| Falha | Comportamento |
|---|---|
| agent desconhecido | DENY (AGENT_UNKNOWN) |
| agent disabled / DRAFT | DENY (AGENT_DISABLED) |
| tool desconhecida | DENY (TOOL_UNKNOWN) |
| action desconhecida | DENY (ACTION_UNKNOWN) |
| scope inválido | DENY (SCOPE_VIOLATION) |
| policy ausente | DENY (POLICY_MISSING) |
| versão incompatível | DENY (VERSION_MISMATCH) |
| risco acima do limite | DENY (RISK_FLOOR) |
| argumento inválido | DENY (INVALID_INPUT) |
| timeout | falha controlada, journal registra, retry conforme job |
| Supabase indisponível | não inventar memória: DENY com reason MEMSTORE_UNAVAILABLE; leitura nunca é simulada |
| approval ausente | REQUIRES_APPROVAL |
| artifact inválido | rejeição do artifact, status REJECTED, avaliação registrada |

Nenhum destes casos pode resultar em ALLOW implícito, fallback aberto ou execução sem journal.

## 18. Concurrency / idempotency

O design herda o mecanismo comprovado do Bloco 12 e do journal do Bloco 15: cada execução do runtime recebe `task_id` e gera `execution_id`; o `idempotency_key` deriva de `agent_id + agent_version + task + evaluation_id`, e a comparação de artefatos/journal usa o padrão `canonicalJson` (já corrigido no Bloco 15-C) para tolerar reordenação do JSONB. O claim atômico da fila, lease, timeout, retry com backoff e dead letter vêm do job queue existente. Duas execuções concorrentes nunca produzem autoridade duplicada porque a persistência (journal e futuros artifacts) rejeita duplicatas idênticas como `identical_duplicate` e divergências como `conflict_rejected`. Artefatos possuem identidade única por prefixo de tipo e proveniência completa (seção 8).

## 19. Threat model

| Risco | Vetor | Impacto | Controle | Teste necessário | Bloco responsável |
|---|---|---|---|---|---|
| Prompt injection | conteúdo externo (URL, título, review) interpretado por LLM futuro | agente altere comportamento | payload do LLM tratado como dados, nunca como instruções; autorização determinística externa ao modelo | teste de payload malicioso em input de agente → DENY/neutralizado | 16 |

| Tool injection | request declara tool não pertencente ao agente | execução fora do scope | ACTION_TOOL_MAP fechado + validação de scope no adapter | test: tool declarada fora do allowedTools → DENY | 16 |
| Confused deputy | agente usa credencial do servidor para ação própria | privilégio emprestado | adapters sem acesso a secrets; ações exigem avaliação com identidade do agente | test: adapter tenta ação sem evaluation_id → DENY | 16 |
| Privilege escalation | agente tenta habilitar-se ou ampliar maxRisk | autoridade indevida | registry imutável em runtime (código); transições só por admin humano com avaliação | test: mutation attempt → DENY | 16 |
| Agent impersonation | request com agent_id de outro agente | falsificação de identidade | identidade verificada por código server-side (nunca por dado de input); sem credenciais por agente nesta fase | test: correlation que não corresponde → DENY | 16 |
| Replay | reenvio de request autorizado | duplicação de artefato/execução | idempotency_key + `identical_duplicate`/`conflict_rejected` no journal (comparação canônica) | test: replay idêntico → identical_duplicate | 15/16 |
| Duplicate execution | duas execuções concorrentes | autoridade duplicada | claim atômico da fila + UNIQUE do journal | test: concorrência real (Promise.all) | 12/15/16 |
| Stale approval | aprovação expirada usada | ação sem consentimento atual | TTL de aprovação; EXPIRED exige reavaliação | test: approval vencida → REQUIRES_APPROVAL | 16 |
| Policy drift | política executada difere da declarada | decisão não auditável | policyVersion congelada por avaliação; divergência → DENY (já implementado) | test: versão divergente → DENY | 15 |
| Registry drift | registro executado difere do congelado | identidade corrompida | AGENT_REGISTRY Object.freeze em main; engine compara versão | test: registro alterado → DENY | 15 |
| Artifact spoofing | artifact fabricado sem avaliação | recomendação falsa tratada como fato | artifact exige evaluation_id validado; sem avaliação não há persistência | test: artifact sem evaluation → rejeitado | 16 |
| Provenance loss | registro sem correlation/context | auditoria impossível | provenance obrigatória no modelo de artifact; mitigação D06b já existente | test: request sem correlation → registrado, mas rejeitado se inexecutável | 15/16 |
| Secret leakage | logs ou payloads com tokens | exposição de credenciais | sanitização existente (Bloco 15) + adapters sem acesso a secrets | test: payload com segredo → sanitizado | 15 |
| Cross-agent data leakage | agente lê dado fora do seu scope | vazamento entre agentes | leitores por scope (seção 10) | test: query fora do memoryScope → DENY | 16 |

## 20. Bloco 16 scope

O Bloco 16 implementará, nas fases futuras (A em diante, mediante autorização): o Agent Runtime como único caminho de execução; o modelo de artifacts com persistência dedicada; os Tool Adapters read-only (um por tool do registry); a integração agent→job_queue (jobs com `created_by='agent'`, evaluation_id, idempotency_key); o lifecycle administrativo com avaliações no journal; o painel de habilitação/pausa com gate de policy; e os testes determinísticos de cada agente contra o engine. O registry, o engine e o journal existentes **não serão reimplementados** — serão estendidos por versões novas e congeladas.

## 21. Fora de escopo

Explicitamente fora desta fase e das fases imediatas do Bloco 16: novos marketplaces e novos sites; campanhas reais; publicação automática; alteração automática de preços; workers autônomos; LLM autônomo; auto-registro de agentes; auto-alteração de policy; cockpit comercial completo; experiment registry completo (Bloco 17); escala multi-worker (Bloco 18+). Ferramentas de escrita (`products.write`, `telegram.send`, `job_queue.enqueue`) permanecem apenas no catálogo declarativo do engine, sem adaptação. Se alguma dessas capacidades se tornar dependência, ela será apenas documentada.

## 22. Riscos

O risco dominante é o **B1/B2 da seção 5**: até que o runtime e os gateways existam, habilitar um agente daria falsamente a impressão de governança, quando a execução real continuaria pelos caminhos antigos. A mitigação estrutural é a ordem das fases: runtime primeiro, adaptação de executadores antes de qualquer `enabled: true`, e o painel administrativo bloqueado por gate de policy. O segundo risco é a **calibração de budgets** (A1): budgets zerados podem paralisar agentes legítimos ou, se mal interpretados, remover o controle de custo. O terceiro risco é a **sobreposição Operator×agent** (A3): sem registrar o Operator no registry ou namespace próprio, as ações administrativas de lifecycle ficariam fora do journal — inaceitável para auditoria. O quarto risco é o mesmo dos blocos anteriores: complexidade antes da demanda; mitigação mantida pelo desenho 100% observacional da fase inicial.

## 23. Decisões pendentes (D-1 a D-8)

| Decisão | Pergunta | Recomendado | Alternativas | Impacto | Risco |
|---|---|---|---|---|---|
| D-1 | Semântica de tokenBudget/timeBudgetMs = 0 | **0 = sem orçamento alocado (fail-closed)** | 0 = ilimitado | agentes não executam até alocação explícita | agente legítimo parado (mitigado por painel de alocação) |
| D-2 | Reliability Agent: tabelas extras sem actions (A2) | **Ampliar catálogo com READ_INCIDENT/READ_RECOVERY/READ_OPERATOR_STATE na Fase A** | reduzir allowedTables | catálogo cresce de forma controlada | actions novas exigem nova constante congelada |
| D-3 | Operator no journal: registrar como agente ou namespace? | **Registrar OPERATOR_AGENT como entry especial do registry (habilitado=false, status CONTROL_PLANE)** | namespace separado | ações do Operator auditáveis no mesmo journal | entry especial pode conflitar com "agente comum"; tratar como variante de status |
| D-4 | Como o approval humano chega ao job de agente | **Aprovação via painel administrativo existente, com approval_id persistido e correlation_id no journal** | aprovação por Telegram | painel é a autoridade única; Telegram permanece canal de notificação | mudança de hábito operacional |
| D-5 | Onde os artifacts são persistidos | **Nova tabela `agent_artifacts` (migration futura) com o schema da seção 8** | reutilizar commercial_artifacts | proveniência própria; sem contaminação do Bloco 14 | migration exige review antes de aplicar |
| D-6 | Rota de execução do runtime | **Rota interna in-memory (módulo, sem rota HTTP pública)** nesta fase | rota /internal protegida por secret | zero superfície HTTP extra | limita testes E2E externos (mitigado por testes de módulo) |
| D-7 | Quem executa a validação de artifact (schema por tipo) | **Validador determinístico por artifact_type (função pura, catálogo fechado)** | validação genérica | rejeição auditable e versionada | custo marginal por tipo |
| D-8 | Correlation entre evaluation e execução real | **execution_id escrito no journal pelo fechamento do loop job→result** | coluna nova na tabela | journal responde "qual execução posterior, qual resultado" | schema muda → migration |

## 24. Fases futuras

A Fase A (contrato do runtime e primeiro agente observacional, sem enable), a Fase B (adapters read-only e modelo de artifacts com migration), a Fase C (integration: jobs de agentes, loop de fechamento, painel de lifecycle) e a Fase D (prova viva observacional com limpeza) seguem o mesmo padrão dos Blocos 13–15: uma fase por autorização, gates antes de commit, prova viva antes de considerar pronto, e nada habilitado sem aprovação humana explícita. A habilitação de qualquer agente (`enabled: true`) é um evento separado, posterior a todas as fases, com avaliação própria no journal.

## 25. Gates da Fase 0

| Gate | Resultado |
|---|---|
| Baseline capturada (SHA, production, banco, Telegram) | ✔ verificada em 16/08 ~04:36 UTC |
| Nenhuma alteração funcional | ✔ cumprido — zero escrita |
| Nenhum commit | ✔ cumprido |
| Nenhum push | ✔ cumprido |
| Nenhum deploy | ✔ cumprido |
| Nenhuma migration | ✔ cumprido — nenhum schema criado |
| Nenhum agente habilitado | ✔ cumprido — todos permanecem DRAFT/false |
| Nenhum job executado | ✔ cumprido — job_queue segue com 0 registros |
| Nenhuma escrita em produção | ✔ cumprido — apenas SELECTs read-only |
| 12 produtos preservados | ✔ `/api/products` = 12 published |
| Production intacta | ✔ `/health` = ok, SHA 981a2c9 nas duas instâncias |

## 26. Conclusão

A infraestrutura dos Blocos 9–15 suporta integralmente os agentes especializados do Bloco 16: identidade congelada, avaliador determinístico com default deny, journal idempotente, fila durável e sinais comerciais já versionados. O que falta é o **elo de execução** — um runtime que obrigue toda ação a passar pela política — e o **elo de fechamento** — artefatos com proveniência e loop journal↔execução. Este design review propõe ambos de forma fechada, fail-closed e sem alterar nenhuma permissão existente. Nenhuma implementação ocorreu nesta fase; o documento aguarda revisão para que a Fase A seja autorizada.

```
AGENT != AUTHORITY · LLM != AUTHORITY · MEMORY != AUTHORITY
OBSERVATION != FACT CANÔNICO · SIGNAL != REVENUE
RECOMMENDATION != ACTION · POLICY != EXECUTION
```
