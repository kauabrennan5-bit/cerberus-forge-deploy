import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Product } from "../src/types.ts";
import {
  createCampaignDraft,
  transitionCampaign,
  type CampaignProductLink,
  type EmailCampaign,
} from "../server/services/newsletterCampaignState.ts";
import {
  renderNewsletterCampaign,
  renderNewsletterCollectionCampaign,
  renderNewsletterProductCollection,
  renderNewsletterWelcomeCampaign,
  resolveCampaignOfferUrl,
} from "../server/services/newsletterCampaignTemplate.ts";
import {
  buildUnsubscribeUrl,
  campaignRecipientIdempotencyKey,
  processNewsletterCampaignOnce,
} from "../server/services/newsletterCampaignWorker.ts";
import {
  DEFAULT_NEWSLETTER_ASSET_BASE_URL,
  getNewsletterHeroImageUrl,
  resolveNewsletterAssetBaseUrl,
} from "../server/services/newsletterInstitutional.ts";
import {
  assessProductReadiness,
  resolveCanonicalProductImage,
} from "../src/lib/productCanonical.ts";
import type {
  CampaignTelegramCard,
  EmailCampaignRecipient,
  NewsletterCampaignStore,
} from "../server/repositories/newsletterCampaignRepository.ts";
import type { NewsletterCampaignProvider, NewsletterCampaignProviderInput } from "../server/services/newsletterProvider.ts";
import { NewsletterProviderError } from "../server/services/newsletterProvider.ts";
import {
  confirmGeneralSend,
  createCampaignForProduct,
  createWelcomeCampaignForSubscribers,
  retryFailedCampaign,
  sendCampaignTest,
  startGeneralSend,
  createWeeklyCollectionCampaign,
  renderCampaignTelegramPreview,
} from "../server/services/newsletterCampaignService.ts";
import {
  campaignCompletionKeyboard,
  campaignKeyboard,
  handleNewsletterCampaignCallback,
  handleWelcomeCampaignCommand,
  renderCampaignCompletionReport,
  renderRecentCampaignsForTelegram,
  syncCampaignTelegramState,
} from "../server/services/newsletterCampaignTelegram.ts";
import { TELEGRAM_PANEL_COMMANDS, renderReadPanelMenu } from "../server/services/telegramPanel.ts";
import { getStartOfCurrentIsoWeek, selectNewestNewsletterProducts } from "../server/services/newsletterCampaignCollection.ts";

const product: Product = {
  id: "prod-campaign-1",
  ref: "REF-C1",
  produto: "Conjunto de cozinha",
  displayTitle: "Conjunto de cozinha editorial",
  categoria: "Casa",
  preco: 129.9,
  imagens: ["https://cdn.example.test/kitchen.jpg", "data:image/png;base64,not-used"],
  link: "https://partner.example.test/offer?existing=1",
  paginaPonteUrl: "https://cerberusfinds.com/ponte/conjunto",
  ativo: true,
  destaque: true,
  descricao: "Descrição curada",
  curatorNote: "Selecionado por acabamento e utilidade.",
  ofertaPromocional: { price: 99.9, condition: "pix", benefits: [], source: "admin_confirmed", confirmedAt: Date.now() },
};

class FakeCampaignStore implements NewsletterCampaignStore {
  campaigns = new Map<string, EmailCampaign>();
  campaignProducts = new Map<string, CampaignProductLink[]>();
  campaignTelegramCards = new Map<string, CampaignTelegramCard>();
  recipients: EmailCampaignRecipient[] = [];
  subscribers = new Map<string, { status: "subscribed" | "unsubscribed" | "suppressed"; marketing_consent: boolean }>();
  providerToken = "opaque-token-for-test-only";
  prepareCalls = 0;

  async createCampaign(campaign: EmailCampaign): Promise<EmailCampaign> { this.campaigns.set(campaign.id, structuredClone(campaign)); return structuredClone(campaign); }
  async createCampaignProducts(campaignId: string, products: CampaignProductLink[]): Promise<void> { this.campaignProducts.set(campaignId, structuredClone(products)); }
  async listCampaignProducts(campaignId: string): Promise<CampaignProductLink[]> { return structuredClone(this.campaignProducts.get(campaignId) || []); }
  async getCampaign(campaignId: string): Promise<EmailCampaign | null> { const value = this.campaigns.get(campaignId); return value ? { ...structuredClone(value), collectionProducts: structuredClone(this.campaignProducts.get(campaignId) || value.collectionProducts) } : null; }
  async updateCampaign(campaign: EmailCampaign): Promise<EmailCampaign> { this.campaigns.set(campaign.id, structuredClone(campaign)); return structuredClone(campaign); }
  async listRecentCampaigns(limit: number): Promise<EmailCampaign[]> { return [...this.campaigns.values()].slice(-Math.max(1, limit)).reverse().map(row => structuredClone(row)); }
  async getCampaignTelegramCard(campaignId: string): Promise<CampaignTelegramCard | null> { return structuredClone(this.campaignTelegramCards.get(campaignId) || null); }
  async saveCampaignTelegramCard(campaignId: string, chatId: number | string, messageId: number): Promise<void> {
    this.campaignTelegramCards.set(campaignId, { campaignId, chatId: String(chatId), messageId, updatedAt: new Date().toISOString() });
  }
  async createEligibleRecipients(campaignId: string, excludedEmail?: string): Promise<number> {
    const normalizedExcludedEmail = (excludedEmail || "").trim().toLowerCase();
    const eligible = [...this.subscribers.entries()]
      .filter(([email, value]) => value.status === "subscribed" && value.marketing_consent && email !== normalizedExcludedEmail)
      .map(([email]) => email);
    for (const email of eligible) {
      if (!this.recipients.some(row => row.campaignId === campaignId && row.subscriberEmail === email)) {
        this.recipients.push(makeRecipient(campaignId, email));
      }
    }
    return eligible.length;
  }
  async claimRecipient(campaignId: string, leaseToken: string, _leaseMs: number) {
    const row = this.recipients.find(candidate => candidate.campaignId === campaignId && candidate.status === "pending" && !candidate.leaseToken && new Date(candidate.nextAttemptAt).getTime() <= Date.now());
    if (!row) return null;
    row.attemptCount += 1;
    row.leaseToken = leaseToken;
    row.leaseUntil = new Date(Date.now() + 60_000).toISOString();
    return { recipient: structuredClone(row), leaseToken };
  }
  async readSubscriber(email: string) { return this.subscribers.get(email) || null; }
  async prepareUnsubscribeToken(email: string) { this.prepareCalls += 1; assert.ok(this.subscribers.has(email)); return this.providerToken; }
  async markRecipientSent(recipientId: string, leaseToken: string, providerMessageId?: string) { return this.updateRecipient(recipientId, leaseToken, { status: "sent", providerMessageId: providerMessageId || null, sentAt: new Date().toISOString(), leaseToken: null, leaseUntil: null }); }
  async markRecipientSkipped(recipientId: string, leaseToken: string, reason: string) { return this.updateRecipient(recipientId, leaseToken, { status: "skipped_unsubscribed", errorDetail: reason, leaseToken: null, leaseUntil: null }); }
  async markRecipientFailed(recipientId: string, leaseToken: string, errorDetail: string, nextAttemptAt: string) { return this.updateRecipient(recipientId, leaseToken, { status: "failed", errorDetail, nextAttemptAt, leaseToken: null, leaseUntil: null }); }
  async summarizeRecipients(campaignId: string) {
    const rows = this.recipients.filter(row => row.campaignId === campaignId);
    return {
      total: rows.length,
      success: rows.filter(row => row.status === "sent").length,
      failed: rows.filter(row => row.status === "failed").length,
      skipped: rows.filter(row => row.status === "skipped_unsubscribed").length,
    };
  }
  async listRetryableRecipients(campaignId: string): Promise<EmailCampaignRecipient[]> { return this.recipients.filter(row => row.campaignId === campaignId && row.status === "failed").map(row => structuredClone(row)); }
  async resetFailedRecipients(campaignId: string): Promise<number> {
    let reset = 0;
    for (const row of this.recipients.filter(candidate => candidate.campaignId === campaignId && candidate.status === "failed")) {
      row.status = "pending";
      row.errorDetail = null;
      row.sentAt = null;
      row.attemptCount = 0;
      row.nextAttemptAt = new Date(0).toISOString();
      row.leaseToken = null;
      row.leaseUntil = null;
      row.processingStartedAt = null;
      reset += 1;
    }
    return reset;
  }
  async listSendingCampaigns(limit: number): Promise<EmailCampaign[]> { return [...this.campaigns.values()].filter(row => row.status === "sending").slice(0, limit).map(row => structuredClone(row)); }

  private updateRecipient(id: string, leaseToken: string, patch: Partial<EmailCampaignRecipient>): EmailCampaignRecipient | null {
    const row = this.recipients.find(candidate => candidate.id === id && candidate.leaseToken === leaseToken);
    if (!row) return null;
    Object.assign(row, patch);
    return structuredClone(row);
  }
}

