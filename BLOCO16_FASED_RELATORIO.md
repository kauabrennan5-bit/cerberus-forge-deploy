# Bloco 16 — Fase D: Agent Runtime Execution Core (Consolidação em Produção)

**Status: COMPLETO — PUBLICADO**
**Autor:** Manus AI | **Data:** 16/08/2026
**SHA final em produção:** `c7d7680a6092897a1e7ba56296375f95200c7c46`
**URL:** [https://cerberus-forge-deploy.onrender.com](https://cerberus-forge-deploy.onrender.com) (backend em `cerberus-forge-deploy-backend.onrender.com`)

---

## 1. Resumo Executivo

A Fase D concluiu a transformação do Agent Runtime (Bloco 16) em uma **fronteira real de execução governada**: o runtime agora possui persistência própria do journal de execuções, um catálogo de executores de prova, o fluxo oficial de aprovação com re-avaliação de política e rotas administrativas de execução. A consolidação foi publicada em produção em três commits (`c554d59`, `8e9f681`, `c7d7680`), todos com push para `main` sem force push, e o deploy automático do Render foi validado após cada um.

Todos os requisitos de contorno foram respeitados: **nenhum agente foi habilitado** (os nove permanecem `DRAFT` / `enabled: false`), **nenhum executor real foi conectado** (Telegram e SafeAutoHeal seguem `NOT_CONNECTED`), **nenhuma ação ignora o Policy Engine** (o Policy Engine do Bloco 15 continua a autoridade única de autorização), e a persistência foi estritamente aditiva, com RLS ativo e zero políticas públicas.

---

## 2. O Que Foi Implementado na Fase D

### 2.1 Persistência do journal de execuções (`agent_executions`)

A migration `20260816_agent_executions.sql` foi aplicada em produção após apresentação e autorização. Ela é estritamente aditiva — nenhuma tabela existente foi alterada. As características de segurança implementadas são:

| Aspecto | Implementação |
|---|---|
| RLS | `ALTER TABLE agent_executions ENABLE ROW LEVEL SECURITY` — ativo |
| Políticas públicas | Zero políticas para `anon`/`authenticated` (verificado em produção: 0) |
| Catálogos fechados | CHECK constraints nos enums `decision`, `lifecycle_state`, `executor_status`, `risk`, `requested_by`, `tool`, `action` — nenhum valor inventado aceita |
| Idempotência | UNIQUE em `(intention_key, identity_context_digest)` — colisão de intenção idêntica resolve por deduplicação; contexto divergente é rejeitado como `conflict_rejected` |
| Antivazamento | `input_fingerprint` e `identity_context_digest` jamais contêm o input bruto; `metadata` jsonb é sanitizado (padrão de segredos: padrões de senha/token, `x-admin-password`, tokens do Telegram) |
| Trilha | FK restritivas omitidas de propósito — o journal permanece independente (linkage ao Decision Journal do Policy Engine apenas via `evaluation_id` indexada); colunas `correlation_id` e `request_id` com UNIQUE para trilha determinística |

O repositório `server/repositories/agentExecutionsRepository.ts` implementa a persistência com o mesmo padrão dos Blocos 13-15: injeção explícita de client (sem singleton oculto), validação de enum antes do insert, deduplicação idempotente por intention, e tratamento do cenário sem Supabase configurado como **fail-closed explícito** (`journalFailure: true`).

### 2.2 Tool Adapters e executor de prova

O `ADAPTER_REGISTRY` (inicialmente vazio, por desenho) agora contém exatamente **um** executor: o `ProofExecutor`, um adapter controlado para `products.read` que declara risco `LOW`, usa o mesmo contrato `ToolAdapterContract` dos futuros executores reais e **jamais produz invocação externa** (`externalInvocation` sempre `null`). Executores reais (Telegram, SafeAutoHeal) permanecem ausentes do registry e são auditados como `NOT_CONNECTED`. O reason code fechado `PLAN_CREATED_PROOF_EXECUTED` foi adicionado ao catálogo do runtime. A pipeline mapeia a resolução do adapter ao `executorStatus` da execução.

### 2.3 Aprovação oficial com re-avaliação obrigatória

`server/agentRuntime/approvalPersisted.ts` introduz o `ApprovalStore` persistido, com: criação de aprovação oficial vinculada ao registro do journal (expirável por TTL, revogável), e o provider oficial que **resolve a aprovação apenas contra os dados reais da execução** — o `approvalId` declarado pelo agente no request não é aceito como prova ("aprovação declarada nunca é prova"). O fluxo da rota de prova executa, nesta ordem: approval oficial → **re-avaliação da política contra o estado atual** (`POLICY_CHANGED` → negação da prova) → execução de prova (somente com `executeProof=true`) → atualização do journal. Nenhum executor real executa em nenhum caminho.

### 2.4 Rotas administrativas do runtime

Três rotas foram integradas ao servidor com `requireAdminAuth` (mesmo mecanismo dos Blocos 13-15):

| Rota | Função |
|---|---|
| `POST /api/agent-runtime/execute` | Submete execução governada; retorna decisão, reason code, lifecycle, executorStatus, idempotência e se foi persistida |
| `POST /api/agent-runtime/approve` | Cria aprovação oficial para execução registrada; rejeita execuções que não estejam em `REQUIRES_APPROVAL`; nunca executa nada |
| `GET /api/agent-runtime/executions` | Leitura paginada do journal (admin-only, read-only) |

Uma correção de segurança importante foi aplicada e publicada (`8e9f681`): **o journal de execução registra somente a fronteira ALLOW**. Negações estruturais (request inválido, identidade desligada, orçamento não alocado) não geram registro — o Decision Journal do Policy Engine (Bloco 15) já registra todas as decisões do engine, e gravar negações aqui com campos vazios criaria resíduos não idempotentes (`execution_id=""`). O campo `memoryScope` com default `NONE` também foi corrigido, pois `NONE` não pertence ao catálogo fechado de escopos — o default agora é vazio, o que resulta no negação `SCOPE_NOT_SUBSET` do engine (fail-closed correto).

---

## 3. Provas e Validação

### 3.1 Provas locais (gates)

A suíte local completa alcançou **535/535 testes passando** (505 da Fase C + 30 novos/atualizados da Fase D), cobrindo: persistência do journal com idempotência real por intention, rejeição de colisão com contexto divergente (`conflict_rejected`), execução idêntica duplicada (`identical_duplicate`), sanitização de segredos no metadata, atualizações restritivas do lifecycle (somente transições válidas da máquina de 13 estados), fallback sem client, ApprovalStore com expiração/revogação/`POLICY_CHANGED`, catálogos fechados de enums e reason codes, além do registry contendo exclusivamente o proof executor. TypeScript e build sem erros em todos os commits.

### 3.2 Prova viva em produção (pós-deploy `c7d7680`)

| Verificação | Resultado |
|---|---|
| `GET /health` (front + backend) | `ok` — versão `c7d7680a6092897a1e7ba56296375f95200c7c46` |
| `POST /api/agent-runtime/execute` (payload completo: discovery-agent, `products.read` + `READ_PRODUCT`, escopo PRODUCT, idempotência declarada) | `DENY / IDENTITY_DISABLED` — `persisted: false` (agente desligado → fail-closed, nada escrito) |
| `GET /api/agent-runtime/executions` | `total: 0` — **zero resíduos** |
| `GET /api/products` | 12 produtos — idêntico ao pré-deploy |
| `GET /api/telegram-status` | `apiHealthy: true`, `webhookConfigured: true`, `pendingUpdates: 0`, `operatorState: READY` |
| Banco: `agent_executions` RLS ativo / políticas `anon` | 1 / **0** |
| Banco: `job_queue` linhas | 0 (scheduler intacto/desligado) |
| Banco: `policy_evaluations` | intacto (1 avaliação registrada pela prova, Decision Journal operante) |
| Banco: resíduo `execution_id=""` da primeira iteração | **Removido**; `cnt=0` confirmado |

A decisão `DENY / IDENTITY_DISABLED` é o resultado esperado e correto: com todos os agentes em `DRAFT`/disabled, nenhuma execução alcança a fronteira ALLOW — exatamente o fail-closed projetado ("nenhum agente habilitado, nenhum executor real, nenhum plano executa sem policy"). A gravação real do journal por execuções ALLOW permanece provada pelos 30 testes unitários da Fase D (fake store validado contra os contratos do repositório); o gateway em produção foi validado ponta a ponta para o caminho de negação e para o caminho de leitura do journal.

### 3.3 Correções publicadas durante a validação

| Commit | Correção | Justificativa |
|---|---|---|
| `8e9f681` | Journal registra somente `ALLOW`; reason code real do runtime | Negações estruturais com campos vazios poluiriam o journal (resíduo não idempotente) |
| `c7d7680` | Default `memoryScope: []` na rota | `NONE` não pertence ao catálogo fechado de escopos; default vazio → engine nega `SCOPE_NOT_SUBSET` |

Nenhuma alteração em products, catálogo, Telegram, Operator, job queue ou Blocos 9-15 foi feita.

---

## 4. Arquivos Publicados

| Arquivo | Papel |
|---|---|
| `supabase/migrations/20260816_agent_executions.sql` | Migration aditiva aplicada em produção |
| `server/repositories/agentExecutionsRepository.ts` | Journal persistente (insert/update/list, sanitização, idempotência) |
| `server/agentRuntime/approvalPersisted.ts` | ApprovalStore oficial + provider persistido |
| `server/agentRuntime/toolAdapter.ts` | ADAPTER_REGISTRY com ProofExecutor controlado |
| `server/agentRuntime/pipeline.ts` + `validation.ts` | Integração executorStatus/gate + reason codes fechados |
| `server/routes/agentRuntimeRoutes.ts` | Rotas admin execute/approve/executions |
| `server.ts` | Injeção do client do journal + registro das rotas |
| `server/agentRuntime/{contracts,types,runtime,execution,lifecycle,idempotency,approval}.ts` | Núcleo do Bloco 16 (Fase C) publicado nesta consolidação |
| `tests/agentRuntime{,Execution,FaseD}.test.ts` | 535 testes (Fase C + D) |
| `BLOCO16_{DESIGN_REVIEW,FASEA,FASEC,FASED}_RELATORIO.md` | Rastreabilidade de design e fases |

## 5. Pendências e Riscos Residuais

**Pendente deliberado (fora do escopo):** os executores reais (Telegram, SafeAutoHeal) seguem `NOT_CONNECTED` e os agentes em `DRAFT`/disabled por política — sua habilitação será objeto de proposta e autorização futura (Bloco 16, próximos ciclos). O caminho completo `REQUIRES_APPROVAL → approve → executeProof` foi validado em testes unitários e é acessível via rotas em produção, mas não pôde ser exercitado ponta a ponta com agente habilitado em produção justamente porque nenhum agente está habilitado (proteção intencional).

**Risco residual: nenhum crítico.** As divergências de rota observadas durante a validação (default de `memoryScope` e persistência de negações) foram identificadas pela própria prova viva, corrigidas, publicadas e re-validadas — a prova final não encontrou nenhum gate falho.

---

## 6. Conclusão

> O Bloco 16 está 100% consolidado em produção no SHA `c7d7680`: o runtime governa execução (não a executa sem o Policy Engine), persiste apenas o que é permitido (fronteira ALLOW), registra aprovação oficial com re-avaliação obrigatória, executa somente provas controladas, e mantém zero resíduos, zero políticas públicas, doze produtos intactos e Telegram/Operator/job queue saudáveis.

**MEMORY != AUTHORITY · OBSERVATION != FACT CANÔNICO · RECOMMENDATION != ACTION**
