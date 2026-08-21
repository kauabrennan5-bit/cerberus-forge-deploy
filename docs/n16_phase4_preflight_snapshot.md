# N16 — Fase 4 — Preflight Snapshot

**PROOF_RUN_ID:** `N16_PHASE4_20260819T193123Z`  
**Timestamp UTC:** 2026-08-19T19:31:23Z  
**Objetivo:** snapshot somente leitura antes de qualquer alteração, configuração temporária ou prova da Fase 4.

## Git

```text
HEAD=c9f3e1ceb2eff65224dc6f5da260a601aae2518a
origin/main=c9f3e1ceb2eff65224dc6f5da260a601aae2518a
branch=main
```

O working tree tinha somente os documentos locais não rastreados das fases anteriores e o snapshot desta fase; não havia alteração rastreada de código. Nenhum secret foi capturado.

## Produção

```json
{
  "health": {
    "status": "ok",
    "service": "cerberus-forge-deploy",
    "version": "c9f3e1ceb2eff65224dc6f5da260a601aae2518a"
  },
  "operator": {
    "apiHealthy": true,
    "backendReady": true,
    "operatorState": "READY",
    "webhookConfigured": true,
    "webhookMatchesExpectedUrl": true,
    "pendingUpdates": 0,
    "backendSha": "c9f3e1ceb2eff65224dc6f5da260a601aae2518a"
  }
}
```

## Baseline

```text
products=13
candidates=0
candidate_evidence=0
candidate_assessment=0
affiliate_links=0
job_queue=0
publication_executions=0
commercial_cycles=0
```

O baseline estável coincide com o baseline restaurado ao final da Fase 3.

## Schema production `publication_executions`

```text
RLS: enabled
Public policies: []
UNIQUE: publication_executions_execution_key_key on execution_key
Primary key: publication_executions_pkey on execution_id
Constraints: action=PUBLISH; unique execution_key; metadata/result JSON objects; lifecycle status catalog
Indexes: candidate, execution_key unique, primary key, proof_run_id, request_id, status
```

A migration de referência continua sendo `supabase/migrations/20260820_publication_executions.sql`, aplicada na Fase 2 e compatível com o schema ativo observado.

## Regra de parada

Qualquer divergência entre este snapshot e o estado posterior, tentativa de fabricar N13/N14/N15, chamada ao provider real, publicação comercial real, alteração inesperada do catálogo, acionamento de N17–N20, Telegram, scheduler, agents ou `job_queue`, exposição de segredo, cleanup fora do conjunto da prova, SHA divergente ou configuração fake persistente interrompe a fase sem consolidação silenciosa.
