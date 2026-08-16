# BLOCO 15 — SECURITY-AGENT INVESTIGATION

**Projeto:** Cerberus Finds Archive (cerberus-forge-deploy)
**Data:** 16 de agosto de 2026
**Autor:** Manus AI
**Status:** READY FOR REVIEW — nenhum commit, push ou deploy foi realizado

---

## 1. Registro encontrado

Existe exatamente **1 registro** em `public.policy_evaluations` em produção, criado em **16/08/2026 às 03:59:29 UTC** — durante a janela de consolidação do Bloco 15, minutos antes do relatório final anterior.

| Campo | Valor |
|---|---|
| evaluation_id | `pev-01cf2c2de78493b952166595e2f54bdb223c8d65237fbc8cccc0d64c5f72` |
| agent_id / agent_version | `security-agent` / `1.0` |
| policy_version / policy_engine_version / policy_reason_code_version | `1.0` / `1.0` / `1.0` |
| decision / reason_code | `DENY` / `AGENT_DISABLED` |
| tool / action / target_table / memory_scope | `operational.read` / `READ_OPERATIONAL_EVENT` / `operational_events` / `OPERATIONAL_EVENTS` |
| risk | `LOW` |
| checks | `enabled: FAIL`, todos os demais `PASS` |
| reason | `Agent "security-agent" is disabled (enabled=false). Declarative status only; no execution occurred.` |
| correlation_id / causation_id / context / approval_state / metadata | `null` / `null` / `null` / `null` / `{}` |
| created_at | `2026-08-16T03:59:29.929Z` |

## 2. Origem comprovada

**RESÍDUO DE PROVA VIVA.** O registro foi produzido por mim durante a verificação do Bloco 15, ao chamar `POST /api/policy/evaluate` na produção (backend Render) com `persist=true` — ou seja, através da rota real de avaliação, que em produção injeta o cliente Supabase real (`server.ts`, linha 979: `setPolicyJournalClient(productsRepository.supabase)`). O payload usado reproduzia exatamente o contrato do `security-agent`. O relatório anterior continha uma afirmação incorreta ("provas vivas usaram exclusivamente cliente fake local") que esta investigação corrige: naquele momento a verificação de idempotência realmente usou banco fake, mas um probe adicional foi enviado pela rota de produção com persistência real, gerando este único registro.

A prova é conclusiva: o registro persistido carrega o **mesmo request fingerprint** (`01cf2c2d...`) que o payload do fixture de testes (ver seção 4) e o mesmo contrato usado no probe. Nenhum outro componente do sistema chama `evaluatePolicy` ou `insertEvaluation` — o único call site de produção é a rota do Bloco 15.

## 3. Cadeia de execução reconstruída

```
PROBE MANUAL (provador, via rota de produção com persist=true, admin-auth)
   ↓  POST /api/policy/evaluate — payload do security-agent
   ↓  tool=operational.read, action=READ_OPERATIONAL_EVENT,
   ↓  target_table=operational_events, risk=LOW, memory_scope=OPERATIONAL_EVENTS
POLICY ENGINE (100% determinístico)
   ↓  registry: security-agent EXISTE, status=DRAFT, enabled=false
   ↓  checks: enabled=FAIL → decision=DENY, reason=AGENT_DISABLED
INSERT EVALUATION (cliente Supabase REAL injetado em server.ts:979)
   ↓  idempotência OK, inserted
POLICY_EVALUATIONS — 1 registro, corretamente NEGADO
```

## 4. Evidências

