from pathlib import Path
p = Path('server/services/autonomousCurator.ts')
s = p.read_text()
a = '        const maxEnrichThisQuery = Math.max(1, Math.ceil(enrichRemaining / queriesRemaining));\n'
b = '        const maxEnrichThisQuery = queryIndex === 0\n          ? Math.min(enrichRemaining, Math.max(2, Math.ceil(config.maxEnrichPerCategory / 2)))\n          : Math.max(1, Math.ceil(enrichRemaining / queriesRemaining));\n'
if a not in s:
    raise SystemExit('query budget block missing')
p.write_text(s.replace(a, b, 1))
