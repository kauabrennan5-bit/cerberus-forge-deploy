#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()
CAMPAIGN = ROOT / "server/services/newsletterWeeklyCampaign.ts"
TEST = ROOT / "tests/newsletterWeeklyDiagnostics.test.ts"

for path in (CAMPAIGN, TEST):
    if not path.is_file():
        raise SystemExit(f"missing materialized target: {path}")

campaign = CAMPAIGN.read_text()

old_no_new = "Etapa: <b>Produtos</b>\\nMotivo: <code>NO_NEW_PRODUCTS</code>\\nAtivos: ${active.length} · novos: ${newlyFresh.length} · elegíveis: 0\\n\\nNenhum rascunho foi gerado e nenhum email foi enviado."
new_no_new = "Sem produto genuinamente novo.\\n\\nEtapa: <b>Produtos</b>\\nMotivo: <code>NO_NEW_PRODUCTS</code>\\nAtivos: ${active.length} · novos: ${newlyFresh.length} · elegíveis: 0\\n\\nNenhum rascunho foi gerado e nenhum email foi enviado."
if campaign.count(old_no_new) != 1:
    raise SystemExit("legacy NO_NEW_PRODUCTS target count mismatch")
campaign = campaign.replace(old_no_new, new_no_new, 1)

old_insufficient = "Etapa: <b>Produtos</b>\\nMotivo: <code>INSUFFICIENT_PRODUCTS</code>\\nAtivos: ${active.length} · novos: ${newlyFresh.length} · elegíveis: ${fresh.length}\\nNecessários: 3\\n\\nNenhum email foi enviado."
new_insufficient = "São necessários no mínimo 3 produtos aptos.\\n\\nEtapa: <b>Produtos</b>\\nMotivo: <code>INSUFFICIENT_PRODUCTS</code>\\nAtivos: ${active.length} · novos: ${newlyFresh.length} · elegíveis: ${fresh.length}\\nNecessários: 3\\n\\nNenhum email foi enviado."
if campaign.count(old_insufficient) != 1:
    raise SystemExit("legacy INSUFFICIENT_PRODUCTS target count mismatch")
campaign = campaign.replace(old_insufficient, new_insufficient, 1)
CAMPAIGN.write_text(campaign)

test_text = TEST.read_text()
anchor = '''test("SUCCESS_DRAFT mantém pending_approval e zero recipients", async () => {'''
if test_text.count(anchor) != 1:
    raise SystemExit("duplicate-risk test insertion anchor mismatch")

duplicate_test = r'''
test("TELEGRAM_ERROR_AFTER_DRAFT reutiliza draft operacional equivalente na nova tentativa", async () => {
  const s = store();
  let createCount = 0;
  const originalCreate = s.createCampaign.bind(s);
  s.createCampaign = async (campaign: any) => { createCount += 1; return originalCreate(campaign); };

  await assert.rejects(
    runWeeklyDraftCycle({
      store:s,
      testMode:true,
      env,
      productsLoader:async()=>products,
      clickCountLoader:async()=>new Map(),
      copyGenerator:async()=>copy,
      institutionalLoader,
      telegramSender:async()=>({ok:false,failureReason:"transport secret"}),
    }),
    expectDiagnostic("TELEGRAM_DELIVERY", "DRAFT_CREATED_TELEGRAM_DELIVERY_FAILED"),
  );
  assert.equal(createCount, 1);
  const existing = [...s.campaigns.values()][0];
  assert.ok(existing);
  assert.equal(existing.status, "pending_approval");
  s.findOperationalCollectionByEditionKey = async () => structuredClone(existing);

  const retry = await runWeeklyDraftCycle({
    store:s,
    testMode:true,
    env,
    productsLoader:async()=>products,
    clickCountLoader:async()=>new Map(),
    copyGenerator:async()=>copy,
    institutionalLoader,
    telegramSender:async()=>{ throw new Error("must not send a second card for duplicate draft"); },
  });
  assert.deepEqual(retry, { status: "skipped", reason: "duplicate", newProductCount: 3 });
  assert.equal(createCount, 1);
  assert.equal(s.campaigns.size, 1);
});

'''

test_text = test_text.replace(anchor, duplicate_test + anchor, 1)
TEST.write_text(test_text)

post = CAMPAIGN.read_text()
if "Sem produto genuinamente novo." not in post:
    raise SystemExit("legacy NO_NEW_PRODUCTS phrase missing after patch")
if "no mínimo 3 produtos aptos" not in post:
    raise SystemExit("legacy insufficient-products phrase missing after patch")
if "NO_NEW_PRODUCTS" not in post or "INSUFFICIENT_PRODUCTS" not in post:
    raise SystemExit("diagnostic reasons lost while restoring legacy text")
if "TELEGRAM_ERROR_AFTER_DRAFT reutiliza draft operacional equivalente" not in TEST.read_text():
    raise SystemExit("duplicate-draft regression missing after patch")

print("LEGACY_NO_NEW_PRODUCTS_MESSAGE=PASS")
print("LEGACY_INSUFFICIENT_PRODUCTS_MESSAGE=PASS")
print("DUPLICATE_DRAFT_REGRESSION_ADDED=true")
