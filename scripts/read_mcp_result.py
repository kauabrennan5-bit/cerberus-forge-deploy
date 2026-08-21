#!/usr/bin/env python3
"""Extrai o JSON desprotegido do resultado MCP (wrapper <untrusted-data> com escapes Unicode)."""
import json
import re
import sys

path = sys.argv[1]
with open(path) as fh:
    d = json.load(fh)
val = d.get("result") or d.get("tables")
if isinstance(val, str):
    # O texto contém escapes \u003c ... \u003e (unicode-escaped HTML tags)
    val = json.loads(json.dumps(val))  # resolve \u003c/\u003e se json-dumps? Não resolve; usar codecs
    import codecs
    val = codecs.decode(val, "unicode_escape") if False else val
    m = re.search(r"<untrusted-data-[^>]+>(.*?)</untrusted-data-[^>]+>", val, re.S)
    if m:
        print(m.group(1))
    else:
        print(val)
elif val is not None:
    print(json.dumps(val, indent=2, ensure_ascii=False))