1. O `security-agent` **existe no Agent Registry congelado** (`server/agentRegistry/agents.ts`, linhas 182–199): status `DRAFT`, `enabled: false`, tools `operational.read`/`operator.mode.read`, ações `READ_OPERATIONAL_EVENT`, maxRisk `LOW`, memoryScope `OPERATIONAL_EVENTS`. A lista `AGENT_REGISTRY` tem 10 definições congeladas (9 analíticos + security-agent). A afirmação anterior de que "o agente não estaria no registry" estava **errada** — foi corrigida por esta investigação.
2. O fixture dos testes de rota (`tests/policyRoutes.test.ts`, `makeRequest()`, linhas 43–57) usa por padrão exatamente este mesmo payload do security-agent — o mesmo request fingerprint encontrado no registro de produção.
3. O único call site de produção de `evaluatePolicy`/`insertEvaluation` é `POST /api/policy/evaluate` (`server/routes/policyEngineRoutes.ts`); nem Telegram, nem Operator, nem job queue, nem código legado produzem avaliações.
4. A injeção do cliente Supabase real no journal ocorre apenas quando `productsRepository.supabase` existe (`server.ts`, linha 979) — ou seja, apenas no runtime real, jamais nos testes (que injetam cliente fake).
5. O registro tem `correlation_id: null`, `context: null`, `metadata: {}` — assinatura de chamada sem proveniência declarada, consistente com um probe manual ad hoc.

## 5. Causa raiz

Combinação de dois fatores: (a) o fixture de testes do Bloco 15 usa o contrato do security-agent — um agente **DRAFT desabilitado** do próprio registry — como payload padrão de testes de rota; (b) um probe foi enviado à rota de produção com `persist=true` durante a consolidação, gravando no banco real. A "aparição" do security-agent não é anomalia de identidade: é o **funcionamento correto e pretendido da política** (agent DRAFT desabilitado → DENY/AGENT_DISABLED).

## 6. Por que o Policy Engine respondeu DENY

O `security-agent` está registrado com `enabled: false`. A regra de habilitação do motor é determinística: agente desabilitado produz `decision: DENY`, `reason_code: AGENT_DISABLED`, com o check `enabled: FAIL` e todos os demais `PASS` (o request usava exclusivamente capacidades dentro do contrato do agente — risk LOW ≤ maxRisk LOW, tool, action, table e scope todos autorizados). O DENY bloqueia a ação e a razão é explicitamente declarativa ("no execution occurred"). **POLICY DENY != BUG** — neste caso o DENY é exatamente o comportamento esperado para um agente DRAFT.

## 7. Existe ou não drift

**Não existe drift de identidade.** Comparação completa por fonte:

| agent_id | Registry (código) | Call sites ativos | Policy Engine | Banco (policy_evaluations) | Status |
|---|---|---|---|---|---|
| security-agent | PRESENTE (DRAFT, enabled=false) | Nenhum em produção (rota usada manualmente) | DENY/AGENT_DISABLED correto | 1 registro (prova viva) | Conforme o design |
| 9 agentes analíticos | PRESENTES | Nenhum call site ativo (Bloco 15 só avalia) | — | 0 registros | Conforme o design |
| (nenhum outro) | — | — | — | 0 registros | — |

O único achado de "falha" é de **proveniência**: o registro de produção não carrega `context`/`correlation_id`, o que impossibilita auditoria retrospectiva da origem. Não é drift, é ausência de metadado opcional.

## 8. Correção aplicada

Correção mínima local (nenhuma alteração de registry, engine, reason codes, risco, permissões, tabelas, job_queue, Telegram, Operator ou watchdog; nenhuma migration):

1. **Teste de regressão de proveniência (D06b)** em `tests/policyRoutes.test.ts`: avalia com `persist=true` e `context=live_probe|security_agent_contract_test`, persiste e verifica via `GET /api/policy/journal?evaluation_id=...` que o registro armazenado carrega o context intacto — comprovando o mecanismo de proveniência já existente na rota (o campo `context` já existe no schema e é aceito/normalizado pelo `validateEvaluatePayload`).
2. **Registro documental** desta investigação no repositório (este arquivo), corrigindo a afirmação errada do relatório final anterior.

## 9. Arquivos alterados (local, não publicados)

| Arquivo | Alteração |
|---|---|
| `tests/policyRoutes.test.ts` | Novo teste de regressão D06b (proveniência do context persistido) |
| `BLOCO15_SECURITY_AGENT_INVESTIGATION.md` | Novo — relatório desta investigação |

## 10. Testes adicionados

