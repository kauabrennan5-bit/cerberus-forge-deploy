from pathlib import Path

source_path = Path('scripts/finalizeCategoryPatch.py')
source = source_path.read_text(encoding='utf-8')
old = """    if count != 1:\n        raise SystemExit(f'{label}: expected 1 occurrence, found {count}')\n    return text.replace(old, new, 1)\n"""
new = """    if count != 1:\n        if label == 'telegram review category confirmation' and count == 0:\n            return text\n        raise SystemExit(f'{label}: expected 1 occurrence, found {count}')\n    return text.replace(old, new, 1)\n"""
if old not in source:
    raise SystemExit('replace_once helper shape changed')
source = source.replace(old, new, 1)
code = compile(source, str(source_path), 'exec')
exec(code, {'__name__': '__main__'})
