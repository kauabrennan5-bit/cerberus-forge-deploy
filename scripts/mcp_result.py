"""Extrai o payload untrusted-data do resultado MCP Supabase."""
import json
import re
import sys

path = sys.argv[1]
d = json.load(open(path))
result = d.get("result", "")
m = re.search(r"<untrusted-data[^>]*>(.*)</untrusted-data", result, re.S)
payload = m.group(1) if m else result
# Tenta parsear como JSON para impressão limpa
try:
    obj = json.loads(payload)
    print(json.dumps(obj, indent=1, ensure_ascii=False)[:3000])
except json.JSONDecodeError:
    print(payload[:3000])
