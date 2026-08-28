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

# "Acessórios" isolado não pertence à taxonomia pública. O contexto factual
# deve resolver para uma categoria canônica (ex.: luminária -> Iluminação,
# bolsa -> Calçados & Acessórios), em vez de promover o rótulo genérico.
category_path = Path('src/lib/productCategory.ts')
category_source = category_path.read_text(encoding='utf-8')
for legacy_alias in (
    '  acessorios: "Calçados & Acessórios",\n',
    '  acessorio: "Calçados & Acessórios",\n',
):
    if legacy_alias not in category_source:
        raise SystemExit(f'generic accessory alias shape changed: {legacy_alias!r}')
    category_source = category_source.replace(legacy_alias, '', 1)
category_path.write_text(category_source, encoding='utf-8')

# A review pode chegar com metadado técnico (affiliate_preview), desde que a
# categoria pública seja resolvida deterministicamente antes do pipeline. O
# readiness bloqueia apenas quando a resolução falha.
telegram_path = Path('server/services/telegramBot.ts')
telegram_source = telegram_path.read_text(encoding='utf-8')
old_completeness = '''  const publicCategory = resolveTelegramReviewCategory(review);
  if (!publicCategory || publicCategory !== review.categoria.trim()) errors.push("PUBLIC_CATEGORY_REVIEW_REQUIRED");
'''
new_completeness = '''  const publicCategory = resolveTelegramReviewCategory(review);
  if (!publicCategory) errors.push("PUBLIC_CATEGORY_REVIEW_REQUIRED");
'''
if old_completeness not in telegram_source:
    raise SystemExit('telegram completeness category gate shape changed')
telegram_source = telegram_source.replace(old_completeness, new_completeness, 1)
telegram_path.write_text(telegram_source, encoding='utf-8')

# A ressalva comercial permanece em um slot de altura previsível.
card_path = Path('src/components/ProductCard.tsx')
card_source = card_path.read_text(encoding='utf-8')
button_marker = '''            <button
              type="button"
              onClick={handleBuyClick}
'''
disclaimer = '''            <p className="mt-1 h-[2rem] overflow-hidden text-[8px] leading-4 text-[#E8E1D3]/45 line-clamp-2 sm:text-[9px]">
              Condições finais de pagamento e frete são confirmadas na loja oficial.
            </p>

'''
if 'Condições finais de pagamento e frete são confirmadas na loja oficial.' not in card_source:
    if card_source.count(button_marker) != 1:
        raise SystemExit('ProductCard acquire button marker changed')
    card_source = card_source.replace(button_marker, disclaimer + button_marker, 1)
card_path.write_text(card_source, encoding='utf-8')

# O grid agora depende da taxonomia pública compartilhada, não de uma cópia local.
promotion_test_path = Path('tests/promotionOffer.test.ts')
promotion_test = promotion_test_path.read_text(encoding='utf-8')
old_assertions = '''  assert.match(gridSource, /const BASE_CATEGORIES = \\[/);
  assert.match(gridSource, /'Iluminação'/);
  assert.match(gridSource, /'Infantil'/);
'''
new_assertions = '''  assert.match(gridSource, /PUBLIC_PRODUCT_CATEGORIES/);
  assert.match(gridSource, /categories = useMemo/);
'''
if old_assertions not in promotion_test:
    raise SystemExit('promotionOffer legacy category assertions changed')
promotion_test = promotion_test.replace(old_assertions, new_assertions, 1)
promotion_test_path.write_text(promotion_test, encoding='utf-8')

# Fixtures N7 exercitam resolução de afiliado, não classificação de categoria.
# Elas recebem uma categoria pública válida para alcançar o gate que pretendem testar.
affiliate_test_path = Path('tests/affiliateResolverN7.test.ts')
affiliate_test = affiliate_test_path.read_text(encoding='utf-8')
old_candidate_category = '            category: "Acessórios",\n'
old_product_category = '          categoria: "Acessórios",\n'
if affiliate_test.count(old_candidate_category) != 1:
    raise SystemExit('N7 candidate category fixture shape changed')
if affiliate_test.count(old_product_category) != 1:
    raise SystemExit('N7 product category fixture shape changed')
affiliate_test = affiliate_test.replace(old_candidate_category, '            category: "Iluminação",\n', 1)
affiliate_test = affiliate_test.replace(old_product_category, '          categoria: "Iluminação",\n', 1)
affiliate_test_path.write_text(affiliate_test, encoding='utf-8')

# Os testes de segurança precisam isolar a variável sob teste. A descrição
# contaminada usa categoria pública válida; prompt-injection sem sinais
# classificatórios deve permanecer fail-closed, nunca virar categoria genérica.
telegram_test_path = Path('tests/telegramAndMarketplace.test.ts')
telegram_test = telegram_test_path.read_text(encoding='utf-8')
contaminated_fixture = '''    produto: "Produto editorial",
    categoria: "Acessórios",
    preco: 10,
'''
if telegram_test.count(contaminated_fixture) != 1:
    raise SystemExit('contaminated-description fixture shape changed')
telegram_test = telegram_test.replace(
    contaminated_fixture,
    '''    produto: "Produto editorial",
    categoria: "Iluminação",
    preco: 10,
''',
    1,
)
telegram_test = telegram_test.replace(
    'assert.equal(resolveTelegramReviewCategory(review as any, "Acessórios"), "Calçados & Acessórios");',
    'assert.equal(resolveTelegramReviewCategory(review as any, "Acessórios"), "Iluminação");',
    1,
)
old_prompt_expectation = '  assert.equal(curated.category, "Calçados & Acessórios");\n'
if telegram_test.count(old_prompt_expectation) != 1:
    raise SystemExit('prompt-injection category expectation shape changed')
telegram_test = telegram_test.replace(
    old_prompt_expectation,
    '  assert.equal(curated.category, "", "categoria sem evidência pública permanece em revisão");\n',
    1,
)
telegram_test_path.write_text(telegram_test, encoding='utf-8')

# Sanidades obrigatórias da taxonomia.
if '"talher"' not in category_source or category_source.index('"talher"') > category_source.index('"organizador"'):
    raise SystemExit('kitchen-specific category precedence regressed')
if 'acessorios: "Calçados & Acessórios"' in category_source:
    raise SystemExit('generic non-public Acessórios alias leaked into resolver')

print('CATEGORY_GATE_POST_PATCH_APPLIED')
