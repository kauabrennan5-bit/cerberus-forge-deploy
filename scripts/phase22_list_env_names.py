"""Fase 22 — lista SOMENTE nomes de env vars do serviço Render (sem valores).
Usa a key FindBot (chave oficial não temporária) para a API pública Render."""
import json
import re
import subprocess
import urllib.request

SERVICE_ID = "srv-d9tq9sh42hec738skftg"

# Recuperar a key FindBot da config do Manus (tokenReplacementEnabled=true
# deixa o proxy reescrever para o token real sem expor valores).
raw = subprocess.run(
    ["manus-config", "config", "load", "--search", "render"],
    capture_output=True, text=True,
).stdout

token = None
for line in raw.splitlines():
    m = re.search(r"token['\"]?\s*[:=]\s*['\"](rnd_[A-Za-z0-9]+)['\"]", line)
    if m:
        token = m.group(1)
if not token:
    raise SystemExit("token nao encontrado na config")

req = urllib.request.Request(
    f"https://api.render.com/v1/services/{SERVICE_ID}/env-vars",
    headers={"Authorization": f"Bearer {token}"},
)
resp = urllib.request.urlopen(req, timeout=20)
envs = json.load(resp)

names = sorted({e.get("key") for e in envs if isinstance(e, dict) and e.get("key")})
shopee = [n for n in names if "SHOPEE" in n.upper()]
seller = [n for n in names if "SELLER" in n.upper()]
print(json.dumps({
    "env_count": len(names),
    "SHOPEE_named_envs": shopee,
    "SELLER_named_envs": seller,
    "ALL_env_names": names,
}, indent=1))
