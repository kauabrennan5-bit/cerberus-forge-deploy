#!/usr/bin/env python3
"""Extrai o conteúdo SQL result dos arquivos de resultado MCP Supabase."""
import json, re, sys

path = sys.argv[1]
raw = open(path).read()
# procurar por untrusted-data ... conteudo ... /untrusted-data (pode estar escapado ou direto)
pattern = re.compile(r'untrusted-data-[^>]*>(.*?)</untrusted-data', re.S)
m = pattern.search(raw)
if m:
    content = m.group(1)
    try:
        print(json.dumps(json.loads(content), indent=2, ensure_ascii=False)[:3000])
    except Exception as e:
        print("PARSE_FAIL:", e)
        print(content[:1000])
else:
    # tentar versão com escapes unicode
    pattern2 = re.compile(r'untrusted-data-[a-z0-9-]+\\u003e(.*?)\\u003c/untrusted-data', re.S)
    m2 = pattern2.search(raw)
    if m2:
        content = m2.group(1)
        content = content.replace('\\u003e', '>').replace('\\u003c', '<').replace('\\"', '"')
        print(content[:2000])
    else:
        print("NO_RESULT_FOUND")
        print(raw[:500])
