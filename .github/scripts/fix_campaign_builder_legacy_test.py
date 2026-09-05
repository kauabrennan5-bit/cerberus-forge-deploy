from pathlib import Path

path = Path('tests/newsletterCampaign.test.ts')
text = path.read_text()
old = '''  assert.equal(rendered.keyboard.length, 2);\n  assert.equal(rendered.keyboard[0][0].callback_data, `campaign_view:${testSent.id}`);\n  assert.equal(rendered.keyboard[1][0].callback_data, `campaign_view:${pending.id}`);'''
new = '''  assert.equal(rendered.keyboard.length, 3);\n  assert.equal(rendered.keyboard[0][0].callback_data, "campaign_builder_start");\n  assert.equal(rendered.keyboard[1][0].callback_data, `campaign_view:${testSent.id}`);\n  assert.equal(rendered.keyboard[2][0].callback_data, `campaign_view:${pending.id}`);'''
if text.count(old) != 1:
    raise SystemExit(f'legacy campaign list expectation anchor mismatch: {text.count(old)}')
path.write_text(text.replace(old, new, 1))
print('legacy campaign list test aligned')
