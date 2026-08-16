#!/bin/bash
# Prova viva controlada do Bloco 16 — Fase D (LOCAL, controlada).
# Requisitos: server rodando em http://localhost:3000 (node dist/server.cjs, NODE_ENV=development, ADMIN_PASSWORD=cerberus1607).
set -u
BASE="http://localhost:3000"
ADMIN="${ADMIN_PASSWORD:-}"
: "${ADMIN:=cerberus1607}"
OUT="/tmp/prova_viva_fase_d.log"
> "$OUT"

hdr() { echo -e "\n=== $1 ===" | tee -a "$OUT"; }

hdr "0. Health"
curl -s "$BASE/health" | tee -a "$OUT"

hdr "A. Request válido — product-analyst READ_PRODUCT (esperado: IDENTITY_DISABLED, agentes em DRAFT)"
CALL_A=$(curl -s -m 20 -X POST "$BASE/api/agent-runtime/execute" -H "x-admin-password: $ADMIN" -H "Content-Type: application/json" -d '{
  "agentId": "product-analyst",
  "agentVersion": "1.0",
  "requestedTool": "products.read",
  "requestedAction": "READ_PRODUCT",
  "targetType": "PRODUCT",
  "targetId": "REF-001",
  "targetTable": "products",
  "riskContext": {"requestedRisk": "LOW", "riskFloor": null},
  "budgetContext": {"tokenBudget": 100, "timeBudgetMs": 5000, "toolCallBudget": 10, "costBudget": 1},
  "memoryScope": ["PRODUCT"],
  "inputReference": "products.read/REF-001",
  "requestedAt": "2026-08-16T05:40:00Z",
  "idempotencyKey": "idem-a-1",
  "correlationId": "corr-a-1"
}')
echo "$CALL_A" | tee -a "$OUT"

hdr "B. Request inválido (tool vazia)"
curl -s -m 20 -X POST "$BASE/api/agent-runtime/execute" -H "x-admin-password: $ADMIN" -H "Content-Type: application/json" -d '{
  "agentId": "product-analyst",
  "agentVersion": "1.0",
  "requestedTool": "",
  "requestedAction": "READ_PRODUCT",
  "targetType": "PRODUCT",
  "targetId": "REF-001",
  "targetTable": "products",
  "riskContext": {"requestedRisk": "LOW", "riskFloor": null},
  "budgetContext": {"tokenBudget": 100, "timeBudgetMs": 5000, "toolCallBudget": 10, "costBudget": 1},
  "memoryScope": ["PRODUCT"],
  "inputReference": "invalido",
  "requestedAt": "2026-08-16T05:41:00Z",
  "idempotencyKey": "idem-b-1",
  "correlationId": "corr-b-1"
}' | tee -a "$OUT"

hdr "C. DENY real — tool não permitida p/ product-analyst (operator.mode.read)"
curl -s -m 20 -X POST "$BASE/api/agent-runtime/execute" -H "x-admin-password: $ADMIN" -H "Content-Type: application/json" -d '{
  "agentId": "product-analyst",
  "agentVersion": "1.0",
  "requestedTool": "operator.mode.read",
  "requestedAction": "READ_OPERATIONAL_EVENT",
  "targetType": "NONE",
  "targetId": "",
  "riskContext": {"requestedRisk": "LOW", "riskFloor": null},
  "budgetContext": {"tokenBudget": 100, "timeBudgetMs": 5000, "toolCallBudget": 10, "costBudget": 1},
  "memoryScope": ["PRODUCT"],
  "inputReference": "deny-tool",
  "requestedAt": "2026-08-16T05:42:00Z",
  "idempotencyKey": "idem-c-1",
  "correlationId": "corr-c-1"
}' | tee -a "$OUT"

hdr "D. DENY — request sem admin auth (401 fail-closed)"
curl -s -m 20 -X POST "$BASE/api/agent-runtime/execute" -H "Content-Type: application/json" -d '{"agentId":"product-analyst"}' | tee -a "$OUT"

hdr "E. DENY real — action não permitida p/ product-analyst (RUN_RECOVERY fora do catálogo do agente)"
curl -s -m 20 -X POST "$BASE/api/agent-runtime/execute" -H "x-admin-password: $ADMIN" -H "Content-Type: application/json" -d '{
  "agentId": "product-analyst",
  "agentVersion": "1.0",
  "requestedTool": "operational.read",
  "requestedAction": "RUN_RECOVERY",
  "targetType": "NONE",
  "targetId": "",
  "riskContext": {"requestedRisk": "LOW", "riskFloor": null},
  "budgetContext": {"tokenBudget": 100, "timeBudgetMs": 5000, "toolCallBudget": 10, "costBudget": 1},
  "memoryScope": ["PRODUCT"],
  "inputReference": "deny-action",
  "requestedAt": "2026-08-16T05:42:30Z",
  "idempotencyKey": "idem-e-1",
  "correlationId": "corr-e-1"
}' | tee -a "$OUT"

