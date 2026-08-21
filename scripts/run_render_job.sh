#!/bin/bash
# Prova E2E Fase 24 — One-Off Job Render (read-only, sanitizado, sem main)
set -u
RENDER_API_KEY="${RENDER_API_KEY:?set RENDER_API_KEY}"
SERVICE_ID="srv-d9tq9sh42hec738skftg"
BASE="https://api.render.com/v1"

URL_ROUTE="https://files.manuscdn.com/user_upload_by_module/session_file/310519663849027308/UftShGCfFiqMiKFk.ts"
URL_AUTO="https://files.manuscdn.com/user_upload_by_module/session_file/310519663849027308/jhCukmhnsSQFZcWU.ts"
URL_PROBE="https://files.manuscdn.com/user_upload_by_module/session_file/310519663849027308/xHvxioDvObzxYWOq.ts"

START_CMD="bash -lc 'set -e; SRC=/opt/render/project/src; cd \"\$SRC\"; mkdir -p /tmp/probe_backup; cp server/routes/previewTelegramRoutes.ts server/services/productAutomation.ts /tmp/probe_backup/ 2>/dev/null; curl -sL --max-time 60 \"$URL_ROUTE\" -o server/routes/previewTelegramRoutes.ts; curl -sL --max-time 60 \"$URL_AUTO\" -o server/services/productAutomation.ts; curl -sL --max-time 60 \"$URL_PROBE\" -o scripts/phase24_e2e_probe.ts; echo \"---FILES---\"; ls -la server/routes/previewTelegramRoutes.ts server/services/productAutomation.ts scripts/phase24_e2e_probe.ts; echo \"---PROBE---\"; npx --yes tsx scripts/phase24_e2e_probe.ts 2>&1 | tail -80; echo \"---RESTORE---\"; cp /tmp/probe_backup/*.ts server/routes/ server/services/ 2>/dev/null; rm -rf /tmp/probe_backup; echo JOB_DONE'"

# 0. Gerar payload JSON (startCommand multilinhas safely)
printf '%s' "$START_CMD" > /tmp/job_cmd.txt
python3 -c "import json; json.dump({'startCommand': open('/tmp/job_cmd.txt').read()}, open('/tmp/job_payload.json','w'))"

# 1. Criar o job
echo "== Criando One-Off Job =="
CREATE=$(curl -sS --max-time 30 -X POST "${BASE}/services/${SERVICE_ID}/jobs" \
  -H "Authorization: Bearer ${RENDER_API_KEY}" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/job_payload.json)
echo "$CREATE" | tee /tmp/job_create.json
JOB_ID=$(printf '%s' "$CREATE" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("job",{}).get("id",""))')
echo "JOB_ID=${JOB_ID}"

if [ -z "$JOB_ID" ]; then
  echo "FALHA AO CRIAR O JOB. Parando sem nenhuma mudança em produção."
  exit 1
fi

# 2. Poll status + logs
echo "== Polling =="
while true; do
  sleep 20
  INFO=$(curl -sS --max-time 30 "${BASE}/services/${SERVICE_ID}/jobs/${JOB_ID}" -H "Authorization: Bearer ${RENDER_API_KEY}")
  STATE=$(printf '%s' "$INFO" | python3 -c 'import json,sys; d=json.load(sys.stdin); j=d.get("job",{}); print(j.get("state","unknown"), "| started:", j.get("startedAt","?"), "| finished:", j.get("finishedAt","?"))')
  echo "[$(date -u +%H:%M:%S)] $STATE"
  if printf '%s' "$INFO" | grep -qE '"state":\s*"(FINISHED|TERMINATED|CANCELLED)"'; then
    break
  fi
  # timeout de segurança: 20 min
  if [ "$ELAPSED" -gt 1200 ] 2>/dev/null; then break; fi
  ELAPSED=$(( ${ELAPSED:-0} + 20 ))
done

# 3. Logs do job
echo "== Logs =="
curl -sS --max-time 60 "${BASE}/services/${SERVICE_ID}/jobs/${JOB_ID}/logs" \
  -H "Authorization: Bearer ${RENDER_API_KEY}" -o /tmp/job_logs.json
python3 - <<'EOF'
import json
try:
    data = json.load(open('/tmp/job_logs.json'))
    events = data.get('events') or []
    for e in events:
        print(e.get('message',''), end='')
except Exception as exc:
    print('logs parse error:', exc)
    print(open('/tmp/job_logs.json').read()[:2000])
EOF
