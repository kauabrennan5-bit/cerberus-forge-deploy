#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path
from textwrap import dedent

ROOT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()
CAMPAIGN = ROOT / "server/services/newsletterWeeklyCampaign.ts"
BOT = ROOT / "server/services/telegramBot.ts"
DIAGNOSTICS = ROOT / "server/services/newsletterWeeklyDiagnostics.ts"
TEST = ROOT / "tests/newsletterWeeklyDiagnostics.test.ts"

for path in (CAMPAIGN, BOT):
    if not path.is_file():
        raise SystemExit(f"missing target file: {path}")

print("TARGET_BLOCK_FOUND=true")

campaign = CAMPAIGN.read_text()
if campaign.count("export async function runWeeklyDraftCycle(") != 1:
    raise SystemExit("TARGET_BLOCK_COUNT_INVALID:runWeeklyDraftCycle")
if campaign.count('if (commandName === "weekly-test")') != 0:
    raise SystemExit("unexpected Telegram handler in campaign file")

bot = BOT.read_text()
block_marker = '    if (commandName === "weekly-test") {'
if bot.count(block_marker) != 1:
    raise SystemExit("TARGET_BLOCK_COUNT_INVALID:weekly-test")
print("TARGET_BLOCK_COUNT=1")

DIAGNOSTICS.write_text(dedent(r'''
export type WeeklyDraftDiagnosticStage =
  | "RUNTIME_CONFIG"
  | "SUPABASE_READ"
  | "PRODUCT_SELECTION"
  | "PRODUCT_ELIGIBILITY"
  | "RANKING"
  | "GEMINI"
  | "HTML_RENDER"
  | "DRAFT_PERSIST"
  | "TELEGRAM_DELIVERY"
  | "UNKNOWN_INTERNAL";

export type WeeklyDraftDiagnosticReason =
  | "TELEGRAM_ADMIN_CHAT_MISSING"
  | "TELEGRAM_ACTOR_MISSING"
  | "PUBLIC_URL_MISSING"
  | "PUBLIC_URL_INVALID"
  | "SUPABASE_CONFIG_MISSING"
  | "SUPABASE_READ_FAILED"
  | "NO_NEW_PRODUCTS"
  | "INSUFFICIENT_PRODUCTS"
  | "RANKING_FAILED"
  | "GEMINI_CONFIG_MISSING"
  | "GEMINI_BUDGET_EXCEEDED"
  | "GEMINI_REQUEST_FAILED"
  | "GEMINI_OUTPUT_REJECTED"
  | "GEMINI_COMMERCIAL_FACT_REJECTED"
  | "HTML_RENDER_FAILED"
  | "DRAFT_INSERT_FAILED"
  | "DRAFT_PRODUCTS_PERSIST_FAILED"
  | "DRAFT_APPROVAL_PERSIST_FAILED"
  | "DRAFT_CREATED_TELEGRAM_DELIVERY_FAILED"
  | "TELEGRAM_CARD_REFERENCE_PERSIST_FAILED"
  | "UNKNOWN_INTERNAL";

export type WeeklyDraftDiagnostic = {
  attemptId: string;
  stage: WeeklyDraftDiagnosticStage;
  reason: WeeklyDraftDiagnosticReason;
  activeProductCount?: number;
  newProductCount?: number;
  eligibleProductCount?: number;
  campaignId?: string;
  draftCreated?: boolean;
  draftStatus?: string;
};

export class WeeklyDraftDiagnosticError extends Error {
  constructor(public readonly diagnostic: WeeklyDraftDiagnostic) {
    super(`WEEKLY_DRAFT_DIAGNOSTIC:${diagnostic.stage}:${diagnostic.reason}`);
    this.name = "WeeklyDraftDiagnosticError";
  }
}

export function isWeeklyDraftDiagnosticError(error: unknown): error is WeeklyDraftDiagnosticError {
  return error instanceof WeeklyDraftDiagnosticError;
}

export function classifyGeminiDiagnosticReason(error: unknown): WeeklyDraftDiagnosticReason {
  const message = error instanceof Error ? error.message : "";
  if (message === "WEEKLY_COPY_GEMINI_NOT_CONFIGURED") return "GEMINI_CONFIG_MISSING";
  if (message === "WEEKLY_COPY_GEMINI_BUDGET_EXCEEDED") return "GEMINI_BUDGET_EXCEEDED";
  if (message === "WEEKLY_COPY_COMMERCIAL_FACT_FORBIDDEN") return "GEMINI_COMMERCIAL_FACT_REJECTED";
  if (
    message === "WEEKLY_COPY_INVALID_JSON"
    || message === "WEEKLY_COPY_INCOMPLETE"
    || message === "WEEKLY_COPY_PRODUCT_COUNT_INVALID"
    || message.startsWith("WEEKLY_COPY_CAPTION_MISSING:")
  ) return "GEMINI_OUTPUT_REJECTED";
  return "GEMINI_REQUEST_FAILED";
}

export function logWeeklyDraftStage(
  attemptId: string,
  stage: WeeklyDraftDiagnosticStage,
  event: "START" | "SUCCESS" | "FAIL",
  reason?: WeeklyDraftDiagnosticReason,
): void {
  const suffix = reason ? ` reason=${reason}` : "";
  console.info(`[NEWSLETTER-WEEKLY] attempt=${attemptId} stage=${stage} event=${event}${suffix}`);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

const STAGE_LABEL: Record<WeeklyDraftDiagnosticStage, string> = {
  RUNTIME_CONFIG: "Configuração",
  SUPABASE_READ: "Supabase",
  PRODUCT_SELECTION: "Seleção de produtos",
  PRODUCT_ELIGIBILITY: "Elegibilidade de produtos",
  RANKING: "Ranking",
  GEMINI: "Gemini",
  HTML_RENDER: "Renderização HTML",
  DRAFT_PERSIST: "Persistência do rascunho",
  TELEGRAM_DELIVERY: "Telegram",
  UNKNOWN_INTERNAL: "Interno",
};

export function formatWeeklyDraftDiagnosticTelegram(diagnostic: WeeklyDraftDiagnostic): string {
  const lines = [
    "⚠️ <b>WEEKLY-TEST NÃO CRIADA</b>",
    "",
    `Etapa: <b>${escapeHtml(STAGE_LABEL[diagnostic.stage])}</b>`,
    `Motivo: <code>${escapeHtml(diagnostic.reason)}</code>`,
  ];
  if (Number.isSafeInteger(diagnostic.activeProductCount)) lines.push(`Produtos ativos: ${diagnostic.activeProductCount}`);
  if (Number.isSafeInteger(diagnostic.newProductCount)) lines.push(`Produtos novos: ${diagnostic.newProductCount}`);
  if (Number.isSafeInteger(diagnostic.eligibleProductCount)) lines.push(`Produtos elegíveis: ${diagnostic.eligibleProductCount}`);
  if (diagnostic.draftCreated && diagnostic.campaignId) {
    lines.push("", "O rascunho foi persistido, mas o fluxo não chegou à aprovação.", `<code>${escapeHtml(diagnostic.campaignId)}</code>`);
  }
  lines.push("", "Nenhum email foi enviado e nenhuma chamada Brevo foi iniciada.");
  return lines.join("\n");
}
''').lstrip())

