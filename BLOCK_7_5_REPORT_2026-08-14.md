# CERBERUS FINDS ARCHIVE — BLOCO 7.5
## RELATÓRIO DE HARDENING ESTRUTURAL

Data: 14/08/2026
Projeto: kauabrennan5-bit/cerberus-forge-deploy
Branch: main
Escopo: Bloco 7.5 בלבד. O Bloco 8 não foi iniciado.

## STATUS EXECUTIVO

O hardening foi implementado localmente e validado com lint, 47 testes e build completo. A implementação inclui:

- endpoint GET /health mínimo, rápido, sem consulta ao Supabase e sem mutação;
- watchdog independente via GitHub Actions, com cron a cada 15 minutos;
- timeout de 10 segundos para o watchdog;
- alerta Telegram somente em transições HEALTHY -> DOWN e DOWN -> HEALTHY;
- deduplicação de alertas por estado persistido;
- persistência mínima do estado crítico do Operator;
- boot recovery fail-safe;
- auto-heal bloqueado em OBSERVE/SAFE_MODE quando a persistência não está confirmada;
- circuit breaker, cooldown, timeout, retry limitado e orçamento global de auto-heal;
- rate limiting configurável por IP nos endpoints de administração, catálogo, analytics e operações caras;
- orçamento horário configurável para chamadas Gemini;
- migration SQL idempotente e sem dados comerciais;
- testes unitários isolados para guards e estado persistido.

A conclusão de produção ainda não deve ser declarada como totalmente concluída antes de duas ações externas: aplicar a migration `supabase/migrations/20260814_operator_state.sql` no projeto Supabase canônico e deixar o Render implantar este commit. O serviço de produção observado antes do novo commit não possuía `/health`: a URL retornou a SPA do catálogo, não o JSON de liveness.

## ARQUITETURA DO WATCHDOG

Arquivo: `.github/workflows/cerberus-watchdog.yml`
Executor: GitHub Actions, fora do Render Web Service.
Frequência: a cada 15 minutos e execução manual via workflow_dispatch.
Timeout do job: 2 minutos.
Timeout HTTP: 10 segundos.
Permissão: `contents: write`, exclusivamente para persistir o arquivo de transição do watchdog.

Arquivo executor: `scripts/watchdog.mjs`.
URL padrão verificada: `https://cerberus-forge-deploy-backend.onrender.com/health`.
URL pode ser sobrescrita por `CERBERUS_HEALTH_URL`.

O watchdog verifica apenas:

- resposta HTTP 200;
- timeout ou erro de conexão;
- transição de estado anterior para estado atual.

Não consulta catálogo, não cria produto, não registra clique, não dispara auto-heal e não executa deploy.

A persistência local no repositório ocorre somente quando há transição de estado ou no primeiro ciclo. HEALTHY -> HEALTHY não cria commit recorrente. Se um alerta Telegram não for confirmado, o watchdog falha com código de processo diferente de zero e não persiste a transição como confirmada.

## SECRETS DO GITHUB

A página autenticada do repositório confirmou em 14/08/2026 que estes dois Repository Secrets existem:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_CHAT_ID`

Nenhum valor foi visualizado, copiado para arquivos ou exibido em logs.

O comando CLI de consulta de secrets retornou HTTP 403 por limitação da integração; a confirmação foi feita na página autenticada do GitHub, que mostrou os nomes dos secrets sem valores.

`CERBERUS_HEALTH_URL` é opcional porque o executor possui a URL de produção como default. `WATCHDOG_TIMEOUT_MS` e `WATCHDOG_STATE_PATH` são variáveis não secretas do workflow.

## PERSISTÊNCIA DO OPERATOR

Migration: `supabase/migrations/20260814_operator_state.sql`.

Tabela: `public.operator_state`.

Campos persistidos:

- `state_key`;
- `action_id`;
- `incident_id`;
- `circuit_state`;
- `failure_count`;
- `retry_count`;
- `last_execution_at`;
- `cooldown_until`;
- `circuit_open_until`;
- `last_transition_at`;
- `metadata` mínimo;
- `updated_at`.

A tabela possui chave primária, checks de não negatividade, índice por ação e índice parcial para circuitos abertos. RLS é habilitado e não são criadas policies públicas. O backend usa a credencial privilegiada já existente no servidor.

A migration não foi executada automaticamente. Motivo: o ambiente atual não possui uma sessão/credencial administrativa verificável do projeto Supabase canônico, e `webdev_execute_sql` pertence ao projeto local `trigger-proxy`, não ao banco do Cerberus. Executar SQL nessa ferramenta sem confirmar o alvo poderia alterar o banco errado. A aplicação deve ser feita no SQL Editor do projeto Supabase correto, com revisão administrativa.

Enquanto a migration não estiver aplicada ou enquanto `operator_state` não puder ser lida, o Operator inicia em `SAFE_MODE`, mantém `OBSERVE` e bloqueia modos ativos de auto-heal. Isso é comportamento fail-safe, não falha silenciosa.

## HEALTH ENDPOINT

Contrato local implementado:

GET /health

Resposta esperada:

{
  "status": "ok",
  "service": "cerberus-forge-deploy",
  "version": "<commit ou unknown>",
  "timestamp": "<ISO-8601>"
}

A rota não consulta Supabase, não executa o scheduler, não chama GitHub, não chama Telegram e não realiza mutação.

Validação em produção antes deste commit:

- URL consultada: `https://cerberus-forge-deploy-backend.onrender.com/health`
- Resultado observado: SPA do catálogo, não JSON de health.
- Interpretação: o deploy ativo no momento ainda não continha esta rota ou o hostname estava apontando para um artefato diferente.
- Status: PRODUÇÃO AINDA NÃO VALIDADA para o novo contrato.

