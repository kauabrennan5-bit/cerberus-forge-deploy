from pathlib import Path


def replace_exact(text: str, old: str, new: str, expected: int = 1) -> str:
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"expected {expected} occurrence(s) of {old!r}, found {count}")
    return text.replace(old, new, expected)


route_path = Path("server/routes/newsletterWeeklyRoutes.ts")
route = route_path.read_text(encoding="utf-8")
for old, new in [
    ("utmSource:", "utm_source:"),
    ("utmMedium:", "utm_medium:"),
    ("utmCampaign:", "utm_campaign:"),
    ("utmContent:", "utm_content:"),
]:
    route = replace_exact(route, old, new)
route_path.write_text(route, encoding="utf-8")

campaign_path = Path("server/services/newsletterWeeklyCampaign.ts")
campaign = campaign_path.read_text(encoding="utf-8")
campaign = replace_exact(
    campaign,
    'reason: "no_new_products" | "insufficient_new_products" | "duplicate"; newProductCount: number',
    'reason: "disabled" | "no_new_products" | "insufficient_new_products" | "duplicate"; newProductCount: number',
)
campaign = replace_exact(
    campaign,
    '  const testMode = deps.testMode === true;\n  const chatId = (env.TELEGRAM_ADMIN_CHAT_ID || "").trim();',
    '  const testMode = deps.testMode === true;\n  const weeklyEnabled = env.NEWSLETTER_WEEKLY_ENABLED === "true";\n  if (!testMode && !weeklyEnabled) return { status: "skipped", reason: "disabled", newProductCount: 0 };\n  const chatId = (env.TELEGRAM_ADMIN_CHAT_ID || "").trim();',
)
campaign_path.write_text(campaign, encoding="utf-8")

test_path = Path("tests/newsletterWeeklyCampaign.test.ts")
tests = test_path.read_text(encoding="utf-8")
env_old = 'env: { TELEGRAM_ADMIN_CHAT_ID: "123", TELEGRAM_ALLOWED_USER_IDS: "123", NEWSLETTER_PUBLIC_BASE_URL: "https://cerberus.example.com" }'
env_new = 'env: { TELEGRAM_ADMIN_CHAT_ID: "123", TELEGRAM_ALLOWED_USER_IDS: "123", NEWSLETTER_PUBLIC_BASE_URL: "https://cerberus.example.com", NEWSLETTER_WEEKLY_ENABLED: "true" }'
tests = replace_exact(tests, env_old, env_new, expected=3)
additional_tests = r'''

test("produção semanal fica desabilitada por padrão e não toca dados", async () => {
  const store = memoryStore();
  let productsLoaded = false;
  const result = await runWeeklyDraftCycle({
    store,
    productsLoader: async () => { productsLoaded = true; return []; },
    env: {},
  });
  assert.deepEqual(result, { status: "skipped", reason: "disabled", newProductCount: 0 });
  assert.equal(productsLoaded, false);
  assert.equal(store.campaigns.size, 0);
});

test("weekly-test independe do flag de produção e continua sem recipients reais", async () => {
  const store = memoryStore();
  const products = [
    product("a", "REF-A", "2026-08-28T12:00:00Z", 10),
    product("b", "REF-B", "2026-08-28T11:00:00Z", 20),
    product("c", "REF-C", "2026-08-28T10:00:00Z", 30),
  ];
  const result = await runWeeklyDraftCycle({
    store,
    testMode: true,
    productsLoader: async () => products,
    clickCountLoader: async () => new Map(),
    copyGenerator: async () => copy,
    telegramSender: async () => ({ ok: true, result: { message_id: 88 } }),
    now: new Date("2026-08-28T15:00:00Z"),
    env: { TELEGRAM_ADMIN_CHAT_ID: "123", TELEGRAM_ALLOWED_USER_IDS: "123", NEWSLETTER_PUBLIC_BASE_URL: "https://cerberus.example.com" },
  });
  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  assert.match(String(result.campaign.editionKey), /^weekly-test:/);
  assert.equal(result.campaign.status, "pending_approval");
  assert.equal(store.campaigns.size, 1);
});
'''
if 'produção semanal fica desabilitada por padrão' in tests:
    raise SystemExit("weekly production flag tests already present")
test_path.write_text(tests + additional_tests, encoding="utf-8")
