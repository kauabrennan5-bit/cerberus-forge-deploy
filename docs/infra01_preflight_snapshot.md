# INFRA-01 — Snapshot de Preflight

## Identificador da prova

`INFRA_PROOF_RUN_ID=INFRA_EGRESS_20260819T210055Z`

Observado em `2026-08-19T21:00:55Z` no ambiente local, antes de qualquer alteração.

## Git

- Repositório: `/home/ubuntu/cerberus-forge-deploy`
- Branch: `main`
- HEAD local: `44a31d687ae06d2398e6651ad1009e3acfbeefbd`
- `origin/main`: `44a31d687ae06d2398e6651ad1009e3acfbeefbd`
- Estado: sem alterações versionadas; somente documentação local não rastreada já existente das fases anteriores.

## Produção

Endpoint: `https://cerberus-forge-deploy-backend.onrender.com`

- `/health`: `status=ok`
- SHA servido: `44a31d687ae06d2398e6651ad1009e3acfbeefbd`
- `apiHealthy=true`
- `backendReady=true`
- `operatorState=READY`
- `webhookConfigured=true`
- `webhookMatchesExpectedUrl=true`
- `pendingUpdates=0`
- `backendSha=44a31d687ae06d2398e6651ad1009e3acfbeefbd`
- `secretConfigured=false` no endpoint de status; nenhum valor secreto foi capturado.

## Baseline canônico Supabase

Consulta somente leitura com `LIMIT 1`, observada em `2026-08-19T21:01:28Z`:

- `products=13`
- `candidates=0`
- `candidate_evidence=0`
- `candidate_assessment=0`
- `affiliate_links=0`
- `job_queue=0`
- `publication_executions=0`
- `commercial_cycles=0`

## Decisão do preflight

Baseline íntegro. Não houve escrita em banco, alteração de catálogo, execução de Telegram, scheduler, agente, job ou publicação. O diagnóstico INFRA-01 pode prosseguir para a auditoria do caminho de coleta.