## RATE LIMITING

Os limites são por IP, com janela de 60 segundos e buckets em memória do processo:

- `ADMIN_RATE_LIMIT_PER_MINUTE`: default 30;
- `CATALOG_RATE_LIMIT_PER_MINUTE`: default 120;
- `ANALYTICS_RATE_LIMIT_PER_MINUTE`: default 30;
- `EXPENSIVE_RATE_LIMIT_PER_MINUTE`: default 10.

Resposta de excesso:

- HTTP 429;
- código `RATE_LIMITED`;
- header `Retry-After`;
- header `X-RateLimit-Remaining`.

O tracking legítimo continua disponível, mas é limitado para evitar abuso. O rate limiting é proteção operacional em memória; não é apresentado como proteção distribuída global. Para múltiplas instâncias, deve ser substituído ou complementado por armazenamento distribuído em etapa futura.

## RETRY, CIRCUIT BREAKER E CUSTO

O Safe Auto-Heal continua usando Action Registry fechado. Não há execução dinâmica, shell arbitrário, SQL em texto ou ação crítica automática.

O orçamento global padrão é de 20 tentativas de auto-heal por hora. Ações retryable usam no máximo o número de retries registrado, backoff exponencial limitado e timeout individual. Circuit breaker abre após três falhas e permanece aberto por 30 minutos. Falha de persistência força OBSERVE/SAFE_MODE.

Chamadas Gemini possuem orçamento horário configurável por `GEMINI_HOURLY_BUDGET`, default 20. Quando o orçamento é atingido, o sistema não inventa conteúdo; mantém os dados disponíveis do scraper e registra a limitação.

## VALIDAÇÕES TÉCNICAS

- TypeScript/lint: PASSOU (`npm run lint`).
- Testes: PASSOU; 47 testes, 47 aprovados, 0 falhas.
- Build: PASSOU (`npm run build`).
- Catálogo obtido durante o build: 10 produtos pela API canônica de produção.
- Vite: PASSOU.
- Bundle backend: PASSOU.
- Sintaxe watchdog: PASSOU (`node --check scripts/watchdog.mjs`).
- `git diff --check`: PASSOU.
- Varredura de padrões de credenciais versionadas: nenhum padrão encontrado após a remoção do literal sintético do teste.
- Watchdog em dois ciclos contra `/health`: HEALTHY, HTTP 200, sem alerta repetitivo e com estado estável.

## LIMITAÇÕES RESIDUAIS

1. O novo endpoint `/health` ainda precisa ser servido pelo Render após o commit.
2. O workflow agendado precisa ser executado no GitHub após o commit para confirmar alerta/estado no ambiente real.
3. A migration precisa ser aplicada no Supabase canônico.
4. O estado do watchdog, quando transitado, cria commit automático de estado na `main`; o workflow não cria commits em ciclos HEALTHY -> HEALTHY.
5. Rate limiting é local por instância e não substitui um limitador distribuído para múltiplas réplicas.
6. O domínio `cerberusfinds.com` não foi usado como evidência nesta etapa; a validação foi feita no hostname Render do backend.
7. Não foi criado produto, clique, revisão Telegram ou dado de teste no Supabase.

## PRÓXIMAS AÇÕES ADMINISTRATIVAS OBRIGATÓRIAS

1. Aplicar o arquivo SQL da migration no projeto Supabase correto.
2. Aguardar o deploy automático do commit do Bloco 7.5 no Render.
3. Executar manualmente o workflow `Cerberus external watchdog` uma vez no GitHub Actions.
4. Confirmar no log do workflow: HTTP 200, status HEALTHY e `alert=no`.
5. Confirmar novamente a URL `/health` e verificar o JSON, não a SPA.
6. Não alterar `TELEGRAM_BOT_TOKEN` ou `TELEGRAM_ADMIN_CHAT_ID` no GitHub depois de salvos, exceto por rotação administrativa.

## DECISÃO

Bloco 7.5 local: IMPLEMENTADO E VALIDADO TECNICAMENTE.
Bloco 7.5 em produção: PENDENTE DE DEPLOY E MIGRATION.
Bloco 8: NÃO INICIADO.
