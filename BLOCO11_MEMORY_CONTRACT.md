# Bloco 11 — Contrato de Memória Operacional Durável

## Objetivo

O Bloco 11 adiciona uma memória operacional estruturada para preservar contexto entre cold starts, restarts, deploys, falhas, retries e recovery. A memória registra fatos operacionais e não substitui entidades canônicas, não cria autoridade e não reexecuta ações.

## Invariantes

- `CANONICAL PRODUCTS > OPERATIONAL MEMORY`
- `MEMORY != AUTHORITY`
- `EVENT != STATE`
- `RECOMMENDATION != DECISION`
- `DECISION != EXECUTION`
- `EXECUTION != VERIFICATION`
- `LOG != AUDIT TRAIL`
- `RECOVER CONTEXT != REPLAY ACTION`
- `MORE MEMORY != MORE AUTONOMY`

## Modelo

### Event

O contrato canônico é o contrato do Bloco 10 em `server/services/operationalEvents.ts`. Um evento representa algo que aconteceu e preserva `eventId`, `eventType`, `timestamp`, `source`, `actor`, `correlationId`, `causationId`, `severity`, `schemaVersion`, `payload`, `outcome` e `environment`. `eventId` é a identidade do evento; `correlationId` apenas agrupa eventos da mesma operação ou fluxo.

### Operation

Uma operação é uma unidade de trabalho operacional. Seus estados são `REQUESTED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `BLOCKED` e `CANCELLED`. O journal não executa transições, não inicia retries e não decide recovery; apenas registra atualizações explícitas produzidas pelo fluxo que já existe.

### Decision

Uma decisão é registrada separadamente quando houver uma escolha efetiva. `human`, `policy` e `ai` são atores distintos. Recomendação de IA nunca é aprovação humana. O Bloco 11 não cria uma nova decisão nem autoriza decisões.

### Incident

Um incidente representa uma falha operacional relevante, e não cada erro trivial. Estados: `OPEN`, `ACKNOWLEDGED`, `RECOVERING`, `RESOLVED` e `BLOCKED`. O journal preserva a relação com `operationId` e `correlationId`, mas não substitui o estado em memória do Operator nem altera sua máquina de estados.

### Recovery attempt

Uma tentativa de recovery registra `attemptId`, incidente, operação, número, estratégia, timestamps, resultado e erro. Registrar uma tentativa não executa uma ação e não permite replay automático.

## Fontes de verdade

| Entidade | Fonte de verdade |
|---|---|
| Produto | Supabase, tabela `products` |
| Clique | Fonte canônica de tracking existente |
| Evento operacional | Memória operacional, tabela `operational_events` |
| Operação | Memória operacional, tabela `operational_operations` |
| Decisão | Memória operacional, tabela `operational_decisions` quando utilizada |
| Incidente | Memória operacional, tabela `operational_incidents` quando utilizado |
| Tentativa de recovery | Memória operacional, tabela `operational_recovery_attempts` quando utilizada |
| Catálogo público | Projeção derivada |
| Estado crítico do Operator | `operator_state` e o mecanismo atual do Operator |
| Artefato de build | Projeção derivada |

A memória operacional não pode corrigir, sobrescrever ou completar dados do produto.

## Persistência e idempotência

A persistência usa migrations aditivas no Supabase, sem tocar `products`. `event_id` é chave primária de eventos. Repetição do mesmo `eventId` é tratada como replay deduplicado apenas quando o conteúdo sanitizado coincide; colisão do mesmo ID com conteúdo diferente é falha explícita. `operation_id` identifica a operação e pode possuir vários eventos. Eventos diferentes da mesma operação permanecem distintos.

## Cold start

A recuperação lê operação, eventos relacionados e incidente associado. Se uma operação estava `RUNNING` antes do restart, o contexto é marcado como não concluído e incerto; não é convertido artificialmente em sucesso ou falha e nenhuma ação é executada novamente. A lacuna de confirmação de resultado permanece explícita para um bloco posterior de idempotência/outbox.

## Segurança

Todos os payloads e metadados passam pelo mesmo sanitizador do Bloco 10. Não persistir `rawContent`, HTML externo, prompts completos, instruções externas, tokens, secrets, credenciais, chaves privadas ou conteúdo de prompt injection. Falha de persistência não pode ser apresentada como memória vazia: deve ser diagnosticada e degradar com segurança.

## Retenção inicial

Decisões, operações, incidentes, tentativas de recovery, resultados de publicação e eventos de segurança são de alta importância. Eventos diagnósticos, de saúde e repetitivos podem ter retenção menor em evolução posterior. Este bloco não executa limpeza agressiva; a retenção é uma política documentada e a remoção automática permanece fora do escopo.

## Read model

O Bloco 11 fornece somente consultas seguras para diagnóstico: operação por ID, eventos por correlação, incidente por ID, eventos recentes, última operação e contexto de cold start. Não cria dashboard, comando Telegram novo ou endpoint público.

## Rollback

O rollback consiste em remover somente o código do Bloco 11, as tabelas `operational_*` e seus índices criados pela migration. Não há rollback de produtos, catálogo, histórico canônico ou dados de tracking.

## Limites

A memória não aumenta autonomia, não cria agentes, não publica produtos, não altera campanhas, não altera preços, não executa SQL arbitrário, não cria produtos, não adiciona comandos Telegram e não reexecuta recovery. A aplicação da migration no Supabase de produção exige revisão e autorização separadas.
