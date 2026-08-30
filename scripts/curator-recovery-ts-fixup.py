from pathlib import Path
p = Path("tests/autonomousCurator.test.ts")
text = p.read_text()
old = "      const extracted = await baseExtractor(url);\n"
new = "      const extracted = await baseExtractor();\n"
if old not in text:
    raise SystemExit("TypeScript fixup anchor not found")
p.write_text(text.replace(old, new, 1))
