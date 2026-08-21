#!/usr/bin/env python3
"""Gera o payload JSON do One-Off Job final da prova E2E da Fase 24."""
import json

SINK = "https://8911-it4qosrmg5rw1g7gbescr-62f964d8.us1.manus.computer"
URL_ROUTE = "https://files.manuscdn.com/user_upload_by_module/session_file/310519663849027308/oYXXMEetvhFUKQsQ.ts"
URL_AUTO = "https://files.manuscdn.com/user_upload_by_module/session_file/310519663849027308/jhCukmhnsSQFZcWU.ts"
URL_PROBE = "https://files.manuscdn.com/user_upload_by_module/session_file/310519663849027308/QbqGcqTIyGZbBZgf.ts"

cmd = (
    f"cd /opt/render/project/src; "
    f"mkdir -p /tmp/probe_backup; "
    f"cp server/routes/previewTelegramRoutes.ts server/services/productAutomation.ts /tmp/probe_backup/ 2>/dev/null; "
    f"curl -sL --max-time 60 {URL_ROUTE} -o server/routes/previewTelegramRoutes.ts; "
    f"curl -sL --max-time 60 {URL_AUTO} -o server/services/productAutomation.ts; "
    f"curl -sL --max-time 60 {URL_PROBE} -o scripts/phase24_e2e_probe.ts; "
    f"echo FILES_OK; "
    f"unset GEMINI_API_KEY; "
    f"npx --yes tsx scripts/phase24_e2e_probe.ts > /tmp/probe_out.txt 2> /tmp/probe_err.log; "
    f"echo EXIT=$?; "
    f"curl -sS -m 45 -X POST {SINK}/probe_out --data-binary @/tmp/probe_out.txt; "
    f"curl -sS -m 45 -X POST {SINK}/probe_err --data-binary @/tmp/probe_err.log; "
    f"cp /tmp/probe_backup/*.ts server/routes/ server/services/ 2>/dev/null; "
    f"rm -rf /tmp/probe_backup /tmp/probe_out.txt /tmp/probe_err.log; "
    f"echo JOB_DONE"
)

payload = {"startCommand": cmd}
json.dump(payload, open("/tmp/job_payload_final.json", "w"), indent=2)
print("payload ok, len:", len(cmd))
print(cmd)