campaign = campaign.replace(
    'import { cancelCampaign, submitCampaignForApproval } from "./newsletterCampaignService";',
    'import { submitCampaignForApproval } from "./newsletterCampaignService";',
    1,
)
import_marker = 'import { renderWeeklyNewsletter } from "./newsletterWeeklyTemplate";\n'
if import_marker not in campaign:
    raise SystemExit("campaign import marker missing")
campaign = campaign.replace(import_marker, import_marker + dedent('''
import {
  classifyGeminiDiagnosticReason,
  isWeeklyDraftDiagnosticError,
  logWeeklyDraftStage,
  WeeklyDraftDiagnosticError,
  type WeeklyDraftDiagnostic,
  type WeeklyDraftDiagnosticReason,
  type WeeklyDraftDiagnosticStage,
} from "./newsletterWeeklyDiagnostics";
'''), 1)

deps_marker = '  copyGenerator?: (products: readonly Product[]) => Promise<WeeklyNewsletterCopy>;\n  telegramSender?: (chatId: string, text: string, replyMarkup?: unknown) => Promise<TelegramDeliveryResult>;'
if deps_marker not in campaign:
    raise SystemExit("campaign deps marker missing")
campaign = campaign.replace(
    deps_marker,
    '  copyGenerator?: (products: readonly Product[]) => Promise<WeeklyNewsletterCopy>;\n  institutionalLoader?: (env: NodeJS.ProcessEnv) => Promise<Awaited<ReturnType<typeof getNewsletterInstitutionalOptions>>>;\n  telegramSender?: (chatId: string, text: string, replyMarkup?: unknown) => Promise<TelegramDeliveryResult>;',
    1,
)

