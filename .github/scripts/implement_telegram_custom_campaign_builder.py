from pathlib import Path


def require_replace(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one anchor, found {count}")
    return text.replace(old, new, 1)


# 1) Rich Telegram user state.
repo = Path("server/repositories/telegramRepository.ts")
text = repo.read_text()
text = require_replace(
    text,
    """export interface UserState {
  senderId: string;
  action: string;
  reviewId?: string;
  productId?: string;
  updatedAt: number;
}
""",
    """export type UserStateInput = {
  action: string;
  reviewId?: string;
  productId?: string;
  data?: Record<string, unknown>;
};

export interface UserState extends UserStateInput {
  senderId: string;
  updatedAt: number;
}
""",
    "telegramRepository UserState",
)
text = require_replace(
    text,
    "let testOverrideSetUserState: ((senderId: string | number, state: { action: string; reviewId?: string; productId?: string }) => Promise<void>) | null = null;",
    "let testOverrideSetUserState: ((senderId: string | number, state: UserStateInput) => Promise<void>) | null = null;",
    "telegramRepository set override",
)
text = require_replace(
    text,
    "let testOverrideGetUserState: ((senderId: string | number) => Promise<{ action: string; reviewId?: string; productId?: string } | null>) | null = null;",
    "let testOverrideGetUserState: ((senderId: string | number) => Promise<UserStateInput | null>) | null = null;",
    "telegramRepository get override",
)
text = require_replace(
    text,
    """  set?: ((senderId: string | number, state: { action: string; reviewId?: string; productId?: string }) => Promise<void>) | null;
  get?: ((senderId: string | number) => Promise<{ action: string; reviewId?: string; productId?: string } | null>) | null;
""",
    """  set?: ((senderId: string | number, state: UserStateInput) => Promise<void>) | null;
  get?: ((senderId: string | number) => Promise<UserStateInput | null>) | null;
""",
    "telegramRepository test handlers",
)
text = require_replace(text, "  state: { action: string; reviewId?: string; productId?: string },", "  state: UserStateInput,", "telegramRepository setUserState arg")
text = require_replace(text, "    productId: state.productId,\n    updatedAt: Date.now(),", "    productId: state.productId,\n    data: state.data,\n    updatedAt: Date.now(),", "telegramRepository local data")
text = require_replace(text, "        product_id: state.productId,\n        updated_at: userStateObj.updatedAt,", "        product_id: state.productId,\n        data: state.data || {},\n        updated_at: userStateObj.updatedAt,", "telegramRepository Supabase data")
text = require_replace(text, "): Promise<{ action: string; reviewId?: string; productId?: string } | null> {", "): Promise<UserStateInput | null> {", "telegramRepository return type")
text = require_replace(text, "          productId: data.product_id,\n          updatedAt: data.updated_at || Date.now(),", "          productId: data.product_id,\n          data: data.data && typeof data.data === \"object\" && !Array.isArray(data.data) ? data.data : {},\n          updatedAt: Number(data.updated_at) || Date.now(),", "telegramRepository hydrate data")
text = require_replace(text, "  return { action: stateObj.action, reviewId: stateObj.reviewId, productId: stateObj.productId };", "  return { action: stateObj.action, reviewId: stateObj.reviewId, productId: stateObj.productId, data: stateObj.data };", "telegramRepository return data")
repo.write_text(text)

# 2) Exact custom selection helper.
collection = Path("server/services/newsletterCampaignCollection.ts")
text = collection.read_text()
text = require_replace(text, "export const MAX_NEWSLETTER_COLLECTION_SIZE = 15;\n", "export const MAX_NEWSLETTER_COLLECTION_SIZE = 15;\nexport const MAX_CUSTOM_CAMPAIGN_PRODUCTS = 10;\n", "custom max constant")
anchor = "export function getStartOfNewsletterCollectionWindow(now = new Date()): Date {\n"
helper = """export async function selectNewsletterProductsByIds(
  products: readonly Product[],
  productIds: readonly string[],
  options: Pick<NewsletterCollectionSelectionOptions, \"verifyImageAccessibility\" | \"imageProbe\"> = {},
): Promise<NewsletterCollectionSelection> {
  const normalizedIds = productIds
    .map(value => String(value || \"\").trim())
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
  if (normalizedIds.length === 0) throw new Error(\"CAMPAIGN_CUSTOM_SELECTION_REQUIRED\");
  if (normalizedIds.length > MAX_CUSTOM_CAMPAIGN_PRODUCTS) throw new Error(\"CAMPAIGN_CUSTOM_SELECTION_LIMIT\");

  const byId = new Map(products
    .filter(product => typeof product.id === \"string\" && product.id.trim())
    .map(product => [product.id.trim(), product] as const));
  const selected: Product[] = [];
  const skipped: NewsletterCollectionSkippedProduct[] = [];

  for (const productId of normalizedIds) {
    const product = byId.get(productId);
    if (!product) {
      skipped.push({ productId, reason: \"PRODUCT_NOT_FOUND\" });
      continue;
    }
    if (product.ativo !== true || !isApprovedOrPublished(product.status)) {
      skipped.push({ productId, reason: \"PRODUCT_NOT_AVAILABLE\" });
      continue;
    }
    const readiness = await assessProductReadiness(product, {
      channel: \"campaign\",
      verifyImageAccessibility: options.verifyImageAccessibility !== false,
      imageProbe: options.imageProbe,
    });
    if (!readiness.ready) {
      skipped.push({ productId, reason: readiness.errors.join(\",\") || \"CAMPAIGN_PRODUCT_NOT_READY\" });
      continue;
    }
    selected.push(product);
  }

  if (skipped.length > 0 || selected.length !== normalizedIds.length) {
    const first = skipped[0] || { productId: \"unknown\", reason: \"CAMPAIGN_PRODUCT_NOT_READY\" };
    throw new Error(`CAMPAIGN_CUSTOM_PRODUCT_NOT_READY:${first.productId}:${first.reason}`);
  }

  return { products: selected, requestedSize: normalizedIds.length, since: null, until: null, skipped: [] };
}

"""
text = require_replace(text, anchor, helper + anchor, "custom selection helper")
collection.write_text(text)

# 3) Manual campaign creation via existing collection pipeline.
service = Path("server/services/newsletterCampaignService.ts")
text = service.read_text()
text = require_replace(text, "  getStartOfNewsletterCollectionWindow,\n  selectNewestNewsletterProducts,\n", "  getStartOfNewsletterCollectionWindow,\n  selectNewestNewsletterProducts,\n  selectNewsletterProductsByIds,\n", "service import")
anchor = "export function buildNewsletterCollectionEditionKey(products: readonly Product[], editionWindowStart: Date): string {\n"
custom = """export async function createCustomCollectionCampaign(
  productIds: readonly string[],
  actorTelegramId: string,
  options: CampaignServiceOptions = {},
): Promise<EmailCampaign> {
  const env = options.env || process.env;
  const now = options.now || new Date();
  const campaignId = crypto.randomUUID();
  const products = await (options.productsLoader || productsRepository.getProducts)();
  const selection = await selectNewsletterProductsByIds(products, productIds, {
    verifyImageAccessibility: options.verifyImageAccessibility !== false,
    imageProbe: options.imageProbe,
  });
  const institutional = await getNewsletterInstitutionalOptions(env);
  const count = selection.products.length;
  const baseSubject = env.NEWSLETTER_CUSTOM_SUBJECT?.trim() || \"Seleção Cerberus Finds\";
  const subject = `${baseSubject} · ${count} ${count === 1 ? \"produto selecionado\" : \"produtos selecionados\"}`.slice(0, 255);
  const rendered = renderNewsletterCollectionCampaign(selection.products, {
    subject,
    collectionKicker: \"Monte sua campanha\",
    collectionTitle: count === 1 ? \"1 ACHADO SELECIONADO\" : `${count} ACHADOS SELECIONADOS`,
    collectionIntro: \"Uma seleção montada manualmente no painel Cerberus.\",
    trackingCampaignId: campaignId,
    privacyUrl: institutional.privacyUrl,
    termsUrl: institutional.termsUrl,
    socialLinks: institutional.socialLinks,
    finalBrowseUrl: env.NEWSLETTER_COLLECTION_BROWSE_URL || undefined,
    mastheadImageStatus: \"unavailable\",
    mastheadLogoStatus: \"available\",
  });
  const collectionProducts: CampaignProductLink[] = selection.products.map((product, index) => ({
    productId: product.id,
    position: index + 1,
    layout: index === 0 ? \"feature\" : \"grid\",
  }));
  const editionKey = `manual:${now.toISOString().slice(0, 10)}:${campaignId}`;
  const draft = createCampaignDraft(null, actorTelegramId, rendered, now, campaignId, \"collection\", collectionProducts, editionKey);
  const store = options.store || createSupabaseNewsletterCampaignStore();
  const persisted = await store.createCampaign(draft);
  await store.createCampaignProducts(persisted.id, collectionProducts);
  return { ...persisted, collectionProducts, editionKey };
}

"""
text = require_replace(text, anchor, custom + anchor, "custom campaign service")
service.write_text(text)

# 4) Telegram builder callbacks and UI.
telegram = Path("server/services/newsletterCampaignTelegram.ts")
text = telegram.read_text()
text = require_replace(text, "  createCampaignForProduct,\n  createWeeklyCollectionCampaign,\n", "  createCampaignForProduct,\n  createCustomCollectionCampaign,\n  createWeeklyCollectionCampaign,\n", "telegram service import")
text = require_replace(
    text,
    "const campaignCallbackLocks = new Map<string, Promise<void>>();\n",
    """const campaignCallbackLocks = new Map<string, Promise<void>>();
const CAMPAIGN_BUILDER_ACTION = \"campaign_builder\";
const CAMPAIGN_BUILDER_PAGE_SIZE = 6;
const CAMPAIGN_BUILDER_MAX_PRODUCTS = 10;

type CampaignBuilderState = {
  catalogProductIds: string[];
  selectedProductIds: string[];
  page: number;
};
""",
    "telegram builder constants",
)
start_anchor = """    const store = deps.store || createSupabaseNewsletterCampaignStore();
    if (data === \"campaign_collection\") {
"""
start_replacement = """    const store = deps.store || createSupabaseNewsletterCampaignStore();

    if (data === \"campaign_builder_start\") {
      return startCustomCampaignBuilder(callbackId, senderId, chatId, messageId, deps);
    }
    if (data.startsWith(\"campaign_builder_toggle:\")) {
      const index = Number(data.slice(\"campaign_builder_toggle:\".length));
      return toggleCustomCampaignProduct(callbackId, senderId, chatId, messageId, index, deps);
    }
    if (data.startsWith(\"campaign_builder_page:\")) {
      const page = Number(data.slice(\"campaign_builder_page:\".length));
      return changeCustomCampaignBuilderPage(callbackId, senderId, chatId, messageId, page, deps);
    }
    if (data === \"campaign_builder_clear\") {
      return clearCustomCampaignBuilder(callbackId, senderId, chatId, messageId, deps);
    }
    if (data === \"campaign_builder_cancel\") {
      await telegramRepo.deleteUserState(senderId);
      await deps.answerCallbackQuery(callbackId, \"Montagem cancelada. Nenhuma campanha foi criada.\");
      const view = renderRecentCampaignsForTelegram(await store.listRecentCampaigns(10));
      if (chatId && messageId) await deps.editTelegramMessageText(chatId, messageId, view.text, { inline_keyboard: view.keyboard });
      else if (chatId) await deps.sendTelegramMessage(chatId, view.text, { inline_keyboard: view.keyboard });
      return true;
    }
    if (data === \"campaign_builder_done\") {
      const builder = await readCustomCampaignBuilder(senderId);
      if (!builder) {
        await deps.answerCallbackQuery(callbackId, \"A sessão de montagem expirou. Abra /campanhas e comece novamente.\", true);
        return true;
      }
      if (builder.selectedProductIds.length < 1) {
        await deps.answerCallbackQuery(callbackId, \"Selecione pelo menos 1 produto.\", true);
        return true;
      }
      if (builder.selectedProductIds.length > CAMPAIGN_BUILDER_MAX_PRODUCTS) {
        await deps.answerCallbackQuery(callbackId, \"O limite é de 10 produtos por campanha.\", true);
        return true;
      }
      const campaign = await createCustomCollectionCampaign(builder.selectedProductIds, senderId, {
        store,
        env,
        productsLoader: deps.productsLoader,
        now: deps.now,
        verifyImageAccessibility: deps.verifyImageAccessibility,
      });
      const pending = await submitCampaignForApproval(campaign, senderId, { store, env });
      await telegramRepo.deleteUserState(senderId);
      await deps.answerCallbackQuery(callbackId, `Campanha montada com ${builder.selectedProductIds.length} produto(s). Revise a prévia antes de aprovar.`);
      return renderCampaignWithFallback(deps, chatId, messageId, pending, campaignKeyboard(pending));
    }

    if (data === \"campaign_collection\") {
"""
text = require_replace(text, start_anchor, start_replacement, "telegram callback routes")
list_old = """  const keyboard = visible.map(campaign => [{
    text: `${campaignStatusLabel(campaign.status)} · ${campaign.subject.slice(0, 42)}`,
    callback_data: `campaign_view:${campaign.id}`,
  }]);
  return { text, keyboard };
}
"""
list_new = """  const keyboard = [
    [{ text: \"🧩 Monte sua campanha\", callback_data: \"campaign_builder_start\" }],
    ...visible.map(campaign => [{
      text: `${campaignStatusLabel(campaign.status)} · ${campaign.subject.slice(0, 42)}`,
      callback_data: `campaign_view:${campaign.id}`,
    }]),
  ];
  return { text, keyboard };
}
"""
text = require_replace(text, list_old, list_new, "campaign list builder button")
helper_anchor = "function campaignStatusLabel(status: EmailCampaign[\"status\"]): string {\n"
builder_helpers = r'''function isCampaignBuilderProduct(product: import("../../src/types").Product): boolean {
  const statusOk = !product.status || product.status === "approved" || product.status === "published";
  return Boolean(product.id?.trim()) && product.ativo === true && statusOk;
}

function normalizeBuilderState(value: unknown): CampaignBuilderState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<CampaignBuilderState>;
  const catalogProductIds = Array.isArray(candidate.catalogProductIds)
    ? candidate.catalogProductIds.map(String).map(item => item.trim()).filter(Boolean)
    : [];
  const selectedProductIds = Array.isArray(candidate.selectedProductIds)
    ? candidate.selectedProductIds.map(String).map(item => item.trim()).filter(id => catalogProductIds.includes(id))
    : [];
  const page = Number.isInteger(candidate.page) ? Math.max(0, Number(candidate.page)) : 0;
  if (catalogProductIds.length === 0) return null;
  return { catalogProductIds, selectedProductIds: [...new Set(selectedProductIds)].slice(0, CAMPAIGN_BUILDER_MAX_PRODUCTS), page };
}

async function readCustomCampaignBuilder(senderId: string): Promise<CampaignBuilderState | null> {
  const state = await telegramRepo.getUserState(senderId);
  if (state?.action !== CAMPAIGN_BUILDER_ACTION) return null;
  return normalizeBuilderState(state.data);
}

async function writeCustomCampaignBuilder(senderId: string, state: CampaignBuilderState): Promise<void> {
  await telegramRepo.setUserState(senderId, { action: CAMPAIGN_BUILDER_ACTION, data: state });
}

async function startCustomCampaignBuilder(callbackId: string, senderId: string, chatId: number | string | undefined, messageId: number | undefined, deps: CampaignTelegramDeps): Promise<boolean> {
  const products = await (deps.productsLoader || productsRepository.getProducts)();
  const catalog = products.filter(isCampaignBuilderProduct).sort((a, b) => {
    const right = typeof b.createdAt === "string" ? Date.parse(b.createdAt) : 0;
    const left = typeof a.createdAt === "string" ? Date.parse(a.createdAt) : 0;
    return (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0);
  });
  if (catalog.length === 0) {
    await deps.answerCallbackQuery(callbackId, "Não há produtos ativos disponíveis para montar campanha.", true);
    return true;
  }
  const state: CampaignBuilderState = { catalogProductIds: catalog.map(product => product.id.trim()), selectedProductIds: [], page: 0 };
  await writeCustomCampaignBuilder(senderId, state);
  await deps.answerCallbackQuery(callbackId, "Selecione de 1 a 10 produtos. O primeiro selecionado será o HERO.");
  return renderCustomCampaignBuilder(senderId, chatId, messageId, state, deps);
}

async function toggleCustomCampaignProduct(callbackId: string, senderId: string, chatId: number | string | undefined, messageId: number | undefined, index: number, deps: CampaignTelegramDeps): Promise<boolean> {
  const state = await readCustomCampaignBuilder(senderId);
  if (!state) {
    await deps.answerCallbackQuery(callbackId, "A sessão de montagem expirou. Abra /campanhas novamente.", true);
    return true;
  }
  if (!Number.isInteger(index) || index < 0 || index >= state.catalogProductIds.length) {
    await deps.answerCallbackQuery(callbackId, "Produto inválido nesta sessão.", true);
    return true;
  }
  const productId = state.catalogProductIds[index];
  const selected = [...state.selectedProductIds];
  const currentIndex = selected.indexOf(productId);
  if (currentIndex >= 0) selected.splice(currentIndex, 1);
  else {
    if (selected.length >= CAMPAIGN_BUILDER_MAX_PRODUCTS) {
      await deps.answerCallbackQuery(callbackId, "Limite atingido: no máximo 10 produtos.", true);
      return true;
    }
    selected.push(productId);
  }
  const next = { ...state, selectedProductIds: selected };
  await writeCustomCampaignBuilder(senderId, next);
  await deps.answerCallbackQuery(callbackId, currentIndex >= 0 ? `Produto removido · ${selected.length}/10` : `Produto adicionado · ${selected.length}/10`);
  return renderCustomCampaignBuilder(senderId, chatId, messageId, next, deps);
}

async function changeCustomCampaignBuilderPage(callbackId: string, senderId: string, chatId: number | string | undefined, messageId: number | undefined, page: number, deps: CampaignTelegramDeps): Promise<boolean> {
  const state = await readCustomCampaignBuilder(senderId);
  if (!state) {
    await deps.answerCallbackQuery(callbackId, "A sessão de montagem expirou. Abra /campanhas novamente.", true);
    return true;
  }
  const maxPage = Math.max(0, Math.ceil(state.catalogProductIds.length / CAMPAIGN_BUILDER_PAGE_SIZE) - 1);
  const next = { ...state, page: Math.max(0, Math.min(maxPage, Number.isFinite(page) ? Math.trunc(page) : 0)) };
  await writeCustomCampaignBuilder(senderId, next);
  await deps.answerCallbackQuery(callbackId);
  return renderCustomCampaignBuilder(senderId, chatId, messageId, next, deps);
}

async function clearCustomCampaignBuilder(callbackId: string, senderId: string, chatId: number | string | undefined, messageId: number | undefined, deps: CampaignTelegramDeps): Promise<boolean> {
  const state = await readCustomCampaignBuilder(senderId);
  if (!state) {
    await deps.answerCallbackQuery(callbackId, "A sessão de montagem expirou. Abra /campanhas novamente.", true);
    return true;
  }
  const next = { ...state, selectedProductIds: [] };
  await writeCustomCampaignBuilder(senderId, next);
  await deps.answerCallbackQuery(callbackId, "Seleção limpa.");
  return renderCustomCampaignBuilder(senderId, chatId, messageId, next, deps);
}

async function renderCustomCampaignBuilder(senderId: string, chatId: number | string | undefined, messageId: number | undefined, state: CampaignBuilderState, deps: CampaignTelegramDeps): Promise<boolean> {
  if (!chatId) return true;
  const products = await (deps.productsLoader || productsRepository.getProducts)();
  const byId = new Map(products.map(product => [product.id, product] as const));
  const maxPage = Math.max(0, Math.ceil(state.catalogProductIds.length / CAMPAIGN_BUILDER_PAGE_SIZE) - 1);
  const page = Math.max(0, Math.min(maxPage, state.page));
  const start = page * CAMPAIGN_BUILDER_PAGE_SIZE;
  const ids = state.catalogProductIds.slice(start, start + CAMPAIGN_BUILDER_PAGE_SIZE);
  const selectedSet = new Set(state.selectedProductIds);
  const selectedLines = state.selectedProductIds.map((id, index) => {
    const product = byId.get(id);
    const title = product?.displayTitle || product?.produto || id;
    return `${index + 1}. ${escapeTelegram(String(title).slice(0, 58))}${index === 0 ? " · <b>HERO</b>" : ""}`;
  });
  const text = [
    "🧩 <b>MONTE SUA CAMPANHA</b>",
    "Selecione de <b>1 a 10 produtos</b>. O primeiro selecionado vira o destaque/HERO.",
    `Selecionados: <b>${state.selectedProductIds.length}/10</b> · Página <b>${page + 1}/${maxPage + 1}</b>`,
    "",
    selectedLines.length ? `<b>Ordem atual</b>\n${selectedLines.join("\n")}` : "Nenhum produto selecionado ainda.",
    "",
    "Toque nos produtos abaixo para adicionar/remover. Nada é enviado automaticamente.",
  ].join("\n");
  const keyboard: any[][] = ids.map((id, offset) => {
    const product = byId.get(id);
    const title = String(product?.displayTitle || product?.produto || "Produto indisponível").replace(/\s+/g, " ").trim();
    const absoluteIndex = start + offset;
    return [{ text: `${selectedSet.has(id) ? "✅" : "◻️"} ${absoluteIndex + 1}. ${title.slice(0, 42)}`, callback_data: `campaign_builder_toggle:${absoluteIndex}` }];
  });
  const navigation: any[] = [];
  if (page > 0) navigation.push({ text: "⬅️ Anterior", callback_data: `campaign_builder_page:${page - 1}` });
  if (page < maxPage) navigation.push({ text: "Próxima ➡️", callback_data: `campaign_builder_page:${page + 1}` });
  if (navigation.length) keyboard.push(navigation);
  if (state.selectedProductIds.length > 0) {
    keyboard.push([{ text: `✅ Montar campanha (${state.selectedProductIds.length})`, callback_data: "campaign_builder_done" }]);
    keyboard.push([{ text: "🗑 Limpar seleção", callback_data: "campaign_builder_clear" }]);
  }
  keyboard.push([{ text: "❌ Cancelar", callback_data: "campaign_builder_cancel" }]);
  if (messageId) await deps.editTelegramMessageText(chatId, messageId, text, { inline_keyboard: keyboard });
  else await deps.sendTelegramMessage(chatId, text, { inline_keyboard: keyboard });
  return true;
}

'''
text = require_replace(text, helper_anchor, builder_helpers + helper_anchor, "builder helpers")
error_anchor = """  if (message === \"WEEKLY_MARKETING_PRODUCTION_APPROVAL_EXPIRED\") {
    return \"A aprovação expirou. A campanha precisa ser regenerada e aprovada novamente.\";
  }
"""
error_add = """  if (message === \"CAMPAIGN_CUSTOM_SELECTION_REQUIRED\") return \"Selecione pelo menos 1 produto para montar a campanha.\";
  if (message === \"CAMPAIGN_CUSTOM_SELECTION_LIMIT\") return \"O limite da campanha manual é de 10 produtos.\";
  if (message.startsWith(\"CAMPAIGN_CUSTOM_PRODUCT_NOT_READY:\")) return \"Um dos produtos selecionados não está pronto para campanha. Remova-o ou corrija o produto e tente novamente.\";
"""
text = require_replace(text, error_anchor, error_anchor + error_add, "campaign builder errors")
telegram.write_text(text)

# 5) Persistent Supabase builder state.
Path("supabase/migrations/20260905_telegram_campaign_builder_state.sql").write_text("""create table if not exists public.telegram_user_states (
  sender_id text primary key,
  action text not null,
  review_id text,
  product_id text,
  data jsonb not null default '{}'::jsonb,
  updated_at bigint not null
);

alter table public.telegram_user_states enable row level security;
revoke all on table public.telegram_user_states from anon, authenticated;
grant select, insert, update, delete on table public.telegram_user_states to service_role;

create index if not exists idx_telegram_user_states_updated_at
  on public.telegram_user_states (updated_at);
""")
validator = Path("scripts/validate-supabase-migrations.mjs")
text = validator.read_text()
text = require_replace(text, "  'product_source_observed', 'products', 'publication_executions', 'social_links', 'telegram_pending_reviews',\n", "  'product_source_observed', 'products', 'publication_executions', 'social_links', 'telegram_pending_reviews', 'telegram_user_states',\n", "migration validator")
validator.write_text(text)

# 6) Regression tests using existing FakeCampaignStore/makeCollectionProduct.
tests = Path("tests/newsletterCampaign.test.ts")
text = tests.read_text()
marker = "telegram custom campaign builder selects 1 to 10 products and creates a pending collection"
if marker not in text:
    text += r'''

test("telegram campaigns menu exposes Monte sua campanha before recent campaigns", () => {
  const view = renderRecentCampaignsForTelegram([]);
  assert.equal(view.keyboard[0][0].text, "🧩 Monte sua campanha");
  assert.equal(view.keyboard[0][0].callback_data, "campaign_builder_start");
});

test("telegram custom campaign builder selects 1 to 10 products and creates a pending collection", async (t) => {
  const { setTestUserStateHandlers } = await import("../server/repositories/telegramRepository.ts");
  let state: any = null;
  setTestUserStateHandlers({
    set: async (_senderId, next) => { state = structuredClone(next); },
    get: async () => state ? structuredClone(state) : null,
    delete: async () => { state = null; },
  });
  t.after(() => setTestUserStateHandlers(null));

  const store = new FakeCampaignStore();
  const products = Array.from({ length: 12 }, (_, index) => makeCollectionProduct(index, { ativo: true, status: "published" }));
  const answers: Array<{ text?: string; alert?: boolean }> = [];
  const edits: Array<{ text: string; markup: any }> = [];
  const deps = {
    store,
    productsLoader: async () => products,
    verifyImageAccessibility: false,
    answerCallbackQuery: async (_id: string, text?: string, alert?: boolean) => { answers.push({ text, alert }); },
    editTelegramMessageText: async (_chat: string | number, _messageId: number, text: string, markup?: any) => { edits.push({ text, markup }); return { ok: true }; },
    sendTelegramMessage: async () => ({ ok: true }),
  };

  await handleNewsletterCampaignCallback("campaign_builder_start", "cb-start", "admin-builder", 1, 100, deps);
  assert.equal(state.action, "campaign_builder");
  assert.equal(state.data.catalogProductIds.length, 12);
  assert.equal(state.data.selectedProductIds.length, 0);
  assert.match(edits.at(-1)!.text, /MONTE SUA CAMPANHA/);
  for (const row of edits.at(-1)!.markup.inline_keyboard.flat()) {
    if (row.callback_data) assert.ok(row.callback_data.length <= 64, `callback_data excedeu limite Telegram: ${row.callback_data}`);
  }

  for (let index = 0; index < 10; index++) {
    await handleNewsletterCampaignCallback(`campaign_builder_toggle:${index}`, `cb-toggle-${index}`, "admin-builder", 1, 100, deps);
  }
  assert.equal(state.data.selectedProductIds.length, 10);
  assert.equal(state.data.selectedProductIds[0], products[0].id);

  await handleNewsletterCampaignCallback("campaign_builder_toggle:10", "cb-overflow", "admin-builder", 1, 100, deps);
  assert.equal(state.data.selectedProductIds.length, 10);
  assert.equal(answers.at(-1)?.alert, true);
  assert.match(answers.at(-1)?.text || "", /Limite atingido/);

  await handleNewsletterCampaignCallback("campaign_builder_done", "cb-done", "admin-builder", undefined, undefined, deps);
  assert.equal(state, null, "builder state is cleared after campaign creation");
  const created = [...store.campaigns.values()].at(-1)!;
  assert.equal(created.campaignType, "collection");
  assert.equal(created.status, "pending_approval");
  assert.match(created.editionKey || "", /^manual:/);
  assert.equal(store.campaignProducts.get(created.id)?.length, 10);
  assert.equal(store.campaignProducts.get(created.id)?.[0].productId, products[0].id, "first selected product becomes HERO");
  assert.equal(store.campaignProducts.get(created.id)?.[0].layout, "feature");
  assert.equal(store.campaignProducts.get(created.id)?.[9].position, 10);
});
'''
tests.write_text(text)

print("Campaign builder patch prepared")
