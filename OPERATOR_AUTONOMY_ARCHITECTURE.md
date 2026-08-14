# Cerberus Finds Archive — Operator Autonomy Architecture

**Repositório:** `kauabrennan5-bit/cerberus-forge-deploy`  
**Branch de produção:** `main`  
**Escopo:** Bloco 6 — Autonomia Operacional e Recuperação

O Bloco 6 transforma o Cerberus Operator em uma camada autônoma de infraestrutura **determinística e fail-safe**. A autonomia é limitada a decisões sobre ações que já existem no Action Registry do Bloco 5. Não há execução de shell, SQL destrutivo, mudança de secrets, alteração de schema, exclusão de produtos/cliques ou alteração automática de código.

---

## 1. Estado Operacional Consolidado

O `OperationalStateStore` mantém, em memória, o último estado de Backend, Supabase, Produtos, Catálogo, Tracking, Analytics, Telegram, Site, Deploy e GitHub. Para cada componente são mantidos status, última verificação, último erro, último recovery, incidente ativo, falhas consecutivas e duração de indisponibilidade quando aplicável.

Os status aceitos são `HEALTHY`, `DEGRADED`, `DOWN`, `UNKNOWN` e `RECOVERING`. O estado global é derivado das observações reais; valores fictícios não são utilizados.

## 2. Máquina de Estados

O Operator usa a máquina determinística `IDLE → CHECKING → DIAGNOSING → [WAITING_APPROVAL | HEALING | RESOLVED | ESCALATED]`. Uma ação passa por `HEALING → VALIDATING → RECOVERING → RESOLVED`. Transições fora da tabela autorizada são recusadas e registradas como tentativa inválida, sem modificar o estado.

## 3. Decision Engine e Níveis de Autonomia

O Decision Engine recebe modo, risco, ação registrada, aprovação, falhas e circuit breaker. Ele retorna somente `NO_ACTION`, `AUTO_HEAL`, `WAIT_APPROVAL` ou `ESCALATE`; ele não executa nada.

| Nível | Modo | Política |
|---|---|---|
| LEVEL 0 | `OBSERVE` / `DRY_RUN` | Diagnostica; não altera arquivos, dados, GitHub ou serviços externos. |
| LEVEL 1 | `SAFE_AUTO_HEAL` | Executa somente ações `LOW` já registradas e com pré-condições válidas. |
| LEVEL 2 | `ADMIN_APPROVAL` | Ações `MEDIUM` ficam pendentes até aprovação explícita de administrador autorizado. |
| LEVEL 3 | HIGH / CRITICAL | Nunca são automáticas; resultam em escalation. |

## 4. Recovery Orchestrator e Escalation

O fluxo é `DETECTED → DIAGNOSED → ACTION SELECTED → ACTION EXECUTED → VALIDATION → RECOVERED`. O resultado só é considerado recuperado após validação pós-ação. Falha, timeout, ausência de ação autorizada, circuito aberto ou risco elevado passam o incidente para `ESCALATED`; o Operator interrompe novas tentativas automáticas e apresenta o motivo ao administrador no Telegram.

## 5. Health Checks E2E

- **Backend:** consulta a API canônica de produtos e valida a coleção.
- **Supabase / Produtos / Analytics:** consultas somente leitura a `public.products` e `public.product_clicks`.
- **Catálogo:** compara IDs e quantidade da projeção pública com os produtos canônicos ativos.
- **Tracking:** valida a disponibilidade das tabelas de suporte sem criar cliques falsos.
- **Telegram:** usa `getMe` exclusivamente no servidor e não registra o token.
- **GitHub:** consulta pública da branch `main` e registra apenas o SHA curto.
- **Site / Deploy:** valida que `products.json` público possui conteúdo mínimo.

## 6. Auditoria, Segurança e Limitações

O audit log preserva identificador de ação/incidente, resultado, duração e validação, mas nunca tokens, passwords ou service-role keys. Callbacks Telegram permanecem atrás da whitelist administrativa existente.

O histórico e o estado operacional são intencionalmente **em memória**. Esse desenho não cria uma nova fonte de verdade, mas reinicializações do Render removem o histórico recente. O scheduler interno continua sujeito a sleep/cold start no plano gratuito do Render; verificação manual pelo Telegram permanece disponível e a arquitetura pode receber um cron externo no futuro, sem ser adicionado neste bloco.