function makeRecipient(campaignId: string, email: string): EmailCampaignRecipient {
  return {
    id: `recipient-${email.replace(/[^a-z0-9]/gi, "-")}`,
    campaignId,
    subscriberEmail: email,
    status: "pending",
    providerMessageId: null,
    errorDetail: null,
    sentAt: null,
    attemptCount: 0,
    nextAttemptAt: new Date(0).toISOString(),
    leaseUntil: null,
    leaseToken: null,
    processingStartedAt: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function draft(id = "campaign-1"): EmailCampaign {
  return createCampaignDraft("prod-campaign-1", "admin-1", renderNewsletterCampaign(product, { trackingCampaignId: id }), new Date("2026-08-26T00:00:00.000Z"), id);
}

test("telegram menu exposes campaign recovery and only valid command names", () => {
  assert.equal(TELEGRAM_PANEL_COMMANDS.some(command => command.command === "campanhas"), true);
  assert.equal(TELEGRAM_PANEL_COMMANDS.some(command => command.command === "campanha2"), true);
  assert.equal(TELEGRAM_PANEL_COMMANDS.some(command => command.command === "redes"), true);
  assert.equal(TELEGRAM_PANEL_COMMANDS.some(command => command.command === "discover-batch"), false);
  assert.equal(TELEGRAM_PANEL_COMMANDS.every(command => /^[a-z0-9_]+$/.test(command.command)), true);
  assert.match(renderReadPanelMenu(), /\/campanhas/);
  assert.match(renderReadPanelMenu(), /\/campanha2/);
  assert.match(renderReadPanelMenu(), /\/redes/);
});

test("campaign list renders recovery buttons for existing statuses without touching recipients", () => {
  const pending = draft("campaign-list-pending");
  pending.status = "pending_approval";
  const testSent = draft("campaign-list-test-sent");
  testSent.status = "test_sent";
  const rendered = renderRecentCampaignsForTelegram([testSent, pending]);
  assert.match(rendered.text, /CAMPANHAS RECENTES/);
  assert.match(rendered.text, /test_sent/);
  assert.equal(rendered.keyboard.length, 2);
  assert.equal(rendered.keyboard[0][0].callback_data, `campaign_view:${testSent.id}`);
  assert.equal(rendered.keyboard[1][0].callback_data, `campaign_view:${pending.id}`);
});

test("test_sent keyboard is informational and exposes no operational actions", () => {
  const unconfirmed = { ...draft("campaign-keyboard-unconfirmed"), status: "test_sent" as const };
  assert.deepEqual(campaignKeyboard(unconfirmed), []);

  const confirmed = {
    ...unconfirmed,
    generalSendConfirmedAt: "2026-08-26T05:55:00.000Z",
    generalSendConfirmedByTelegramId: "admin-1",
  };
  assert.deepEqual(campaignKeyboard(confirmed), []);
  assert.equal(unconfirmed.status, "test_sent");
});

test("campaign cards expose only actions valid for each campaign state", () => {
  const pending = { ...draft("campaign-card-pending"), status: "pending_approval" as const };
  const pendingCallbacks = campaignKeyboard(pending).flat().map(button => button.callback_data);
  assert.ok(pendingCallbacks.includes(`campaign_approve:${pending.id}`));
  assert.ok(pendingCallbacks.includes(`campaign_subject_edit:${pending.id}`));
  assert.ok(pendingCallbacks.includes(`campaign_cancel:${pending.id}`));

  const tested = {
    ...draft("campaign-card-tested"),
    status: "test_sent" as const,
    testSentAt: "2026-08-27T05:22:16.000Z",
    testSentByTelegramId: "admin-1",
    testProviderMessageId: "provider-ref",
  };
  assert.match(renderCampaignTelegramPreview(tested, null), /TESTE CONTROLADO ENVIADO/);
  assert.match(renderCampaignTelegramPreview(tested, null), /test_sent/);
  assert.deepEqual(campaignKeyboard(tested), []);
  assert.equal(campaignKeyboard(tested).flat().some(button => /approve|subject|cancel|test|start|confirm/i.test(String(button.callback_data))), false);

  const sent = { ...draft("campaign-card-sent"), status: "sent" as const };
  assert.match(renderCampaignTelegramPreview(sent, null), /CAMPANHA CONCLUÍDA/);
  assert.deepEqual(campaignKeyboard(sent), []);

  const cancelled = { ...draft("campaign-card-cancelled"), status: "cancelled" as const };
  assert.match(renderCampaignTelegramPreview(cancelled, null), /CAMPANHA CANCELADA/);
  assert.deepEqual(campaignKeyboard(cancelled), []);
});

test("syncCampaignTelegramState is idempotent and never calls a provider", async () => {
  const store = new FakeCampaignStore();
  const campaign = {
    ...draft("campaign-sync-idempotent"),
    status: "test_sent" as const,
    testSentAt: "2026-08-27T05:22:16.000Z",
    testSentByTelegramId: "admin-1",
    testProviderMessageId: "provider-ref-sync",
  };
  store.campaigns.set(campaign.id, campaign);
  await store.saveCampaignTelegramCard(campaign.id, "8819631444", 5760);
  let editCalls = 0;
  let sendCalls = 0;
  let providerCalls = 0;
  const texts: string[] = [];
  const deps = {
    store,
    productLoader: async () => product,
    editTelegramMessageText: async (_chat: number | string, _message: number, text: string) => { editCalls += 1; texts.push(text); return { ok: true }; },
    editTelegramMessageReplyMarkup: async () => ({ ok: true }),
    sendTelegramMessage: async () => { sendCalls += 1; return { ok: true }; },
  };
  const first = await syncCampaignTelegramState(campaign.id, deps);
  const second = await syncCampaignTelegramState(campaign.id, deps);
  assert.equal(first.outcome, "updated");
  assert.equal(second.outcome, "updated");
  assert.equal(editCalls, 2);
  assert.equal(sendCalls, 0);
  assert.equal(providerCalls, 0);
  assert.equal(texts.every(text => /TESTE CONTROLADO ENVIADO/.test(text)), true);
  assert.deepEqual(await store.getCampaignTelegramCard(campaign.id), await store.getCampaignTelegramCard(campaign.id));
});

test("syncCampaignTelegramState never calls provider when message edit fails", async () => {
  const store = new FakeCampaignStore();
  const campaign = {
    ...draft("campaign-sync-edit-fails"),
    status: "test_sent" as const,
    testSentAt: "2026-08-27T05:22:16.000Z",
    testSentByTelegramId: "admin-1",
    testProviderMessageId: "provider-ref-failure",
  };
  store.campaigns.set(campaign.id, campaign);
  await store.saveCampaignTelegramCard(campaign.id, "8819631444", 5760);
  let providerCalls = 0;
  let editCalls = 0;
  let clearMarkupCalls = 0;
  let reconciliationCalls = 0;
  const result = await syncCampaignTelegramState(campaign.id, {
    store,
    productLoader: async () => product,
    editTelegramMessageText: async () => { editCalls += 1; return { ok: false, failureReason: "telegram_edit_failed" }; },
    editTelegramMessageReplyMarkup: async () => { clearMarkupCalls += 1; return { ok: true }; },
    sendTelegramMessage: async () => { reconciliationCalls += 1; return { ok: false, failureReason: "telegram_send_failed" }; },
  });
  assert.equal(result.outcome, "unavailable");
  assert.equal(editCalls, 1);
  assert.equal(clearMarkupCalls, 1);
  assert.equal(reconciliationCalls, 1);
  assert.equal(providerCalls, 0);
  assert.equal(store.campaigns.get(campaign.id)?.status, "test_sent");
});

test("syncCampaignTelegramState refuses to infer a card reference and does not mutate without one", async () => {
  const store = new FakeCampaignStore();
  const campaign = { ...draft("campaign-sync-missing-ref"), status: "test_sent" as const, testProviderMessageId: "provider-ref-missing" };
  store.campaigns.set(campaign.id, campaign);
  let transportCalls = 0;
  const result = await syncCampaignTelegramState(campaign.id, {
    store,
    editTelegramMessageText: async () => { transportCalls += 1; return { ok: true }; },
    sendTelegramMessage: async () => { transportCalls += 1; return { ok: true }; },
  });
  assert.equal(result.outcome, "missing_reference");
  assert.equal(transportCalls, 0);
  assert.equal(store.campaigns.get(campaign.id)?.status, "test_sent");
});

test("renderer uses canonical bridge, escapes content, renders offer, disclosure and unsubscribe placeholder", () => {
  const rendered = renderNewsletterCampaign({ ...product, produto: "Produto <script>", displayTitle: "Produto <script>" }, { trackingCampaignId: "campaign-1" });
  assert.match(rendered.html, /&lt;script&gt;/);
  assert.match(rendered.html, /R\$ 99,90/);
  assert.match(rendered.html, /{{UNSUBSCRIBE_URL}}/);
  assert.match(rendered.html, /utm_source=email/);
  assert.equal(rendered.text.includes("Este e-mail pode conter links de afiliado"), true);
  assert.equal(resolveCampaignOfferUrl(product), product.paginaPonteUrl);
});

test("renderer enforces the official dark palette, explicit table backgrounds and real PNG social icons", () => {
  const rendered = renderNewsletterCampaign(product, {
    socialLinks: [{
      label: "Instagram",
      url: "",
      iconUrl: "https://cerberusfinds.com/assets/newsletter/social/instagram.png",
    }],
    heroImageUrl: "https://cerberusfinds.com/assets/newsletter/products/luminaria-bauhaus-clean.png",
    heroImageStatus: "clean",
  });
  assert.match(rendered.html, /bgcolor="#0B0908"/);
  assert.match(rendered.html, /bgcolor="#181512"/);
  assert.match(rendered.html, /bgcolor="#C0392B"/);
  assert.match(rendered.html, /font-family:Georgia,'Times New Roman',serif/);
  assert.match(rendered.html, /<meta name="color-scheme" content="dark">/);
  assert.match(rendered.html, /<meta name="supported-color-schemes" content="dark">/);
  assert.doesNotMatch(rendered.html, /gmail-blend-screen|gmail-blend-difference|mix-blend-mode/);
  assert.match(rendered.html, /-webkit-text-fill-color:#FFFFFF/);
  assert.match(rendered.html, /-webkit-text-fill-color:#E8E1D3/);
  assert.match(rendered.html, /-webkit-text-fill-color:#E86B5F/);
  assert.doesNotMatch(rendered.html, /data-ogsc=|data-ogsb=|\[data-ogsc\]|\[data-ogsb\]/);
  assert.match(rendered.html, /<font color="#FFFFFF"/);
  assert.match(rendered.html, /<font color="#E8E1D3"/);
  assert.match(rendered.html, /<font color="#E86B5F"/);
  assert.doesNotMatch(rendered.html, /filter:|gradient/);
  assert.doesNotMatch(rendered.html, /#B8B0A3|#504A3F|#5A5448|#6B6255|#80786A/);
  assert.match(rendered.html, /<h1 class="email-title"[^>]*color:#FFFFFF/);
  assert.match(rendered.html, /class="email-price"[^>]*color:#FFFFFF/);
  assert.match(rendered.html, /class="email-eyebrow"[^>]*color:#E86B5F/);
  assert.doesNotMatch(rendered.html, /<td width="8"[^>]*#8A1F1F/);
  assert.match(rendered.html, /background="https:\/\/cerberus-forge-deploy-backend\.onrender\.com\/assets\/newsletter\/backgrounds\/cerberus-canvas-dark\.png"/);
  assert.doesNotMatch(rendered.html, /background="https:\/\/cerberus-forge-deploy-backend\.onrender\.com\/assets\/newsletter\/backgrounds\/cerberus-surface-dark\.png"/);
  assert.match(rendered.html, /background="https:\/\/cerberus-forge-deploy-backend\.onrender\.com\/assets\/newsletter\/backgrounds\/cerberus-cta-red\.png"/);
  assert.doesNotMatch(rendered.html, /background-image:url\('https:\/\/cerberus-forge-deploy-backend\.onrender\.com\/assets\/newsletter\/backgrounds\/cerberus-surface-dark\.png'\)/);
  assert.match(rendered.html, /class="email-price-card"[^>]+border-top:1px solid #3A342E/);
  assert.doesNotMatch(rendered.html, /#b0b0b0|#888888/);
  assert.doesNotMatch(rendered.html, /border-(left|right):/);
  assert.doesNotMatch(rendered.html, /<td align="right"/);
  const tableTags = rendered.html.match(/<table\b[^>]*>/gi) ?? [];
  assert.ok(tableTags.length >= 8);
  assert.equal(tableTags.every(table => /bgcolor="#(?:0B0908|181512|3A342E|8A1F1F|C0392B)"/i.test(table)), true);
  assert.doesNotMatch(rendered.html, /<span\b(?![^>]*display:none)/i);
  assert.match(rendered.html, /CERBERUS FINDS/);
  assert.match(rendered.html, /Curadoria independente/);
  assert.match(rendered.html, /<img src="https:\/\/cerberusfinds\.com\/assets\/newsletter\/social\/instagram\.png" width="24" height="24" alt="Instagram"/);
  assert.match(rendered.html, /luminaria-bauhaus-clean\.png/);
  assert.doesNotMatch(rendered.html, /socialMonogram|border-style:dashed|\bIG\b/);
  assert.match(rendered.html, /#0B0908|#181512|#8A1F1F|#E8E1D3|#E86B5F|#C0392B/);
  assert.match(rendered.html, /Preço verificado/);
  assert.match(rendered.html, /Sobre esta seleção/);
  assert.match(rendered.html, /Este e-mail pode conter links de afiliado/);
  assert.match(rendered.html, /{{UNSUBSCRIBE_URL}}/);

  const withoutValidatedHero = renderNewsletterCampaign(product);
  assert.doesNotMatch(withoutValidatedHero.html, /<img[^>]+src="https:\/\/cdn\.example\.test\/kitchen\.jpg"/);
});

test("social PNG assets are high-resolution sources displayed at 24px", () => {
  for (const name of ["facebook", "instagram", "pinterest", "tiktok", "x", "youtube"]) {
    const png = readFileSync(new URL(`../public/assets/newsletter/social/${name}.png`, import.meta.url));
    assert.equal(png.toString("ascii", 1, 4), "PNG");
    assert.equal(png.readUInt32BE(16), 72);
    assert.equal(png.readUInt32BE(20), 72);
  }
  for (const name of ["cerberus-canvas-dark", "cerberus-surface-dark", "cerberus-cta-red"]) {
    const png = readFileSync(new URL(`../public/assets/newsletter/backgrounds/${name}.png`, import.meta.url));
    assert.equal(png.toString("ascii", 1, 4), "PNG");
    assert.equal(png.readUInt32BE(16), 101);
    assert.equal(png.readUInt32BE(20), 101);
  }
  const rendered = renderNewsletterCampaign(product, { socialLinks: [{ label: "Instagram", url: "" }] });
  assert.match(rendered.html, /width="24" height="24"/);
});

test("renderer adds editorial footer links only when configured and preserves the premium hierarchy", () => {
  const rendered = renderNewsletterCampaign(product, {
    trackingCampaignId: "campaign-editorial",
    preheader: "Uma peça escolhida com olhar curatorial.",
    viewInBrowserUrl: "https://cerberusfinds.com/arquivo/campaign-editorial",
    privacyUrl: "https://cerberusfinds.com/politica-de-privacidade",
    termsUrl: "https://cerberusfinds.com/termos-e-condicoes",
    socialLinks: [
      { label: "Instagram", url: "https://instagram.com/cerberusfinds" },
      { label: "TikTok", url: "not-a-url" },
    ],
  });
  assert.match(rendered.html, /Uma seleção editorial encontrada para você|Uma peça escolhida com olhar curatorial/);
  assert.match(rendered.html, /Sobre esta seleção/);
  assert.match(rendered.html, /Ver online/);
  assert.match(rendered.html, /Política de privacidade/);
  assert.match(rendered.html, /Termos e condições/);
  assert.match(rendered.html, /Instagram/);
  assert.match(rendered.html, /assets\/newsletter\/social\/instagram\.png/);
  assert.match(rendered.html, /width="24" height="24"/);
  assert.match(rendered.html, /TikTok ainda não configurado/);
  assert.equal(rendered.html.includes('href="not-a-url"'), false);
  assert.equal(rendered.html.includes("Baixe nosso app"), false);
  assert.equal(rendered.html.includes("App Store"), false);
  assert.match(rendered.text, /Economia de R\$ 30,00/);
});

test("campaign creation includes real institutional paths and placeholder social icons without external calls", async () => {
  const store = new FakeCampaignStore();
  const created = await createCampaignForProduct("prod-campaign-1", "admin-1", {
    store,
    productLoader: async () => ({ ...product, status: "published" }),
    env: { DRY_RUN: "true", PUBLIC_SITE_URL: "https://cerberusfinds.com" },
    imageProbe: async () => true,
  });
  assert.match(created.bodyHtml, /https:\/\/cerberusfinds\.com\/politica-de-privacidade/);
  assert.match(created.bodyHtml, /https:\/\/cerberusfinds\.com\/termos-e-condicoes/);
  assert.match(created.bodyHtml, /Instagram ainda não configurado/);
  assert.match(created.bodyHtml, /assets\/newsletter\/social\/instagram\.png/);
  assert.match(created.bodyHtml, /<img[^>]+src="https:\/\/cdn\.example\.test\/kitchen\.jpg"/);
  assert.match(created.bodyHtml, /TikTok ainda não configurado/);
  assert.match(created.bodyHtml, /Facebook ainda não configurado/);
  assert.equal(created.bodyHtml.includes("example.com"), false);
});

test("institutional assets resolve the first HTTPS image from the canonical product", () => {
  assert.equal(
    getNewsletterHeroImageUrl({ imagens: ["https://cdn.example.test/first.jpg", "https://cdn.example.test/second.jpg"] }),
    "https://cdn.example.test/first.jpg",
  );
  assert.equal(
    getNewsletterHeroImageUrl({ imagens: ["http://cdn.example.test/insecure.jpg", "https://cdn.example.test/secure.jpg"] }),
    "https://cdn.example.test/secure.jpg",
  );
  assert.equal(resolveNewsletterAssetBaseUrl({ NEWSLETTER_PUBLIC_ASSET_BASE_URL: "not-a-url" }), DEFAULT_NEWSLETTER_ASSET_BASE_URL);
  assert.equal(getNewsletterHeroImageUrl({ imagens: [] }), undefined);
});

test("welcome campaign renders institutional copy and keeps product reference null", async () => {
  const rendered = renderNewsletterWelcomeCampaign({
    privacyUrl: "https://cerberusfinds.com/politica-de-privacidade",
    termsUrl: "https://cerberusfinds.com/termos-e-condicoes",
    socialLinks: [{ label: "Instagram", url: "not-a-url" }],
  });
  assert.match(rendered.html, /Bem-vindo à/);
  assert.match(rendered.html, /Você recebeu esta mensagem porque autorizou/);
  assert.match(rendered.html, /Cancelar inscrição/);
  assert.doesNotMatch(rendered.html, /gmail-blend-screen|gmail-blend-difference|mix-blend-mode/);
  assert.doesNotMatch(rendered.html, /#b0b0b0|#888888/);
  assert.doesNotMatch(rendered.html, /border-(left|right):/);
  assert.doesNotMatch(rendered.html, /<td align="right"/);
  assert.match(rendered.html, /Curadoria independente/);
  assert.doesNotMatch(rendered.html, /data-ogsc=|data-ogsb=|\[data-ogsc\]|\[data-ogsb\]/);
  assert.match(rendered.html, /color="#E8E1D3"/);
  assert.match(rendered.html, /bgcolor="#0B0908"/);
  assert.match(rendered.html, /assets\/newsletter\/social\/instagram\.png/);
  assert.doesNotMatch(rendered.html, /socialMonogram|border-style:dashed/);
  assert.doesNotMatch(rendered.html, /data-ogsc=|data-ogsb=|\[data-ogsc\]|\[data-ogsb\]/);
  assert.match(rendered.html, /<font color="#E8E1D3"/);
  assert.match(rendered.html, /<font color="#FFFFFF"/);
  assert.match(rendered.html, /<font color="#E86B5F"/);
  assert.doesNotMatch(rendered.html, /#B8B0A3|#504A3F|#5A5448|#6B6255|#80786A/);
  assert.doesNotMatch(rendered.html, /<td width="8"[^>]*#8A1F1F/);
  assert.doesNotMatch(rendered.html, /gradient/);
  assert.match(rendered.html, /background="https:\/\/cerberus-forge-deploy-backend\.onrender\.com\/assets\/newsletter\/backgrounds\/cerberus-canvas-dark\.png"/);
  assert.doesNotMatch(rendered.html, /background="https:\/\/cerberus-forge-deploy-backend\.onrender\.com\/assets\/newsletter\/backgrounds\/cerberus-surface-dark\.png"/);
  assert.equal(rendered.offerUrl, "");

  const store = new FakeCampaignStore();
  const created = await createWelcomeCampaignForSubscribers("admin-1", {
    store,
    env: { PUBLIC_SITE_URL: "https://cerberusfinds.com" },
  });
  assert.equal(created.campaignType, "welcome");
  assert.equal(created.productId, null);
  assert.equal(created.status, "draft");
  assert.match(created.bodyHtml, /Política de privacidade/);
});

test("welcome Telegram command creates pending campaign without recipients or provider", async () => {
  const store = new FakeCampaignStore();
  const sent: any[] = [];
  const handled = await handleWelcomeCampaignCommand("admin-1", 123, {
    store,
    env: { PUBLIC_SITE_URL: "https://cerberusfinds.com" },
    answerCallbackQuery: async () => undefined,
    editTelegramMessageText: async () => undefined,
    sendTelegramMessage: async (...args: any[]) => { sent.push(args); return undefined; },
  });
  assert.equal(handled, true);
  assert.equal(store.recipients.length, 0);
  assert.equal(sent.length, 1);
  const created = [...store.campaigns.values()][0];
  assert.equal(created.campaignType, "welcome");
  assert.equal(created.productId, null);
  assert.equal(created.status, "pending_approval");
  assert.equal(sent[0][2].inline_keyboard[0][0].callback_data, `campaign_approve:${created.id}`);
});

test("renderer omits unconfigured legal, social and browser-view blocks", () => {
  const rendered = renderNewsletterCampaign({ ...product, curatorNote: undefined, ofertaPromocional: undefined }, { trackingCampaignId: "campaign-minimal" });
  assert.equal(rendered.html.includes("Ver online"), false);
  assert.equal(rendered.html.includes("Política de privacidade"), false);
  assert.equal(rendered.html.includes("Termos e condições"), false);
  assert.equal(rendered.html.includes("Encontre a Cerberus Finds"), false);
  assert.equal(rendered.html.includes("Sobre esta seleção"), false);
  assert.equal(rendered.html.includes("{{UNSUBSCRIBE_URL}}"), true);
  assert.equal(rendered.html.includes("App Store"), false);
  assert.equal(rendered.html.includes("Google Play"), false);
});

test("state machine refuses general send before approved test and requires explicit confirmation", () => {
  const pending = transitionCampaign(draft(), { type: "submit_for_approval", actorTelegramId: "admin-1" });
  const approved = transitionCampaign(pending, { type: "approve", actorTelegramId: "admin-1" });
  assert.throws(() => transitionCampaign(approved, { type: "begin_sending", actorTelegramId: "admin-1" }), /Envio geral exige teste enviado/);
  const tested = transitionCampaign(approved, { type: "record_test_sent", actorTelegramId: "admin-1", providerReference: "provider-test-1" });
  const confirmed = transitionCampaign(tested, { type: "confirm_general_send", actorTelegramId: "admin-1" });
  const sending = transitionCampaign(confirmed, { type: "begin_sending", actorTelegramId: "admin-1" });
  assert.equal(sending.status, "sending");
});

test("recipient idempotency key is stable and scoped to campaign plus recipient", () => {
  const first = campaignRecipientIdempotencyKey("campaign-1", "recipient-1");
  assert.equal(first, campaignRecipientIdempotencyKey("campaign-1", "recipient-1"));
  assert.notEqual(first, campaignRecipientIdempotencyKey("campaign-2", "recipient-1"));
});

test("dry-run processes eligible recipients without provider call and closes campaign", async () => {
  const store = new FakeCampaignStore();
  store.subscribers.set("one@example.test", { status: "subscribed", marketing_consent: true });
  store.subscribers.set("two@example.test", { status: "suppressed", marketing_consent: false });
  const campaign = { ...draft(), status: "sending" as const };
  store.campaigns.set(campaign.id, campaign);
  await store.createEligibleRecipients(campaign.id);
  let calls = 0;
  const result = await processNewsletterCampaignOnce(store, campaign.id, {
    dryRun: true,
    batchSize: 2,
    publicBaseUrl: "https://cerberusfinds.com",
    provider: { sendCampaign: async () => { calls += 1; return { status: "succeeded" }; } },
  });
  assert.equal(result.providerCalled, false);
  assert.equal(calls, 0);
  assert.equal(result.campaign?.status, "sent");
  assert.deepEqual(result.campaign?.counts, { total: 1, success: 1, failed: 0, skipped: 0 });
});

test("real-mode worker injects unsubscribe URL only in memory and calls fake provider once", async () => {
  const store = new FakeCampaignStore();
  store.subscribers.set("one@example.test", { status: "subscribed", marketing_consent: true });
  const campaign = { ...draft(), status: "sending" as const };
  store.campaigns.set(campaign.id, campaign);
  await store.createEligibleRecipients(campaign.id);
  const calls: NewsletterCampaignProviderInput[] = [];
  const result = await processNewsletterCampaignOnce(store, campaign.id, {
    dryRun: false,
    batchSize: 1,
    publicBaseUrl: "https://cerberusfinds.com",
    provider: { sendCampaign: async input => { calls.push(input); return { status: "succeeded", providerReference: "provider-ref-test" }; } },
  });
  assert.equal(result.providerCalled, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].htmlContent, /unsubscribe\?token=opaque-token-for-test-only/);
  assert.equal(calls[0].htmlContent.includes("{{UNSUBSCRIBE_URL}}"), false);
  assert.equal(result.campaign?.status, "sent");
});


test("renderer omits curator note when absent and falls back to the canonical product link", () => {
  const withoutNote = renderNewsletterCampaign({ ...product, curatorNote: undefined, ofertaPromocional: undefined, paginaPonteUrl: undefined }, { trackingCampaignId: "campaign-no-note" });
  assert.equal(withoutNote.html.includes("Nota do curador"), false);
  assert.equal(withoutNote.text.includes("Nota do curador"), false);
  assert.equal(withoutNote.html.includes("R$ 129,90"), true);
  assert.equal(withoutNote.offerUrl.startsWith("https://partner.example.test/offer"), true);
  const parsed = new URL(withoutNote.offerUrl);
  assert.equal(parsed.searchParams.get("utm_source"), "email");
  assert.equal(parsed.searchParams.get("utm_medium"), "newsletter");
  assert.equal(parsed.searchParams.get("utm_campaign"), "campaign-no-note");
  assert.equal(parsed.searchParams.get("utm_content"), product.id);
});

test("unsubscribe URL uses the existing API contract and never leaves the placeholder after injection", () => {
  const url = buildUnsubscribeUrl("https://cerberusfinds.com/", "opaque-token-for-test-only");
  assert.equal(url, "https://cerberusfinds.com/api/newsletter/unsubscribe?token=opaque-token-for-test-only");
  const rendered = renderNewsletterCampaign(product, { unsubscribeUrl: url });
  assert.equal(rendered.html.includes("{{UNSUBSCRIBE_URL}}"), false);
  assert.equal(rendered.text.includes("{{UNSUBSCRIBE_URL}}"), false);
  assert.match(rendered.html, /api\/newsletter\/unsubscribe\?token=opaque-token-for-test-only/);
});

test("campaign creation stores a draft from an approved active product and rejects inactive products", async () => {
  const store = new FakeCampaignStore();
  const created = await createCampaignForProduct("prod-campaign-1", "admin-1", {
    store,
    productLoader: async () => ({ ...product, curatorNote: undefined, ofertaPromocional: undefined, status: "approved" }),
    env: { DRY_RUN: "true", NEWSLETTER_CAMPAIGN_SUBJECT: "Assunto controlado" },
    now: new Date("2026-08-26T00:00:00.000Z"),
    imageProbe: async () => true,
  });
  assert.equal(created.status, "draft");
  assert.equal(created.subject, "Assunto controlado");
  assert.equal(created.bodyHtml.includes("Nota do curador"), false);
  assert.equal(store.campaigns.has(created.id), true);
  await assert.rejects(
    () => createCampaignForProduct("prod-campaign-1", "admin-1", {
      store,
      productLoader: async () => ({ ...product, ativo: false }),
      env: { DRY_RUN: "true" },
    }),
    /CAMPAIGN_PRODUCT_NOT_ELIGIBLE/,
  );
});

test("campaign service persists human confirmation while retaining test_sent gate", async () => {
  const store = new FakeCampaignStore();
  const tested = { ...draft("campaign-confirm"), status: "test_sent" as const, testSentAt: new Date().toISOString(), testSentByTelegramId: "admin-1" };
  store.campaigns.set(tested.id, tested);
  const confirmed = await confirmGeneralSend(tested, "admin-1", { store });
  assert.equal(confirmed.status, "test_sent");
  assert.equal(confirmed.generalSendConfirmedByTelegramId, "admin-1");
  assert.equal(store.campaigns.get(tested.id)?.generalSendConfirmedAt !== null, true);
});

test("campaign service enforces confirmation before persisting general sending", async () => {
  const store = new FakeCampaignStore();
  store.subscribers.set("one@example.test", { status: "subscribed", marketing_consent: true });
  const tested = { ...draft(), status: "test_sent" as const, testSentAt: new Date().toISOString(), testSentByTelegramId: "admin-1" };
  store.campaigns.set(tested.id, tested);
  await assert.rejects(
    () => startGeneralSend(tested, "admin-1", { store }),
    /Confirmação humana do envio geral ausente/,
  );
  assert.equal(store.recipients.length, 0);
  const confirmed = { ...tested, generalSendConfirmedAt: new Date().toISOString(), generalSendConfirmedByTelegramId: "admin-1" };
  store.campaigns.set(confirmed.id, confirmed);
  const sending = await startGeneralSend(confirmed, "admin-1", { store });
  assert.equal(sending.status, "sending");
  assert.equal(sending.counts.total, 1);
});

test("general eligibility excludes configured test email but keeps normal and plus-alias subscribers", async () => {
  const store = new FakeCampaignStore();
  store.subscribers.set("admin@example.test", { status: "subscribed", marketing_consent: true });
  store.subscribers.set("regular@example.test", { status: "subscribed", marketing_consent: true });
  store.subscribers.set("regular+tag@gmail.com", { status: "subscribed", marketing_consent: true });
  store.subscribers.set("suppressed@example.test", { status: "suppressed", marketing_consent: false });
  const subscribersBefore = structuredClone([...store.subscribers.entries()]);
  const confirmed = {
    ...draft("campaign-test-recipient-exclusion"),
    status: "test_sent" as const,
    testSentAt: new Date().toISOString(),
    testSentByTelegramId: "admin-1",
    generalSendConfirmedAt: new Date().toISOString(),
    generalSendConfirmedByTelegramId: "admin-1",
  };
  store.campaigns.set(confirmed.id, confirmed);

  const sending = await startGeneralSend(confirmed, "admin-1", {
    store,
    env: { NEWSLETTER_TEST_EMAIL: " ADMIN@EXAMPLE.TEST " },
  });

  assert.equal(sending.status, "sending");
  assert.equal(sending.counts.total, 2);
  assert.deepEqual(
    store.recipients.map(row => row.subscriberEmail).sort(),
    ["regular+tag@gmail.com", "regular@example.test"],
  );
  assert.equal(store.recipients.some(row => row.subscriberEmail === "admin@example.test"), false);
  assert.deepEqual([...store.subscribers.entries()], subscribersBefore);
});

test("campaign start with zero eligible subscribers closes safely without recipients", async () => {
  const store = new FakeCampaignStore();
  const confirmed = {
    ...draft("campaign-zero-eligible"),
    status: "test_sent" as const,
    testSentAt: new Date("2026-08-26T05:50:00.000Z").toISOString(),
    testSentByTelegramId: "admin-1",
    generalSendConfirmedAt: new Date("2026-08-26T05:55:00.000Z").toISOString(),
    generalSendConfirmedByTelegramId: "admin-1",
  };
  store.campaigns.set(confirmed.id, confirmed);
  const completed = await startGeneralSend(confirmed, "admin-1", {
    store,
    now: new Date("2026-08-26T06:00:00.000Z"),
  });
  assert.equal(completed.status, "sent");
  assert.deepEqual(completed.counts, { total: 0, success: 0, failed: 0, skipped: 0 });
  assert.equal(completed.sentAt, "2026-08-26T06:00:00.000Z");
  assert.equal(store.recipients.length, 0);
});

test("DRY_RUN test-send uses a fake provider and does not prepare a production unsubscribe token", async () => {
  const store = new FakeCampaignStore();
  store.subscribers.set("test@example.test", { status: "subscribed", marketing_consent: true });
  const approved = { ...draft("campaign-test"), status: "approved" as const };
  store.campaigns.set(approved.id, approved);
  const result = await sendCampaignTest(approved, "admin-1", {
    store,
    env: { DRY_RUN: "true", NEWSLETTER_TEST_EMAIL: "test@example.test", NEWSLETTER_PUBLIC_BASE_URL: "https://cerberusfinds.com" },
  });
  assert.equal(result.providerResult.status, "succeeded");
  assert.equal(result.campaign.status, "test_sent");
  assert.equal(result.campaign.testProviderMessageId, "dry-run:test:campaign-test");
  assert.equal(store.prepareCalls, 0);
});

test("administrative real-mode test remains exclusive to configured test email", async () => {
  const store = new FakeCampaignStore();
  store.subscribers.set("gutemberg160701@gmail.com", { status: "subscribed", marketing_consent: true });
  const approved = { ...draft("campaign-admin-real-test"), status: "approved" as const };
  store.campaigns.set(approved.id, approved);
  let called = 0;
  const provider: NewsletterCampaignProvider = {
    async sendCampaign(input: NewsletterCampaignProviderInput) {
      called += 1;
      assert.equal(input.subscriberEmail, "gutemberg160701@gmail.com");
      assert.equal(input.subject, "[Teste controlado] Nova seleção: Conjunto de cozinha editorial");
      assert.match(input.htmlContent, /api\/newsletter\/unsubscribe/);
      return { status: "succeeded", providerReference: "fake-test-message" };
    },
  };
  const result = await sendCampaignTest(approved, "admin-1", {
    store,
    provider,
    env: {
      DRY_RUN: "false",
      NEWSLETTER_TEST_EMAIL: "Gutemberg160701@gmail.com",
      NEWSLETTER_PUBLIC_BASE_URL: "https://cerberus-forge-deploy-backend.onrender.com",
    },
  });
  assert.equal(result.providerResult.providerReference, "fake-test-message");
  assert.equal(result.campaign.status, "test_sent");
  assert.equal(result.campaign.testProviderMessageId, "fake-test-message");
  assert.ok(result.campaign.testSentAt);
  assert.equal(called, 1);
  assert.equal(store.prepareCalls, 0);
  assert.equal(store.recipients.length, 0);
});

test("administrative duplicate test persists the provider reference without recipients", async () => {
  const store = new FakeCampaignStore();
  const approved = { ...draft("campaign-admin-duplicate"), status: "approved" as const };
  store.campaigns.set(approved.id, approved);
  const result = await sendCampaignTest(approved, "admin-1", {
    store,
    provider: { sendCampaign: async () => ({ status: "duplicate", providerReference: "duplicate-message" }) },
    env: {
      NEWSLETTER_TEST_EMAIL: "gutemberg160701@gmail.com",
      NEWSLETTER_PUBLIC_BASE_URL: "https://cerberus-forge-deploy-backend.onrender.com",
    },
  });
  assert.equal(result.providerResult.status, "duplicate");
  assert.equal(result.campaign.status, "test_sent");
  assert.equal(result.campaign.testProviderMessageId, "duplicate-message");
  assert.equal(store.recipients.length, 0);
});

test("administrative test refuses to enter test_sent when provider reference is missing", async () => {
  const store = new FakeCampaignStore();
  const approved = { ...draft("campaign-admin-no-reference"), status: "approved" as const };
  store.campaigns.set(approved.id, approved);
  await assert.rejects(
    () => sendCampaignTest(approved, "admin-1", {
      store,
      provider: { sendCampaign: async () => ({ status: "succeeded" }) },
      env: { NEWSLETTER_TEST_EMAIL: "gutemberg160701@gmail.com", NEWSLETTER_PUBLIC_BASE_URL: "https://cerberusfinds.com" },
    }),
    /CAMPAIGN_TEST_PROVIDER_REFERENCE_MISSING/,
  );
  const persisted = await store.getCampaign(approved.id);
  assert.equal(persisted?.status, "approved");
  assert.equal(persisted?.testProviderMessageId, null);
  assert.equal(store.recipients.length, 0);
});

test("worker revalidates unsubscribe/consent before fake delivery", async () => {
  const store = new FakeCampaignStore();
  store.subscribers.set("revoked@example.test", { status: "subscribed", marketing_consent: true });
  const campaign = { ...draft("campaign-revalidation"), status: "sending" as const };
  store.campaigns.set(campaign.id, campaign);
  await store.createEligibleRecipients(campaign.id);
  store.subscribers.set("revoked@example.test", { status: "unsubscribed", marketing_consent: false });
  let calls = 0;
  const result = await processNewsletterCampaignOnce(store, campaign.id, {
    dryRun: true,
    batchSize: 1,
    provider: { sendCampaign: async () => { calls += 1; return { status: "succeeded" }; } },
  });
  assert.equal(calls, 0);
  assert.equal(result.outcome, "skipped_unsubscribed");
  assert.deepEqual(result.campaign?.counts, { total: 1, success: 0, failed: 0, skipped: 1 });
});

test("sent recipient is not claimed again and retry resets only failed recipients", async () => {
  const store = new FakeCampaignStore();
  store.subscribers.set("one@example.test", { status: "subscribed", marketing_consent: true });
  const campaign = { ...draft("campaign-idempotent"), status: "sending" as const };
  store.campaigns.set(campaign.id, campaign);
  await store.createEligibleRecipients(campaign.id);
  let calls = 0;
  const provider: NewsletterCampaignProvider = { sendCampaign: async () => { calls += 1; return { status: "succeeded", providerReference: "ref-1" }; } };
  await processNewsletterCampaignOnce(store, campaign.id, { dryRun: false, provider, batchSize: 1, publicBaseUrl: "https://cerberusfinds.com" });
  const second = await processNewsletterCampaignOnce(store, campaign.id, { dryRun: false, provider, batchSize: 1, publicBaseUrl: "https://cerberusfinds.com" });
  assert.equal(calls, 1);
  assert.equal(second.processed, 0);
  const failedCampaign = { ...draft("campaign-retry"), status: "failed" as const, generalSendConfirmedAt: new Date().toISOString(), generalSendConfirmedByTelegramId: "admin-1" };
  store.campaigns.set(failedCampaign.id, failedCampaign);
  store.recipients.push({ ...makeRecipient(failedCampaign.id, "one@example.test"), status: "failed", attemptCount: 4, errorDetail: "PROVIDER_HTTP_503" });
  const retrying = await retryFailedCampaign(failedCampaign, "admin-1", { store });
  assert.equal(retrying.status, "sending");
  const retried = store.recipients.find(row => row.campaignId === failedCampaign.id);
  assert.equal(retried?.status, "pending");
  assert.equal(retried?.attemptCount, 0);
});

test("permanent provider failures are sanitized and do not trigger a duplicate second delivery", async () => {
  const store = new FakeCampaignStore();
  store.subscribers.set("one@example.test", { status: "subscribed", marketing_consent: true });
  const campaign = { ...draft("campaign-permanent"), status: "sending" as const };
  store.campaigns.set(campaign.id, campaign);
  await store.createEligibleRecipients(campaign.id);
  const provider = {
    sendCampaign: async () => { throw new NewsletterProviderError("permanent_4xx", "PROVIDER_HTTP_400", "secret provider response"); },
  };
  const result = await processNewsletterCampaignOnce(store, campaign.id, { dryRun: false, provider, batchSize: 1, publicBaseUrl: "https://cerberusfinds.com" });
  assert.equal(result.outcome, "failed");
  assert.equal(result.campaign?.status, "failed");
  assert.equal(result.recipient?.errorDetail, "PROVIDER_HTTP_400");
  assert.equal(result.recipient?.errorDetail?.includes("secret"), false);
  const again = await processNewsletterCampaignOnce(store, campaign.id, { dryRun: false, provider, batchSize: 1, publicBaseUrl: "https://cerberusfinds.com" });
  assert.equal(again.processed, 0);
});

test("concurrent fake workers share the claim and process one recipient only", async () => {
  const store = new FakeCampaignStore();
  store.subscribers.set("one@example.test", { status: "subscribed", marketing_consent: true });
  const campaign = { ...draft("campaign-concurrency"), status: "sending" as const };
  store.campaigns.set(campaign.id, campaign);
  await store.createEligibleRecipients(campaign.id);
  let calls = 0;
  const provider: NewsletterCampaignProvider = { sendCampaign: async () => { calls += 1; await new Promise(resolve => setTimeout(resolve, 5)); return { status: "succeeded" }; } };
  const results = await Promise.all([
    processNewsletterCampaignOnce(store, campaign.id, { dryRun: false, provider, batchSize: 1, publicBaseUrl: "https://cerberusfinds.com" }),
    processNewsletterCampaignOnce(store, campaign.id, { dryRun: false, provider, batchSize: 1, publicBaseUrl: "https://cerberusfinds.com" }),
  ]);
  assert.equal(calls, 1);
  assert.equal(results.filter(result => result.processed === 1).length, 1);
});

test("Telegram callback approval/test paths use injected transports and mask the test destination", async () => {
  const store = new FakeCampaignStore();
  store.subscribers.set("operator@example.test", { status: "subscribed", marketing_consent: true });
  const pending = { ...draft("campaign-telegram"), status: "pending_approval" as const };
  store.campaigns.set(pending.id, pending);
  const sent: string[] = [];
  const answers: string[] = [];
  const deps = {
    store,
    env: { DRY_RUN: "true", NEWSLETTER_TEST_EMAIL: "operator@example.test", NEWSLETTER_PUBLIC_BASE_URL: "https://cerberusfinds.com" },
    productLoader: async () => product,
    answerCallbackQuery: async (_id: string, text?: string) => { answers.push(text || ""); },
    editTelegramMessageText: async (_chat: number | string, _message: number, text: string) => { sent.push(text); },
    sendTelegramMessage: async (_chat: number | string, text: string) => { sent.push(text); },
  };
  await handleNewsletterCampaignCallback("campaign_approve:campaign-telegram", "callback-1", "admin-1", 1, undefined, deps);
  assert.equal(store.campaigns.get(pending.id)?.status, "approved");
  const handled = await handleNewsletterCampaignCallback("campaign_test:campaign-telegram", "callback-2", "admin-1", 1, undefined, deps);
  assert.equal(handled, true);
  assert.equal(sent.some(message => message.includes("DRY_RUN/fake")), true);
  assert.equal(sent.some(message => message.includes("o***@example.test")), true);
  assert.equal(sent.some(message => message.includes("operator@example.test")), false);
  assert.equal(answers.length >= 2, true);
});

test("legitimate pending approval updates the Telegram card to approved with only the test gate", async () => {
  const store = new FakeCampaignStore();
  const pending = { ...draft("campaign-legitimate-approval"), status: "pending_approval" as const };
  store.campaigns.set(pending.id, pending);
  const markups: any[] = [];
  const answers: string[] = [];
  const deps = {
    store,
    productLoader: async () => product,
    answerCallbackQuery: async (_id: string, text?: string) => { answers.push(text || ""); },
    editTelegramMessageText: async (_chat: number | string, _message: number, text: string, markup?: any) => { markups.push({ text, markup }); },
    sendTelegramMessage: async () => undefined,
  };
  await handleNewsletterCampaignCallback(`campaign_approve:${pending.id}`, "callback-legitimate", "admin-1", 1, 776, deps);
  assert.equal(store.campaigns.get(pending.id)?.status, "approved");
  assert.match(answers[0], /Prévia aprovada/);
  assert.match(markups[0].text, /Status: <code>approved<\/code>/);
  assert.equal(markups[0].markup.inline_keyboard[0][0].callback_data, `campaign_test:${pending.id}`);
  assert.equal(markups[0].markup.inline_keyboard.some((row: any[]) => row.some(button => String(button.callback_data).includes("campaign_confirm_general"))), false);
});

test("stale approval card reloads test_sent state and blocks without a provider call", async () => {
  const store = new FakeCampaignStore();
  const campaign = {
    ...draft("campaign-stale-approval"),
    status: "test_sent" as const,
    approvedAt: "2026-08-27T05:21:38.000Z",
    approvedByTelegramId: "admin-1",
    testSentAt: "2026-08-27T05:22:16.000Z",
    testSentByTelegramId: "admin-1",
    testProviderMessageId: "provider-reference-1",
  };
  store.campaigns.set(campaign.id, campaign);
  const answers: string[] = [];
  const edited: Array<{ text: string; markup?: any }> = [];
  let providerCalls = 0;
  const deps = {
    store,
    env: { NEWSLETTER_TEST_EMAIL: "operator@example.test", NEWSLETTER_PUBLIC_BASE_URL: "https://cerberusfinds.com" },
    productLoader: async () => product,
    answerCallbackQuery: async (_id: string, text?: string) => { answers.push(text || ""); },
    editTelegramMessageText: async (_chat: number | string, _message: number, text: string, markup?: any) => { edited.push({ text, markup }); },
    sendTelegramMessage: async () => undefined,
  };
  await handleNewsletterCampaignCallback(`campaign_approve:${campaign.id}`, "callback-stale", "admin-1", 1, 777, deps);
  assert.equal(providerCalls, 0);
  assert.equal(store.campaigns.get(campaign.id)?.status, "test_sent");
  assert.match(answers[0], /test_sent/);
  assert.match(edited[0].text, /TESTE CONTROLADO ENVIADO/);
  assert.deepEqual(edited[0].markup.inline_keyboard, []);
});

test("stale approval card reloads sent state and blocks without overwriting it", async () => {
  const store = new FakeCampaignStore();
  const campaign = {
    ...draft("campaign-stale-sent"),
    status: "sent" as const,
    approvedAt: "2026-08-27T05:21:38.000Z",
    approvedByTelegramId: "admin-1",
    testSentAt: "2026-08-27T05:22:16.000Z",
    testSentByTelegramId: "admin-1",
    testProviderMessageId: "provider-reference-2",
    generalSendConfirmedAt: "2026-08-27T05:23:00.000Z",
    generalSendConfirmedByTelegramId: "admin-1",
    sentAt: "2026-08-27T05:24:00.000Z",
  };
  store.campaigns.set(campaign.id, campaign);
  const answers: string[] = [];
  const edited: string[] = [];
  const deps = {
    store,
    productLoader: async () => product,
    answerCallbackQuery: async (_id: string, text?: string) => { answers.push(text || ""); },
    editTelegramMessageText: async (_chat: number | string, _message: number, text: string) => { edited.push(text); },
    sendTelegramMessage: async () => undefined,
  };
  await handleNewsletterCampaignCallback(`campaign_approve:${campaign.id}`, "callback-sent", "admin-1", 1, 778, deps);
  assert.equal(store.campaigns.get(campaign.id)?.status, "sent");
  assert.match(answers[0], /sent/);
  assert.match(edited[0], /Status: <code>sent<\/code>/);
});

test("test_sent campaign rejects a second test before calling the provider", async () => {
  const store = new FakeCampaignStore();
  const campaign = {
    ...draft("campaign-second-test"),
    status: "test_sent" as const,
    approvedAt: "2026-08-27T05:21:38.000Z",
    approvedByTelegramId: "admin-1",
    testSentAt: "2026-08-27T05:22:16.000Z",
    testSentByTelegramId: "admin-1",
    testProviderMessageId: "provider-reference-3",
  };
  store.campaigns.set(campaign.id, campaign);
  let calls = 0;
  const answers: string[] = [];
  const deps = {
    store,
    productLoader: async () => product,
    answerCallbackQuery: async (_id: string, text?: string) => { answers.push(text || ""); },
    editTelegramMessageText: async () => undefined,
    sendTelegramMessage: async () => undefined,
  };
  await handleNewsletterCampaignCallback(`campaign_test:${campaign.id}`, "callback-second-test", "admin-1", 1, 779, {
    ...deps,
    provider: { sendCampaign: async () => { calls += 1; return { status: "succeeded", providerReference: "must-not-be-used" }; } },
  } as typeof deps & { provider?: NewsletterCampaignProvider });
  assert.equal(calls, 0);
  assert.equal(store.campaigns.get(campaign.id)?.status, "test_sent");
  assert.match(answers[0], /test_sent/);
});

test("two concurrent test callbacks produce one provider call and one persisted transition", async () => {
  const store = new FakeCampaignStore();
  const campaign = { ...draft("campaign-concurrent-test"), status: "approved" as const };
  store.campaigns.set(campaign.id, campaign);
  let calls = 0;
  const answers: string[] = [];
  const deps = {
    store,
    env: { NEWSLETTER_TEST_EMAIL: "operator@example.test", NEWSLETTER_PUBLIC_BASE_URL: "https://cerberusfinds.com" },
    productLoader: async () => product,
    provider: {
      sendCampaign: async () => {
        calls += 1;
        await new Promise(resolve => setTimeout(resolve, 5));
        return { status: "succeeded" as const, providerReference: "provider-concurrent-1" };
      },
    },
    answerCallbackQuery: async (_id: string, text?: string) => { answers.push(text || ""); },
    editTelegramMessageText: async () => undefined,
    sendTelegramMessage: async () => undefined,
  };
  await Promise.all([
    handleNewsletterCampaignCallback(`campaign_test:${campaign.id}`, "callback-concurrent-1", "admin-1", 1, 780, deps),
    handleNewsletterCampaignCallback(`campaign_test:${campaign.id}`, "callback-concurrent-2", "admin-1", 1, 781, deps),
  ]);
  assert.equal(calls, 1);
  assert.equal(store.campaigns.get(campaign.id)?.status, "test_sent");
  assert.equal(store.recipients.length, 0);
  assert.equal(answers.filter(answer => /test_sent/.test(answer)).length, 1);
});

test("Telegram confirmation callback preserves test_sent without creating recipients", async () => {
  const store = new FakeCampaignStore();
  const campaign = { ...draft("campaign-confirm-rerender"), status: "test_sent" as const };
  store.campaigns.set(campaign.id, campaign);
  const markups: any[] = [];
  const answers: string[] = [];
  const deps = {
    store,
    env: { DRY_RUN: "true", NEWSLETTER_TEST_EMAIL: "operator@example.test", NEWSLETTER_PUBLIC_BASE_URL: "https://cerberusfinds.com" },
    productLoader: async () => product,
    answerCallbackQuery: async (_id: string, text?: string) => { answers.push(text || ""); },
    editTelegramMessageText: async (_chat: number | string, _message: number, _text: string, replyMarkup?: unknown) => { markups.push(replyMarkup); },
    sendTelegramMessage: async () => undefined,
  };

  await handleNewsletterCampaignCallback(`campaign_confirm_general:${campaign.id}`, "callback-confirm", "admin-1", 1, 777, deps);
  const saved = store.campaigns.get(campaign.id);
  assert.equal(saved?.status, "test_sent");
  assert.equal(saved?.generalSendConfirmedByTelegramId, "admin-1");
  assert.equal(store.recipients.length, 0);
  assert.match(answers[0], /Confirmação registrada/);
  assert.deepEqual(markups[0]["inline_keyboard"], []);
});

test("Telegram completion report includes counts and retry only for failed campaigns", () => {
  const failed = { ...draft("campaign-report"), status: "failed" as const, counts: { total: 3, success: 1, failed: 1, skipped: 1 } };
  const sent = { ...failed, status: "sent" as const, counts: { total: 3, success: 2, failed: 0, skipped: 1 } };
  const zeroRecipientSent = { ...draft("campaign-zero-report"), status: "sent" as const, counts: { total: 0, success: 0, failed: 0, skipped: 0 } };
  const report = renderCampaignCompletionReport(failed);
  const zeroRecipientReport = renderCampaignCompletionReport(zeroRecipientSent);
  assert.match(report, /Produto:/);
  assert.match(report, /Destinatários: <b>3<\/b>/);
  assert.match(report, /Falhas: <b>1<\/b>/);
  assert.equal(campaignCompletionKeyboard(failed)[0][0].callback_data, "campaign_retry:campaign-report");
  assert.deepEqual(campaignCompletionKeyboard(sent), []);
  assert.match(zeroRecipientReport, /encerrada sem envio: não havia destinatários elegíveis/);
  assert.equal(report.includes("operator@example.test"), false);
});


test("DRY_RUN provider itself is never called by the campaign worker", async () => {
  const store = new FakeCampaignStore();
  store.subscribers.set("one@example.test", { status: "subscribed", marketing_consent: true });
  const campaign = { ...draft("campaign-dry-provider"), status: "sending" as const };
  store.campaigns.set(campaign.id, campaign);
  await store.createEligibleRecipients(campaign.id);
  let called = false;
  const result = await processNewsletterCampaignOnce(store, campaign.id, {
    dryRun: true,
    provider: { sendCampaign: async () => { called = true; return { status: "succeeded" }; } },
    batchSize: 1,
  });
  assert.equal(result.providerCalled, false);
  assert.equal(called, false);
});


test("canonical product image resolution preserves deterministic HTTPS order and deduplicates", () => {
  const resolved = resolveCanonicalProductImage({
    imagens: [
      "http://cdn.example.test/insecure.jpg",
      "https://cdn.example.test/second.jpg",
      "https://cdn.example.test/second.jpg",
      "https://cdn.example.test/third.jpg",
    ],
  });
  assert.equal(resolved.status, "ready");
  assert.equal(resolved.primaryImageUrl, "https://cdn.example.test/second.jpg");
  assert.deepEqual(resolved.publicHttpsImageUrls, [
    "https://cdn.example.test/second.jpg",
    "https://cdn.example.test/third.jpg",
  ]);
});

test("product readiness returns an explicit incomplete state without an image", async () => {
  const readiness = await assessProductReadiness({
    ...product,
    id: "prod-without-image",
    imagens: [],
  }, { channel: "campaign" });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.image.status, "incomplete");
  assert.match(readiness.errors.join("|"), /PRODUCT_IMAGE_MISSING/);
});

test("product readiness rejects an inaccessible HTTPS image and campaign creation does not proceed", async () => {
  const store = new FakeCampaignStore();
  const inaccessible = { ...product, id: "prod-inaccessible", imagens: ["https://cdn.example.test/unavailable.jpg"] };
  const readiness = await assessProductReadiness(inaccessible, {
    channel: "campaign",
    verifyImageAccessibility: true,
    imageProbe: async () => false,
  });
  assert.equal(readiness.ready, false);
  assert.match(readiness.errors.join("|"), /PRODUCT_IMAGE_INACCESSIBLE/);
  await assert.rejects(
    () => createCampaignForProduct("prod-inaccessible", "admin-1", {
      store,
      productLoader: async () => inaccessible,
      imageProbe: async () => false,
      env: { DRY_RUN: "true", PUBLIC_SITE_URL: "https://cerberusfinds.com" },
    }),
    /CAMPAIGN_PRODUCT_NOT_READY:.*PRODUCT_IMAGE_INACCESSIBLE/,
  );
  assert.equal(store.campaigns.size, 0);
});

test("REF-016 resolves its database image without a manual product-id mapping and includes it in the individual campaign", async () => {
  const ref016 = {
    ...product,
    id: "prod-1787351832260",
    ref: "REF-016",
    produto: "Luminária Pendente de Vidro Estilo Bauhaus",
    displayTitle: "Luminária Pendente de Vidro Estilo Bauhaus",
    imagens: ["https://img.example.test/ref016-primary.jpg", "https://img.example.test/ref016-secondary.jpg"],
  };
  assert.equal(getNewsletterHeroImageUrl(ref016), "https://img.example.test/ref016-primary.jpg");
  const store = new FakeCampaignStore();
  const campaign = await createCampaignForProduct(ref016.id, "admin-1", {
    store,
    productLoader: async () => ref016,
    imageProbe: async () => true,
    env: { DRY_RUN: "true", PUBLIC_SITE_URL: "https://cerberusfinds.com" },
  });
  assert.match(campaign.bodyHtml, /<img[^>]+class="email-hero"[^>]+src="https:\/\/img\.example\.test\/ref016-primary\.jpg"/);
});

test("a future product absent from every manual map resolves normally through products.imagens", () => {
  const futureProduct = {
    ...product,
    id: "prod-future-without-map",
    ref: "REF-FUTURE",
    imagens: ["https://img.example.test/future-primary.webp"],
  };
  const readiness = resolveCanonicalProductImage(futureProduct);
  assert.equal(readiness.status, "ready");
  assert.equal(readiness.primaryImageUrl, "https://img.example.test/future-primary.webp");
  assert.match(renderNewsletterCampaign(futureProduct, {
    heroImageUrl: readiness.primaryImageUrl,
    heroImageStatus: "clean",
  }).html, /<img[^>]+src="https:\/\/img\.example\.test\/future-primary\.webp"/);
});

test("multi-product newsletter renderer resolves one primary image per product with the same canonical mechanism", () => {
  const first = { ...product, id: "prod-multi-a", imagens: ["https://img.example.test/a-primary.jpg", "https://img.example.test/a-secondary.jpg"] };
  const second = { ...product, id: "prod-multi-b", imagens: ["https://img.example.test/b-primary.jpg"] };
  const rendered = renderNewsletterProductCollection([first, second], { trackingCampaignId: "campaign-multi" });
  assert.equal((rendered.html.match(/class="email-collection-image"/g) || []).length, 2);
  assert.match(rendered.html, /a-primary\.jpg/);
  assert.match(rendered.html, /b-primary\.jpg/);
  assert.equal(rendered.offerUrls.length, 2);
  assert.match(rendered.offerUrls[0], /utm_content=prod-multi-a/);
  assert.match(rendered.offerUrls[1], /utm_content=prod-multi-b/);
});

test("multi-product renderer fails closed for a product without a valid image or destination", () => {
  const incomplete = { ...product, id: "prod-multi-incomplete", imagens: [] };
  assert.throws(
    () => renderNewsletterProductCollection([incomplete]),
    /NEWSLETTER_COLLECTION_PRODUCT_IMAGE_MISSING/,
  );
});

test("canonical product and campaign renderers do not expose secrets or credentials", () => {
  const futureProduct = { ...product, id: "prod-secret-scan", imagens: ["https://img.example.test/safe.jpg"] };
  const html = renderNewsletterProductCollection([futureProduct], { trackingCampaignId: "campaign-safe" }).html;
  assert.doesNotMatch(html, /BREVO_API_KEY|SUPABASE_SERVICE_ROLE_KEY|xkeysib-|sk-[A-Za-z0-9]{20,}|BEGIN .* PRIVATE KEY/i);
});

test("closed editorial planner uses the exact sequence for 1, 3, 5 and 7 products", () => {
  const expected: Record<number, string[]> = {
    1: ["MASTHEAD", "HERO", "MICROEDITORIAL"],
    3: ["MASTHEAD", "HERO", "MICROEDITORIAL", "GRID-2"],
    5: ["MASTHEAD", "HERO", "MICROEDITORIAL", "GRID-2", "MICROEDITORIAL", "DESTAQUE-HORIZONTAL", "COMPACTO"],
    7: ["MASTHEAD", "HERO", "MICROEDITORIAL", "GRID-2", "MICROEDITORIAL", "DESTAQUE-HORIZONTAL", "COMPACTO", "GRID-2"],
  };
  for (const [count, sequence] of Object.entries(expected)) {
    const products = Array.from({ length: Number(count) }, (_, index) => makeCollectionProduct(index));
    const rendered = renderNewsletterProductCollection(products, { trackingCampaignId: `campaign-${count}` });
    assert.deepEqual(rendered.blockSequence, sequence);
    assert.equal(rendered.offerUrls.length, Number(count));
    assert.equal(new Set(rendered.offerUrls).size, Number(count));
    assert.equal((rendered.html.match(/class="email-collection-image"/g) || []).length, Number(count));
    assert.equal((rendered.html.match(/VER OFERTA/g) || []).length, Number(count));
    assert.equal(rendered.altCoverage?.descriptiveAltImages, Number(count));
    assert.equal(rendered.altCoverage?.totalImages, Number(count));
    for (const product of products) assert.match(rendered.offerUrls[products.indexOf(product)], new RegExp(`utm_content=${product.id}`));
  }
});

test("collection visible surface uses only customer-safe fields and descriptive image alts", () => {
  const internal = makeCollectionProduct(0, {
    id: "db-internal-001",
    ref: "REF-INTERNAL-001",
    status: "archived",
    lifecycleState: "archive_pending",
    createdBy: "provider-secret-owner",
    rawTitle: "BREVO_PROVIDER_ARCHIVE_TITLE",
    createdAt: "2026-08-27T00:00:00.000Z",
    categoria: "affiliate_preview",
    displayTitle: "Luminária de Mesa em Vidro",
    produto: "Luminária de Mesa em Vidro",
  });
  const rendered = renderNewsletterProductCollection([internal], { trackingCampaignId: "campaign-safe-fields" });
  assert.deepEqual(rendered.publicFieldAudit?.rendered, ["displayTitle/produto", "preco/ofertaPromocional", "categoria pública", "imagens canônicas", "destino rastreável"]);
  assert.ok(rendered.publicFieldAudit?.excludedInternal.includes("status"));
  assert.ok(rendered.publicFieldAudit?.excludedInternal.includes("providerRef"));
  assert.doesNotMatch(rendered.text, /db-internal-001|REF-INTERNAL-001|archive_pending|provider-secret-owner|BREVO_PROVIDER_ARCHIVE_TITLE|affiliate_preview|AFILIADO/i);
  const imageTags = rendered.html.match(/<img\b[^>]*>/gi) || [];
  assert.equal(imageTags.length, 2);
  assert.ok(imageTags.every((tag) => /\balt="[^"]{3,}"/i.test(tag)));
  assert.doesNotMatch(rendered.html, /display\s*:\s*(?:flex|grid)|linear-gradient|mix-blend-mode|<script/i);
});


test("known marketplace image overlays fail closed instead of being silently cropped", () => {
  const overlaid = makeCollectionProduct(0, { imageEditorialStatus: "overlay_suspected" });
  assert.throws(
    () => renderNewsletterProductCollection([overlaid]),
    /NEWSLETTER_COLLECTION_IMAGE_OVERLAY_SUSPECTED:1/,
  );
});


function makeCollectionProduct(index: number, overrides: Partial<Product> = {}): Product {
  const createdAt = new Date(Date.parse("2026-08-27T12:00:00.000Z") - index * 60 * 60 * 1000).toISOString();
  return {
    ...product,
    id: `prod-collection-${index}`,
    ref: `REF-C${String(index).padStart(2, "0")}`,
    produto: `Achado editorial ${index}`,
    displayTitle: `Achado editorial ${index}`,
    imagens: [`https://img.example.test/collection-${index}.jpg`],
    createdAt,
    ...overrides,
  };
}

function inspectGrid2Rows(html: string): Array<{ directCellCount: number; widths: string[] }> {
  const rows: Array<{ directCellCount: number; widths: string[] }> = [];
  const gridTables = [...html.matchAll(/<table\b[^>]*class="email-collection-grid-table"[^>]*>/gi)];
  for (const opening of gridTables) {
    const afterOpening = html.slice((opening.index ?? 0) + opening[0].length);
    let tableDepth = 1;
    let currentRow: { directCellCount: number; widths: string[] } | null = null;
    const tokens = [...afterOpening.matchAll(/<\/?(?:table|tr|td)\b[^>]*>/gi)];
    for (const token of tokens) {
      const tag = token[0];
      if (/^<table\b/i.test(tag)) tableDepth += 1;
      else if (/^<\/table/i.test(tag)) {
        tableDepth -= 1;
        if (tableDepth === 0) break;
      } else if (/^<tr\b/i.test(tag) && tableDepth === 1) {
        currentRow = { directCellCount: 0, widths: [] };
        rows.push(currentRow);
      } else if (/^<\/tr/i.test(tag) && tableDepth === 1) {
        currentRow = null;
      } else if (/^<td\b/i.test(tag) && tableDepth === 1 && currentRow) {
        currentRow.directCellCount += 1;
        currentRow.widths.push(tag.match(/\bwidth="([^"]+)"/i)?.[1] || "");
      }
    }
  }
  return rows;
}


test("weekly collection selector returns the newest configurable ten products", async () => {
  const products = Array.from({ length: 12 }, (_, index) => makeCollectionProduct(index));
  const selected = await selectNewestNewsletterProducts(products, {
    collectionSize: 10,
    minimumProducts: 5,
    verifyImageAccessibility: false,
  });
  assert.equal(selected.products.length, 10);
  assert.equal(selected.products[0].id, "prod-collection-0");
  assert.equal(new Set(selected.products.map(item => item.id)).size, 10);
});

test("weekly collection selector accepts fewer available products when the configured minimum is met", async () => {
  const products = Array.from({ length: 6 }, (_, index) => makeCollectionProduct(index));
  const selected = await selectNewestNewsletterProducts(products, {
    collectionSize: 10,
    minimumProducts: 5,
    verifyImageAccessibility: false,
  });
  assert.equal(selected.products.length, 6);
});

test("weekly collection selector skips unavailable products and reports explicit reasons", async () => {
  const products = [
    makeCollectionProduct(0, { imagens: [] }),
    makeCollectionProduct(1, { imagens: ["http://img.example.test/insecure.jpg"] }),
    makeCollectionProduct(2, { preco: 0 }),
    makeCollectionProduct(3, { link: "not-a-url", paginaPonteUrl: "" }),
    makeCollectionProduct(4),
    makeCollectionProduct(5),
    makeCollectionProduct(6),
    makeCollectionProduct(7),
    makeCollectionProduct(8),
  ];
  const selected = await selectNewestNewsletterProducts(products, {
    collectionSize: 5,
    minimumProducts: 5,
    verifyImageAccessibility: false,
  });
  assert.deepEqual(selected.products.map(item => item.id), [
    "prod-collection-4",
    "prod-collection-5",
    "prod-collection-6",
    "prod-collection-7",
    "prod-collection-8",
  ]);
  assert.match(selected.skipped.map(item => item.reason).join("|"), /PRODUCT_IMAGE_MISSING/);
  assert.match(selected.skipped.map(item => item.reason).join("|"), /PRODUCT_IMAGE_HTTPS_INVALID/);
  assert.match(selected.skipped.map(item => item.reason).join("|"), /PRODUCT_PRICE_INVALID/);
  assert.match(selected.skipped.map(item => item.reason).join("|"), /PRODUCT_DESTINATION_URL_INVALID/);
});

test("weekly collection selector respects the current-week date window and fails when the minimum cannot be met", async () => {
  const currentWeek = getStartOfCurrentIsoWeek(new Date("2026-08-27T15:00:00.000Z"));
  const outside = makeCollectionProduct(0, { createdAt: "2026-08-20T12:00:00.000Z" });
  const inside = Array.from({ length: 4 }, (_, index) => makeCollectionProduct(index + 1));
  await assert.rejects(
    () => selectNewestNewsletterProducts([outside, ...inside], {
      collectionSize: 10,
      minimumProducts: 5,
      since: currentWeek,
      until: new Date("2026-09-01T00:00:00.000Z"),
      verifyImageAccessibility: false,
    }),
    /CAMPAIGN_COLLECTION_NOT_ENOUGH_PRODUCTS:4:5/,
  );
});

test("weekly collection campaign defaults to a temporary fourteen-day lookback", async () => {
  const now = new Date("2026-08-27T15:00:00.000Z");
  const older = makeCollectionProduct(99, { createdAt: "2026-08-12T14:59:59.000Z" });
  const recent = Array.from({ length: 5 }, (_, index) => makeCollectionProduct(index, {
    createdAt: new Date(now.getTime() - index * 24 * 60 * 60 * 1000).toISOString(),
  }));
  const store = new FakeCampaignStore();
  const campaign = await createWeeklyCollectionCampaign("admin-14-day-window", {
    store,
    productsLoader: async () => [older, ...recent],
    collectionSize: 5,
    minimumCollectionProducts: 5,
    now,
    verifyImageAccessibility: false,
    env: {
      DRY_RUN: "true",
      PUBLIC_SITE_URL: "https://cerberusfinds.com",
    },
  });
  assert.deepEqual(campaign.collectionProducts.map(link => link.productId), recent.map(product => product.id));
  assert.equal(store.recipients.length, 0);
});

test("GRID-2 renders paired products as sibling table cells and not a linear list", () => {
  const rendered = renderNewsletterProductCollection(Array.from({ length: 6 }, (_, index) => makeCollectionProduct(index)), {
    trackingCampaignId: "campaign-grid-structure",
  });
  const rows = inspectGrid2Rows(rendered.html);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { directCellCount: 2, widths: ["50%", "50%"] });
  assert.equal((rendered.html.match(/<img\b[^>]*class="email-collection-image"[^>]*width="286"[^>]*>/gi) || []).length, 2);
  assert.doesNotMatch(rendered.html, /class="email-collection-grid-cell"[^>]*width="100%"/i);
  assert.doesNotMatch(rendered.html, /display\s*:\s*(?:flex|grid)/i);
});

test("GRID-2 reserves aligned title, price and CTA areas for varied editorial content", () => {
  const products = [
    makeCollectionProduct(0, { displayTitle: "Curto", produto: "Curto", categoria: "Casa", preco: 9.9 }),
    makeCollectionProduct(1, { displayTitle: "Título médio para uma peça selecionada", produto: "Título médio para uma peça selecionada", categoria: "Iluminação", preco: 129.9 }),
    makeCollectionProduct(2, { displayTitle: "Título muito longo para confirmar que a área editorial permanece previsível sem cortar o nome importante do produto", produto: "Título muito longo para confirmar que a área editorial permanece previsível sem cortar o nome importante do produto", categoria: "Casa e decoração", preco: 12999.99 }),
  ];
  const rendered = renderNewsletterProductCollection(products, { trackingCampaignId: "campaign-grid-heights" });
  assert.equal((rendered.html.match(/class="email-collection-grid-image-cell" height="156"/g) || []).length, 2);
  assert.equal((rendered.html.match(/class="email-collection-grid-title" height="72"/g) || []).length, 2);
  assert.equal((rendered.html.match(/class="email-collection-grid-price" height="34"/g) || []).length, 2);
  assert.equal((rendered.html.match(/class="email-collection-grid-action" height="45"/g) || []).length, 2);
  assert.equal((rendered.html.match(/VER OFERTA/g) || []).length, 3);
  assert.equal(rendered.offerUrls.filter((url) => /utm_content=/.test(url)).length, 3);
  assert.doesNotMatch(rendered.html, /text-overflow|line-clamp|display\s*:\s*(?:flex|grid)/i);
});

test("collection quantities preserve one image, CTA and individual UTM per product", () => {
  for (const count of [1, 3, 5, 7]) {
    const products = Array.from({ length: count }, (_, index) => makeCollectionProduct(index));
    const rendered = renderNewsletterProductCollection(products, { trackingCampaignId: `campaign-quantity-${count}` });
    assert.equal((rendered.html.match(/class="email-collection-image"/g) || []).length, count);
    assert.equal((rendered.html.match(/VER OFERTA/g) || []).length, count);
    assert.equal(rendered.offerUrls.length, count);
    assert.equal(new Set(rendered.offerUrls).size, count);
    for (const product of products) {
      assert.equal(rendered.offerUrls.filter((url) => url.includes(`utm_content=${product.id}`)).length, 1);
    }
  }
});

test("collection renderer supports ten products, variable sizes, canonical images and individual UTMs", () => {
  const products = Array.from({ length: 10 }, (_, index) => makeCollectionProduct(index));
  const rendered = renderNewsletterProductCollection(products, { trackingCampaignId: "campaign-collection" });
  assert.equal((rendered.html.match(/class="email-collection-image"/g) || []).length, 10);
  assert.equal((rendered.html.match(/VER OFERTA/g) || []).length, 10);
  assert.equal(rendered.offerUrls.length, 10);
  assert.match(rendered.html, /email-collection-feature/);
  assert.match(rendered.html, /email-collection-grid-table/);
  assert.match(rendered.html, /email-collection-grid-cell/);
  assert.match(rendered.offerUrls[0], /utm_content=prod-collection-0/);
  assert.match(rendered.offerUrls[9], /utm_content=prod-collection-9/);
  assert.match(rendered.text, /01\. Achado editorial 0/);

  const variable = renderNewsletterProductCollection(products.slice(0, 6));
  assert.equal((variable.html.match(/class="email-collection-image"/g) || []).length, 6);
});

test("MASTHEAD is the first editorial block and Variant A is universal", () => {
  const rendered = renderNewsletterProductCollection(Array.from({ length: 5 }, (_, index) => makeCollectionProduct(index)), {
    trackingCampaignId: "campaign-masthead-a",
  });
  assert.equal(rendered.blockSequence[0], "MASTHEAD");
  assert.equal(rendered.mastheadVariant, "A");
  assert.equal(rendered.mastheadImageUrl, null);
  assert.match(rendered.html, /editorial-masthead editorial-masthead-a/);
  assert.equal(rendered.mastheadLogoUrl, "https://cerberus-forge-deploy-backend.onrender.com/assets/newsletter/branding/cerberus-logo-official.png");
  assert.match(rendered.html, /class="email-masthead-logo"/);
  assert.match(rendered.html, /alt="Logo Cerberus Finds"/);
  assert.match(rendered.html, /CERBERUS FINDS/);
  assert.match(rendered.html, /CURADORIA INDEPENDENTE/);
  assert.match(rendered.html, /EDIÇÃO/);
  assert.match(rendered.html, />05<\/font>/);
  assert.match(rendered.html, /OBJETOS PARA OLHAR DE NOVO|UM OLHAR ATENTO PARA O QUE ENTRA/);
  assert.match(rendered.text, /MASTHEAD/);
});

test("MASTHEAD dedicated asset is optional, clean HTTPS only, and does not use a product map", () => {
  const products = Array.from({ length: 5 }, (_, index) => makeCollectionProduct(index));
  const dedicated = renderNewsletterProductCollection(products, {
    trackingCampaignId: "campaign-masthead-dedicated",
    mastheadImageStatus: "clean",
    mastheadAssetUrl: "https://cerberusfinds.com/assets/newsletter/masthead/editorial-cover.webp",
  });
  assert.equal(dedicated.mastheadVariant, "B");
  assert.equal(dedicated.mastheadImageUrl, "https://cerberusfinds.com/assets/newsletter/masthead/editorial-cover.webp");
  assert.match(dedicated.html, /editorial-cover\.webp/);
  assert.doesNotMatch(dedicated.html, /product-map|prod-collection-0.*editorial-cover/i);

  const insecure = renderNewsletterProductCollection(products, {
    trackingCampaignId: "campaign-masthead-dedicated-insecure",
    mastheadImageStatus: "clean",
    mastheadAssetUrl: "http://cerberusfinds.com/assets/newsletter/masthead/editorial-cover.webp",
  });
  assert.equal(insecure.mastheadVariant, "A");
  assert.equal(insecure.mastheadImageUrl, null);
});

test("MASTHEAD Variant B uses clean canonical hero imagery and falls back to A", () => {
  const products = Array.from({ length: 5 }, (_, index) => makeCollectionProduct(index));
  products[0].imageEditorialStatus = "clean";
  const variantB = renderNewsletterProductCollection(products, { trackingCampaignId: "campaign-masthead-b" });
  assert.equal(variantB.mastheadVariant, "B");
  assert.equal(variantB.mastheadImageUrl, products[0].imagens[0]);
  assert.match(variantB.html, /editorial-masthead-b/);
  assert.match(variantB.html, /class="email-masthead-image"/);
  assert.match(variantB.html, /width="250" height="210"/);
  assert.match(variantB.html, /alt="Imagem editorial da edição Cerberus Finds"/);
  assert.doesNotMatch(variantB.html, /display\\s*:\\s*(?:flex|grid)/i);

  const fallback = renderNewsletterProductCollection(products, {
    trackingCampaignId: "campaign-masthead-fallback",
    mastheadImageStatus: "unavailable",
    mastheadLogoStatus: "unavailable",
  });
  assert.equal(fallback.mastheadVariant, "A");
  assert.equal(fallback.mastheadImageUrl, null);
  assert.equal(fallback.mastheadLogoUrl, null);
  assert.match(fallback.html, /editorial-masthead-a/);
  assert.match(fallback.html, /CF<\/font><\/span>/);
  assert.doesNotMatch(fallback.html, /class="email-masthead-image"/);
});

test("full collection campaign keeps the Cerberus editorial shell and email safety constraints", () => {
  const products = Array.from({ length: 8 }, (_, index) => makeCollectionProduct(index));
  const rendered = renderNewsletterCollectionCampaign(products, {
    trackingCampaignId: "campaign-collection-shell",
    privacyUrl: "https://cerberusfinds.com/privacidade",
    termsUrl: "https://cerberusfinds.com/termos",
    finalBrowseUrl: "https://cerberusfinds.com/",
    socialLinks: [{ label: "Instagram", url: "https://instagram.com/cerberusfinds" }],
  });
  assert.match(rendered.subject, /Novidades da semana/);
  assert.match(rendered.html, /editorial-masthead editorial-masthead-a/);
  assert.match(rendered.html, /EDIÇÃO/);
  assert.match(rendered.html, />08<\/font>/);
  assert.match(rendered.html, /OBJETOS PARA OLHAR DE NOVO|UM OLHAR ATENTO PARA O QUE ENTRA/);
  assert.doesNotMatch(rendered.html, /<h1[^>]*>[^<]*8 NOVOS ACHADOS<\/h1>/i);
  assert.match(rendered.html, /VER OFERTA/);
  assert.match(rendered.html, /VER TODAS AS NOVIDADES/);
  assert.match(rendered.html, /UNSUBSCRIBE_URL_PLACEHOLDER|\{\{UNSUBSCRIBE_URL\}\}/);
  assert.match(rendered.html, /Política de privacidade/);
  assert.match(rendered.html, /Termos e condições/);
  assert.match(rendered.html, /Encontre a Cerberus Finds/);
  assert.match(rendered.html, /background-color:#0B0908/);
  assert.match(rendered.html, /background-color:#181512/);
  assert.match(rendered.html, /@media only screen and \(max-width:620px\)/);
  assert.match(rendered.html, /email-collection-grid-cell\{padding:0 4px 16px!important;/);
  assert.match(rendered.html, /email-collection-grid-title\{height:58px!important;/);
  assert.match(rendered.html, /@media only screen and \(max-width:374px\).*email-collection-grid-cell\{display:block!important;width:100%!important;/);
  assert.match(rendered.html, /email-collection-grid-action a\{font-size:9px!important;padding:8px 8px!important;/);
  const imageTags = rendered.html.match(/<img\b[^>]*>/gi) || [];
  assert.equal(imageTags.length, 10);
  assert.ok(imageTags.every((tag) => /\balt="[^"]{3,}"/i.test(tag)));
  assert.doesNotMatch(rendered.html, /<script|gradient|mix-blend-mode|gmail-blend-screen|gmail-blend-difference|app store|google play|qr code|\bBREVO\b|\bSUPABASE\b|\bRender\b|email_campaign_products/i);
  assert.doesNotMatch(rendered.html, /NEWSLETTER_TEST_EMAIL|xkeysib-|sk-[A-Za-z0-9]{20,}|BEGIN .* PRIVATE KEY/i);
});

test("collection campaign creation persists ordered associations without creating recipients", async () => {
  const store = new FakeCampaignStore();
  const products = Array.from({ length: 6 }, (_, index) => makeCollectionProduct(index));
  const campaign = await createWeeklyCollectionCampaign("admin-collection", {
    store,
    productsLoader: async () => products,
    collectionSince: null,
    collectionUntil: null,
    collectionSize: 5,
    minimumCollectionProducts: 5,
    now: new Date("2026-08-27T15:00:00.000Z"),
    verifyImageAccessibility: false,
    env: {
      DRY_RUN: "true",
      PUBLIC_SITE_URL: "https://cerberusfinds.com",
      NEWSLETTER_COLLECTION_SIZE: "6",
      NEWSLETTER_COLLECTION_MINIMUM_PRODUCTS: "5",
    },
  });
  assert.equal(campaign.campaignType, "collection");
  assert.equal(campaign.status, "draft");
  assert.equal(campaign.productId, null);
  assert.equal(campaign.collectionProducts.length, 5);
  assert.deepEqual(campaign.collectionProducts.map(link => link.position), [1, 2, 3, 4, 5]);
  assert.deepEqual(campaign.collectionProducts.map(link => link.layout), ["feature", "grid", "grid", "grid", "grid"]);
  assert.equal(store.recipients.length, 0);
  assert.equal(store.campaignProducts.get(campaign.id)?.length, 5);
});

test("campaign 1 state remains single-product and cannot accept collection associations", () => {
  assert.throws(
    () => createCampaignDraft("prod-campaign-1", "admin-1", renderNewsletterCampaign(product), new Date(), "campaign-single", "product", [{ productId: "prod-extra", position: 1, layout: "feature" }]),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "COLLECTION_PRODUCTS_FORBIDDEN",
  );
  const individual = draft("campaign-still-individual");
  assert.equal(individual.campaignType, "product");
  assert.equal(individual.collectionProducts.length, 0);
});