start = campaign.index('export async function runWeeklyDraftCycle(')
end = campaign.index('export async function runWeeklyStaleDraftCheck(', start)
new_function = dedent(r'''
export async function runWeeklyDraftCycle(deps: WeeklyDraftDeps = {}): Promise<WeeklyDraftOutcome> {
  const env = deps.env || process.env;
  const now = deps.now || new Date();
  const testMode = deps.testMode === true;
  const weeklyEnabled = env.NEWSLETTER_WEEKLY_ENABLED === "true";
  if (!testMode && !weeklyEnabled) return { status: "skipped", reason: "disabled", newProductCount: 0 };

  const attemptId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const context: Omit<WeeklyDraftDiagnostic, "stage" | "reason"> = { attemptId };
  const fail = (
    stage: WeeklyDraftDiagnosticStage,
    reason: WeeklyDraftDiagnosticReason,
    extra: Partial<WeeklyDraftDiagnostic> = {},
  ): never => {
    const diagnostic: WeeklyDraftDiagnostic = { ...context, ...extra, attemptId, stage, reason };
    logWeeklyDraftStage(attemptId, stage, "FAIL", reason);
    throw new WeeklyDraftDiagnosticError(diagnostic);
  };
  const startStage = (stage: WeeklyDraftDiagnosticStage) => logWeeklyDraftStage(attemptId, stage, "START");
  const successStage = (stage: WeeklyDraftDiagnosticStage) => logWeeklyDraftStage(attemptId, stage, "SUCCESS");

  try {
    startStage("RUNTIME_CONFIG");
    const chatId = (env.TELEGRAM_ADMIN_CHAT_ID || "").trim();
    if (!chatId) fail("RUNTIME_CONFIG", "TELEGRAM_ADMIN_CHAT_MISSING");
    const publicBaseUrl = (env.NEWSLETTER_PUBLIC_BASE_URL || env.PUBLIC_SITE_URL || env.APP_URL || "").trim();
    if (!publicBaseUrl) fail("RUNTIME_CONFIG", "PUBLIC_URL_MISSING");
    try {
      const parsed = new URL(publicBaseUrl);
      if (!/^https?:$/.test(parsed.protocol)) fail("RUNTIME_CONFIG", "PUBLIC_URL_INVALID");
      if (env.NODE_ENV === "production" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
        fail("RUNTIME_CONFIG", "PUBLIC_URL_INVALID");
      }
    } catch (error) {
      if (isWeeklyDraftDiagnosticError(error)) throw error;
      fail("RUNTIME_CONFIG", "PUBLIC_URL_INVALID");
    }
    let actor: string;
    try { actor = envActor(env); }
    catch { fail("RUNTIME_CONFIG", "TELEGRAM_ACTOR_MISSING"); }
    let store: NewsletterCampaignStore;
    if (deps.store) store = deps.store;
    else {
      try { store = createSupabaseNewsletterCampaignStore(); }
      catch { fail("RUNTIME_CONFIG", "SUPABASE_CONFIG_MISSING"); }
    }
    successStage("RUNTIME_CONFIG");

    startStage("SUPABASE_READ");
    let products: Product[];
    let lastSentAt: string | null;
    try {
      products = await (deps.productsLoader || productsRepository.getProducts)();
      lastSentAt = testMode
        ? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
        : await (deps.lastSentAtLoader || loadLastSuccessfulCollectionSentAt)();
    } catch {
      fail("SUPABASE_READ", "SUPABASE_READ_FAILED");
    }
    successStage("SUPABASE_READ");

    startStage("PRODUCT_SELECTION");
    const cutoffMs = lastSentAt ? Date.parse(lastSentAt) : now.getTime() - 7 * 24 * 60 * 60 * 1000;
    const active = products.filter(product => product.ativo === true && product.status === "published");
    const newlyFresh = active.filter(product => freshnessMs(product) > cutoffMs);
    const fresh = newlyFresh.filter(product => Boolean(product.ref?.trim()));
    context.activeProductCount = active.length;
    context.newProductCount = newlyFresh.length;
    context.eligibleProductCount = fresh.length;
    successStage("PRODUCT_SELECTION");

    startStage("PRODUCT_ELIGIBILITY");
    if (fresh.length === 0) {
      logWeeklyDraftStage(attemptId, "PRODUCT_ELIGIBILITY", "FAIL", "NO_NEW_PRODUCTS");
      await notify(deps.telegramSender, chatId, `📭 <b>Campanha semanal pulada</b>\n\nEtapa: <b>Produtos</b>\nMotivo: <code>NO_NEW_PRODUCTS</code>\nAtivos: ${active.length} · novos: ${newlyFresh.length} · elegíveis: 0\n\nNenhum rascunho foi gerado e nenhum email foi enviado.`);
      return { status: "skipped", reason: "no_new_products", newProductCount: 0 };
    }
    if (fresh.length < 3) {
      logWeeklyDraftStage(attemptId, "PRODUCT_ELIGIBILITY", "FAIL", "INSUFFICIENT_PRODUCTS");
      await notify(deps.telegramSender, chatId, `📭 <b>Campanha semanal pulada</b>\n\nEtapa: <b>Produtos</b>\nMotivo: <code>INSUFFICIENT_PRODUCTS</code>\nAtivos: ${active.length} · novos: ${newlyFresh.length} · elegíveis: ${fresh.length}\nNecessários: 3\n\nNenhum email foi enviado.`);
      return { status: "skipped", reason: "insufficient_new_products", newProductCount: fresh.length };
    }
    successStage("PRODUCT_ELIGIBILITY");

    startStage("SUPABASE_READ");
    let clickCounts: Map<string, number>;
    try { clickCounts = await (deps.clickCountLoader || loadProductClickCounts)(fresh.map(p => p.id)); }
    catch { fail("SUPABASE_READ", "SUPABASE_READ_FAILED"); }
    successStage("SUPABASE_READ");

    startStage("RANKING");
    let selected: Product[];
    try { selected = rankCandidates(fresh, clickCounts).slice(0, 4); }
    catch { fail("RANKING", "RANKING_FAILED"); }
    successStage("RANKING");

    const key = editionKey(selected, now, testMode);
    startStage("SUPABASE_READ");
    let existing: EmailCampaign | null;
    try { existing = await store.findOperationalCollectionByEditionKey(key); }
    catch { fail("SUPABASE_READ", "SUPABASE_READ_FAILED"); }
    successStage("SUPABASE_READ");
    if (existing) return { status: "skipped", reason: "duplicate", newProductCount: fresh.length };

    startStage("GEMINI");
    let copy: WeeklyNewsletterCopy;
    try { copy = await (deps.copyGenerator || generateWeeklyNewsletterCopy)(selected); }
    catch (error) { fail("GEMINI", classifyGeminiDiagnosticReason(error)); }
    successStage("GEMINI");

    startStage("HTML_RENDER");
    let rendered: ReturnType<typeof renderWeeklyNewsletter>;
    let links: CampaignProductLink[];
    let draft: EmailCampaign;
    const campaignId = crypto.randomUUID();
    try {
      const institutional = deps.institutionalLoader
        ? await deps.institutionalLoader(env)
        : await getNewsletterInstitutionalOptions(env);
      rendered = renderWeeklyNewsletter(selected, copy, { campaignId, publicBaseUrl, socialLinks: institutional.socialLinks });
      links = selected.map((product, index) => ({ productId: product.id, position: index + 1, layout: index === 0 ? "feature" : "grid" }));
      draft = createCampaignDraft(null, actor, rendered, now, campaignId, "collection", links, key);
    } catch {
      fail("HTML_RENDER", "HTML_RENDER_FAILED");
    }
    successStage("HTML_RENDER");

    startStage("DRAFT_PERSIST");
    let persisted: EmailCampaign;
    try { persisted = await store.createCampaign(draft); }
    catch { fail("DRAFT_PERSIST", "DRAFT_INSERT_FAILED"); }
    context.campaignId = persisted.id;
    context.draftCreated = true;
    context.draftStatus = persisted.status;
    try { await store.createCampaignProducts(persisted.id, links); }
    catch { fail("DRAFT_PERSIST", "DRAFT_PRODUCTS_PERSIST_FAILED", { campaignId: persisted.id, draftCreated: true, draftStatus: persisted.status }); }
    let pending: EmailCampaign;
    try { pending = await submitCampaignForApproval(persisted, actor, { store, env, now }); }
    catch { fail("DRAFT_PERSIST", "DRAFT_APPROVAL_PERSIST_FAILED", { campaignId: persisted.id, draftCreated: true, draftStatus: persisted.status }); }
    context.draftStatus = pending.status;
    successStage("DRAFT_PERSIST");

    startStage("TELEGRAM_DELIVERY");
    let delivery: TelegramDeliveryResult;
    try {
      delivery = await notify(deps.telegramSender, chatId, telegramPreview(pending, selected, copy, clickCounts, testMode), {
        inline_keyboard: [
          [{ text: testMode ? "✅ Aprovar teste" : "✅ Aprovar e enviar", callback_data: `campaign_weekly_approve:${pending.id}` }],
          [{ text: "❌ Cancelar", callback_data: `campaign_cancel:${pending.id}` }],
        ],
      });
    } catch {
      fail("TELEGRAM_DELIVERY", "DRAFT_CREATED_TELEGRAM_DELIVERY_FAILED", { campaignId: pending.id, draftCreated: true, draftStatus: pending.status });
    }
    if (!delivery.ok) {
      fail("TELEGRAM_DELIVERY", "DRAFT_CREATED_TELEGRAM_DELIVERY_FAILED", { campaignId: pending.id, draftCreated: true, draftStatus: pending.status });
    }
    const messageId = Number(delivery.result?.message_id);
    if (Number.isSafeInteger(messageId) && messageId > 0) {
      try { await store.saveCampaignTelegramCard(pending.id, chatId, messageId); }
      catch { fail("DRAFT_PERSIST", "TELEGRAM_CARD_REFERENCE_PERSIST_FAILED", { campaignId: pending.id, draftCreated: true, draftStatus: pending.status }); }
    }
    successStage("TELEGRAM_DELIVERY");
    return { status: "created", campaign: pending, products: selected };
  } catch (error) {
    if (isWeeklyDraftDiagnosticError(error)) throw error;
    fail("UNKNOWN_INTERNAL", "UNKNOWN_INTERNAL");
  }
}

''')
campaign = campaign[:start] + new_function + campaign[end:]
CAMPAIGN.write_text(campaign)