hdr "F. REQUIRES_APPROVAL real — security-agent PUBLISH_PRODUCT? Não. Usar curator-agent PUBLISH_PRODUCT com identity check: action fora de allowedActions → IDENTITY_ACTION_NOT_ALLOWED (fail-closed correto)"
CALL_F=$(curl -s -m 20 -X POST "$BASE/api/agent-runtime/execute" -H "x-admin-password: $ADMIN" -H "Content-Type: application/json" -d '{
  "agentId": "curator-agent",
  "agentVersion": "1.0",
  "requestedTool": "products.write",
  "requestedAction": "PUBLISH_PRODUCT",
  "targetType": "NONE",
  "targetId": "",
  "riskContext": {"requestedRisk": "HIGH", "riskFloor": null},
  "budgetContext": {"tokenBudget": 100, "timeBudgetMs": 5000, "toolCallBudget": 10, "costBudget": 1},
  "memoryScope": ["COMMERCIAL_SIGNALS"],
  "inputReference": "approval-fail-closed",
  "requestedAt": "2026-08-16T05:44:00Z",
  "idempotencyKey": "idem-f-1",
  "correlationId": "corr-f-1"
}')
echo "$CALL_F" | tee -a "$OUT"
echo "--- (REQUIRES_APPROVAL jamais ocorrerá com agents DRAFT/disabled; o loop de aprovação é governado pela rota approve + provider oficial + re-avaliação)" | tee -a "$OUT"

hdr "G. Approval para execution inexistente (404)"
curl -s -m 20 -X POST "$BASE/api/agent-runtime/approve" -H "x-admin-password: $ADMIN" -H "Content-Type: application/json" -d '{
  "executionId": "exec-inexistente-falso",
  "requestedAt": "2026-08-16T05:45:00Z",
  "idempotencyKey": "idem-g-1"
}' | tee -a "$OUT"

hdr "H. K/L. Idempotência — repetir request A com mesmo idempotencyKey (mesma resposta determinística)"
curl -s -m 20 -X POST "$BASE/api/agent-runtime/execute" -H "x-admin-password: $ADMIN" -H "Content-Type: application/json" -d '{
  "agentId": "product-analyst",
  "agentVersion": "1.0",
  "requestedTool": "products.read",
  "requestedAction": "READ_PRODUCT",
  "targetType": "PRODUCT",
  "targetId": "REF-001",
  "targetTable": "products",
  "riskContext": {"requestedRisk": "LOW", "riskFloor": null},
  "budgetContext": {"tokenBudget": 100, "timeBudgetMs": 5000, "toolCallBudget": 10, "costBudget": 1},
  "memoryScope": ["PRODUCT"],
  "inputReference": "products.read/REF-001",
  "requestedAt": "2026-08-16T05:40:00Z",
  "idempotencyKey": "idem-a-1",
  "correlationId": "corr-a-1"
}' | tee -a "$OUT"

hdr "I. M. Colisão — mesmo idempotencyKey com inputReference diferente (conflict detectado)"
curl -s -m 20 -X POST "$BASE/api/agent-runtime/execute" -H "x-admin-password: $ADMIN" -H "Content-Type: application/json" -d '{
  "agentId": "product-analyst",
  "agentVersion": "1.0",
  "requestedTool": "products.read",
  "requestedAction": "READ_PRODUCT",
  "targetType": "PRODUCT",
  "targetId": "REF-001",
  "targetTable": "products",
  "riskContext": {"requestedRisk": "LOW", "riskFloor": null},
  "budgetContext": {"tokenBudget": 100, "timeBudgetMs": 5000, "toolCallBudget": 10, "costBudget": 1},
  "memoryScope": ["PRODUCT"],
  "inputReference": "products.read/REF-001-ALTERADO",
  "requestedAt": "2026-08-16T05:40:00Z",
  "idempotencyKey": "idem-a-1",
  "correlationId": "corr-a-1"
}' | tee -a "$OUT"

hdr "J. N. Auditoria — journal read-only"
curl -s -m 20 "$BASE/api/agent-runtime/executions?page=1&pageSize=50" -H "x-admin-password: $ADMIN" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('total journal:', d.get('total'))
for e in d.get('executions',[]):
    print(' -', e['execution_id'][:40], '|', e['decision'], '|', e['lifecycle_state'], '|', e['executor_status'], '|', e['reason_code'])
" | tee -a "$OUT"

echo -e "\n=== PROVA VIVA CONCLUÍDA (log: $OUT) ==="