| Teste | Comprovação |
|---|---|
| D06b (novo) | Avaliação persistida com context de proveniência carrega o context intacto no journal, sem alterar a decisão (DENY/AGENT_DISABLED) |
| 332 testes pré-existentes | Agentes não registrados continuam DENY; AGENT_DISABLED determinístico; idempotência; journal correto |

## 11. Gates

| Gate | Resultado |
|---|---|
| `npm test` | **333 testes, 333 pass, 0 fail** |
| `npx tsc --noEmit` | OK, zero erros |
| `npm run build` | OK |
| `git diff --check` | OK |

## 12. Impacto em produção

**Nenhum.** Nenhuma alteração foi publicada. O registro existente permanece no banco (preservação de auditoria — seção 16). Production SHA permanece `d8c3b2f` (conteúdo de `4e55892` incluso), `/health` ok nas duas instâncias, 12 produtos intactos.

## 13. Impacto no Agent Registry

**Nenhum.** O `security-agent` já está no registry congelado como DRAFT desabilitado — posição correta. Nenhuma inclusão, remoção, versão ou permissão alterada.

## 14. Impacto nas permissões

**Nenhum.** Nenhuma permissão nova foi criada; nenhum agente existente teve permissões ampliadas ou reduzidas; maxRisk inalterado.

## 15. Impacto no Policy Engine

**Nenhum.** A fórmula do motor, o catálogo de reason codes e os níveis de risco permanecem idênticos. O DENY do security-agent é o comportamento projetado.

## 16. Decisão sobre o registro existente

**PRESERVAR sem modificação.** O registro é uma decisão real e correta do motor, com valor de auditoria (prova de que o journal registra até negações). Apagá-lo destruiria evidência. A regra de proveniência recomenda não apagar histórico. Uma eventual limpeza específica desse registro (DELETE por evaluation_id) exige **autorização explícita sua** — não foi executada.

Se desejar, também é possível *enriquecer* o registro com `context`/`correlation_id` via UPDATE, mas isso exige autorização específica antes de qualquer alteração de banco, conforme a Fase 8 do prompt.

## 17. Riscos residuais

O risco principal é **processual, não técnico**: probes futuros enviados à rota de produção com `persist=true` sem `context` produzirão registros sem proveniência, repetindo a situação investigada. O teste D06b mitiga tecnicamente (garante que o mecanismo de proveniência funciona), mas a disciplina operacional de sempre declarar `context` em probes reais depende do operador. Adicionalmente, o registro de produção permanece sem metadados — aceita-se como fato histórico.

## 18. Recomendação

Não registrar nada novo e não alterar a arquitetura. Recomendado para aprovação (na sua revisão): (1) o teste D06b e o documento de investigação podem ser publicados juntos em um commit único, já que a alteração é puramente documental/teste e não altera comportamento de produção; (2) estabelecer como runbook que todo probe em produção use `context=prova_viva|<bloco>|<teste>`; (3) decidir sobre o registro existente (preservar ou autorizar limpeza pontual).

## Classificação final obrigatória

- [ ] FALSO POSITIVO DE TESTE
- [x] **RESÍDUO DE PROVA**
- [ ] CÓDIGO LEGADO
- [ ] DRIFT DE IDENTIDADE
- [ ] CHAMADA EXTERNA NÃO AUTORIZADA
- [ ] BUG DE INTEGRAÇÃO
- [ ] AGENTE LEGÍTIMO NÃO REGISTRADO
- [ ] OUTRO

## security-agent deve ser adicionado ao Agent Registry?

**NÃO** — porque ele **já está** no Agent Registry congelado, como 10ª definição (`SECURITY_AGENT`, `server/agentRegistry/agents.ts`, linhas 182–199), com status `DRAFT` e `enabled: false`. A questão correta não é "adicionar" e sim "habilitar", e essa decisão deve ser separada e explícita (designar o papel operacional do agente, definir quando sair do DRAFT, e quem o executará), fora do escopo desta investigação. O DENY encontrado é a política funcionando exatamente como projetada: um agente em rascunho, desabilitado, tentando operar é corretamente negado e corretamente auditado.