bot = BOT.read_text()
import_marker = 'import { runWeeklyDraftCycle } from "./newsletterWeeklyCampaign";'
if import_marker not in bot:
    raise SystemExit("telegram import marker missing")
bot = bot.replace(
    import_marker,
    import_marker + '\nimport { formatWeeklyDraftDiagnosticTelegram, isWeeklyDraftDiagnosticError } from "./newsletterWeeklyDiagnostics";',
    1,
)
handler_start = bot.index(block_marker)
handler_end = bot.index('    if (commandName === "pendentes") {', handler_start)
new_handler = dedent(r'''
    if (commandName === "weekly-test") {
      if (!chatId) return;
      try {
        const outcome = await runWeeklyDraftCycle({ testMode: true });
        if (outcome.status === "skipped" && outcome.reason === "duplicate") {
          await sendTelegramMessage(chatId, "ℹ️ <b>WEEKLY-TEST JÁ PREPARADA</b>\n\nJá existe um rascunho operacional equivalente. Nenhuma nova campanha, recipient ou chamada Brevo foi criada.");
        }
      } catch (error) {
        if (isWeeklyDraftDiagnosticError(error)) {
          const diagnostic = error.diagnostic;
          console.error(`[NEWSLETTER-WEEKLY] telegram_test_command_failed attempt=${diagnostic.attemptId} stage=${diagnostic.stage} reason=${diagnostic.reason}`);
          await sendTelegramMessage(chatId, formatWeeklyDraftDiagnosticTelegram(diagnostic));
        } else {
          console.error("[NEWSLETTER-WEEKLY] telegram_test_command_failed stage=UNKNOWN_INTERNAL reason=UNKNOWN_INTERNAL");
          await sendTelegramMessage(chatId, "⚠️ <b>WEEKLY-TEST NÃO CRIADA</b>\n\nEtapa: <b>Interno</b>\nMotivo: <code>UNKNOWN_INTERNAL</code>\n\nNenhum email foi enviado e nenhuma chamada Brevo foi iniciada.");
        }
      }
      return;
    }
''')
BOT.write_text(bot[:handler_start] + new_handler + bot[handler_end:])

