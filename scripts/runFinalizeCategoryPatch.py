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

# Correções derivadas do primeiro gate: aliases públicos explícitos devem ter
# precedência sobre inferência contextual. Categorias técnicas continuam sem
# alias e, portanto, dependem da inferência fail-closed.
category_path = Path('src/lib/productCategory.ts')
category_source = category_path.read_text(encoding='utf-8')
old_order = '''  const contentCategory = inferPublicProductCategory({ category: "", ...context });
  return contentCategory || CATEGORY_ALIASES[normalized] || "";
'''
new_order = '''  const alias = CATEGORY_ALIASES[normalized];
  if (alias) return alias;

  const contentCategory = inferPublicProductCategory({ category: "", ...context });
  return contentCategory || "";
'''
if old_order not in category_source:
    raise SystemExit('productCategory resolver order shape changed')
category_source = category_source.replace(old_order, new_order, 1)
category_path.write_text(category_source, encoding='utf-8')

# O exemplo obrigatório deve privilegiar o objeto específico (talher) sobre o
# propósito genérico (organizador). O resolver já ordena cozinha antes de
# organização; este teste de sanidade impede regressão silenciosa no runner.
if '"talher"' not in category_source or category_source.index('"talher"') > category_source.index('"organizador"'):
    raise SystemExit('kitchen-specific category precedence regressed')

# Ajusta apenas a expectativa do alias explícito no teste Telegram gerado.
test_path = Path('tests/telegramAndMarketplace.test.ts')
test_source = test_path.read_text(encoding='utf-8')
test_source = test_source.replace(
    'assert.equal(resolveTelegramReviewCategory(review as any, "Acessórios"), "Iluminação");',
    'assert.equal(resolveTelegramReviewCategory(review as any, "Acessórios"), "Calçados & Acessórios");',
    1,
)
test_path.write_text(test_source, encoding='utf-8')

print('CATEGORY_GATE_POST_PATCH_APPLIED')
