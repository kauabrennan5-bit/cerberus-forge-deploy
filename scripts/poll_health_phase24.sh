#!/bin/bash
# Poll /health até o SHA novo (Fase 24) ser servido. Sem secrets.
TARGET_SHA="3deb7556611be7134cf46a2241b8c1c0ffd0d45b"
URL="https://cerberus-forge-deploy-backend.onrender.com/health"
for i in $(seq 1 90); do
  resp=$(curl -sS --max-time 20 "$URL") || resp="TIMEOUT"
  ver=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('version','?'))" 2>/dev/null) || ver="PARSE_FAIL"
  echo "[$i] $(date -u +%H:%M:%S) version=$ver"
  if [ "$ver" = "$TARGET_SHA" ]; then
    echo "SHA_OK $ver"
    echo "FULL_RESPONSE: $resp"
    exit 0
  fi
  sleep 20
done
echo "TIMEOUT_SHA_NOT_SERVED"
exit 1