TEST.write_text(dedent(r'''
import test from "node:test";
import assert from "node:assert/strict";
import type { Product } from "../src/types";
import { runWeeklyDraftCycle } from "../server/services/newsletterWeeklyCampaign";
import { formatWeeklyDraftDiagnosticTelegram, isWeeklyDraftDiagnosticError } from "../server/services/newsletterWeeklyDiagnostics";

function product(id: string, createdAt = "2026-08-29T02:00:00Z"): Product {
  return {
    id, ref: `REF-${id}`, produto: `Produto ${id}`, displayTitle: `Peça ${id}`, categoria: "Iluminação", preco: 10,
    imagens: [`https://cdn.example.com/${id}.jpg`], imageEditorialStatus: "clean", link: `https://market.example.com/${id}`,
    ativo: true, destaque: false, status: "published", descricao: `Descrição ${id}`, createdAt,
  } as Product;
}

function store() {
  const campaigns = new Map<string, any>();
  return {
    campaigns,
    async createCampaign(c: any) { campaigns.set(c.id, structuredClone(c)); return structuredClone(c); },
    async createCampaignProducts() {},
    async listCampaignProducts() { return []; },
    async getCampaign(id: string) { return structuredClone(campaigns.get(id) || null); },
    async listRecentCampaigns() { return []; },
    async findOperationalCollectionByEditionKey() { return null; },
    async getCampaignTelegramCard() { return null; },
    async saveCampaignTelegramCard() {},
    async updateCampaign(c: any) { campaigns.set(c.id, structuredClone(c)); return structuredClone(c); },
    async createEligibleRecipients() { throw new Error("REAL_RECIPIENTS_MUST_NOT_BE_CREATED"); },
    async claimRecipient() { return null; }, async readSubscriber() { return null; }, async prepareUnsubscribeToken() { throw new Error("unused"); },
    async markRecipientSent() { return null; }, async markRecipientSkipped() { return null; }, async markRecipientFailed() { return null; },
    async summarizeRecipients() { return { total: 0, success: 0, failed: 0, skipped: 0 }; }, async listRetryableRecipients() { return []; },
    async resetFailedRecipients() { return 0; }, async listSendingCampaigns() { return []; },
  } as any;
}

const env = { TELEGRAM_ADMIN_CHAT_ID: "123", TELEGRAM_ALLOWED_USER_IDS: "123", NEWSLETTER_PUBLIC_BASE_URL: "https://cerberus.example.com" };
const copy = { subject: "Achados", previewText: "Preview", heroHeadline: "Forma", heroBody: "Texto editorial seguro.", secondaryCaptions: { b: "B", c: "C", d: "D" } };
const products = [product("a"), product("b"), product("c")];
const institutionalLoader = async () => ({ privacyUrl: "https://cerberus.example.com/privacy", termsUrl: "https://cerberus.example.com/terms", socialLinks: [] });

function expectDiagnostic(stage: string, reason: string) {
  return (error: unknown) => {
    assert.ok(isWeeklyDraftDiagnosticError(error));
    assert.equal(error.diagnostic.stage, stage);
    assert.equal(error.diagnostic.reason, reason);
    return true;
  };
}

test("CONFIG_MISSING é classificado sem criar draft", async () => {
  const s = store();
  await assert.rejects(runWeeklyDraftCycle({ store: s, testMode: true, env: { TELEGRAM_ADMIN_CHAT_ID: "123", TELEGRAM_ALLOWED_USER_IDS: "123" } }), expectDiagnostic("RUNTIME_CONFIG", "PUBLIC_URL_MISSING"));
  assert.equal(s.campaigns.size, 0);
});

test("SUPABASE_ERROR é classificado sem criar draft", async () => {
  const s = store();
  await assert.rejects(runWeeklyDraftCycle({ store: s, testMode: true, env, productsLoader: async () => { throw new Error("secret database detail"); } }), expectDiagnostic("SUPABASE_READ", "SUPABASE_READ_FAILED"));
  assert.equal(s.campaigns.size, 0);
});

test("NO_NEW_PRODUCTS permanece skip explícito", async () => {
  const s = store(); const messages: string[] = [];
  const result = await runWeeklyDraftCycle({ store: s, testMode: true, env, now: new Date("2026-08-29T03:00:00Z"), productsLoader: async () => [product("old", "2026-06-01T00:00:00Z")], telegramSender: async (_c,t) => { messages.push(t); return { ok:true }; } });
  assert.equal(result.status, "skipped"); assert.match(messages[0], /NO_NEW_PRODUCTS/); assert.equal(s.campaigns.size, 0);
});

test("INSUFFICIENT_PRODUCTS permanece skip explícito", async () => {
  const s = store(); const messages: string[] = [];
  const result = await runWeeklyDraftCycle({ store: s, testMode: true, env, now: new Date("2026-08-29T03:00:00Z"), productsLoader: async () => products.slice(0,2), telegramSender: async (_c,t) => { messages.push(t); return { ok:true }; } });
  assert.equal(result.status, "skipped"); assert.match(messages[0], /INSUFFICIENT_PRODUCTS/); assert.equal(s.campaigns.size, 0);
});

test("GEMINI_REQUEST_FAILED é sanitizado", async () => {
  const s = store();
  await assert.rejects(runWeeklyDraftCycle({ store:s, testMode:true, env, productsLoader:async()=>products, clickCountLoader:async()=>new Map(), copyGenerator:async()=>{ throw new Error("raw secret from upstream"); } }), expectDiagnostic("GEMINI", "GEMINI_REQUEST_FAILED"));
  assert.equal(s.campaigns.size, 0);
});

test("GEMINI_OUTPUT_REJECTED é classificado", async () => {
  const s = store();
  await assert.rejects(runWeeklyDraftCycle({ store:s, testMode:true, env, productsLoader:async()=>products, clickCountLoader:async()=>new Map(), copyGenerator:async()=>{ throw new Error("WEEKLY_COPY_INCOMPLETE"); } }), expectDiagnostic("GEMINI", "GEMINI_OUTPUT_REJECTED"));
  assert.equal(s.campaigns.size, 0);
});

test("DRAFT_PERSIST_ERROR é classificado sem recipients", async () => {
  const s = store(); s.createCampaign = async () => { throw new Error("insert detail secret"); };
  await assert.rejects(runWeeklyDraftCycle({ store:s, testMode:true, env, productsLoader:async()=>products, clickCountLoader:async()=>new Map(), copyGenerator:async()=>copy, institutionalLoader }), expectDiagnostic("DRAFT_PERSIST", "DRAFT_INSERT_FAILED"));
  assert.equal(s.campaigns.size, 0);
});

test("TELEGRAM_ERROR_AFTER_DRAFT preserva pending_approval", async () => {
  const s = store(); let captured: any;
  await assert.rejects(runWeeklyDraftCycle({ store:s, testMode:true, env, productsLoader:async()=>products, clickCountLoader:async()=>new Map(), copyGenerator:async()=>copy, institutionalLoader, telegramSender:async()=>({ok:false,failureReason:"transport secret"}) }), error => { captured=error; return expectDiagnostic("TELEGRAM_DELIVERY", "DRAFT_CREATED_TELEGRAM_DELIVERY_FAILED")(error); });
  assert.equal(captured.diagnostic.draftCreated, true); assert.ok(captured.diagnostic.campaignId); assert.equal(s.campaigns.size, 1);
  assert.equal([...s.campaigns.values()][0].status, "pending_approval");
});

test("SUCCESS_DRAFT mantém pending_approval e zero recipients", async () => {
  const s = store();
  const result = await runWeeklyDraftCycle({ store:s, testMode:true, env, productsLoader:async()=>products, clickCountLoader:async()=>new Map(), copyGenerator:async()=>copy, institutionalLoader, telegramSender:async()=>({ok:true,result:{message_id:44}}) });
  assert.equal(result.status, "created"); if (result.status === "created") assert.equal(result.campaign.status, "pending_approval");
  assert.equal(s.campaigns.size, 1);
});

test("SECRET_REDACTION não inclui secrets nem email completo", () => {
  const secrets = ["brevo-secret", "gemini-secret", "supabase-secret", "telegram-secret", "full@example.com", "Authorization: Bearer abc"];
  const text = formatWeeklyDraftDiagnosticTelegram({ attemptId:"abc", stage:"SUPABASE_READ", reason:"SUPABASE_READ_FAILED", activeProductCount:4, newProductCount:3, eligibleProductCount:3 });
  for (const secret of secrets) assert.equal(text.includes(secret), false);
  assert.equal(text.includes("stack"), false);
});
''').lstrip())

# Assertions after patch.
post_campaign = CAMPAIGN.read_text()
post_bot = BOT.read_text()
if 'DRAFT_CREATED_TELEGRAM_DELIVERY_FAILED' not in post_campaign:
    raise SystemExit("diagnostic reason missing after patch")
weekly_slice = post_campaign[post_campaign.index('export async function runWeeklyDraftCycle('):post_campaign.index('export async function runWeeklyStaleDraftCheck(')]
if 'cancelCampaign(' in weekly_slice:
    raise SystemExit("cancelCampaign remains in weekly draft flow")
if 'formatWeeklyDraftDiagnosticTelegram' not in post_bot:
    raise SystemExit("Telegram diagnostic formatter not wired")
if 'UNKNOWN_ INTERNAL' in (post_campaign + post_bot + DIAGNOSTICS.read_text()):
    raise SystemExit("invalid UNKNOWN_ INTERNAL typo found")

print("PATCH_APPLIED=true")
print("MATERIALIZED_FILES=" + ";".join([
    "server/services/newsletterWeeklyCampaign.ts",
    "server/services/newsletterWeeklyDiagnostics.ts",
    "server/services/telegramBot.ts",
    "tests/newsletterWeeklyDiagnostics.test.ts",
]))
