import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Product } from "../src/types.ts";
import {
  createCampaignDraft,
  transitionCampaign,
  type EmailCampaign,
} from "../server/services/newsletterCampaignState.ts";
import {
  renderNewsletterCampaign,
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
import type {
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
} from "../server/services/newsletterCampaignService.ts";
import {
  campaignCompletionKeyboard,
  campaignKeyboard,
  handleNewsletterCampaignCallback,
  handleWelcomeCampaignCommand,
  renderCampaignCompletionReport,
  renderRecentCampaignsForTelegram,
} from "../server/services/newsletterCampaignTelegram.ts";
import { TELEGRAM_PANEL_COMMANDS, renderReadPanelMenu } from "../server/services/telegramPanel.ts";

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
  recipients: EmailCampaignRecipient[] = [];
  subscribers = new Map<string, { status: "subscribed" | "unsubscribed" | "suppressed"; marketing_consent: boolean }>();
  providerToken = "opaque-token-for-test-only";
  prepareCalls = 0;

  async createCampaign(campaign: EmailCampaign): Promise<EmailCampaign> { this.campaigns.set(campaign.id, structuredClone(campaign)); return structuredClone(campaign); }
  async getCampaign(campaignId: string): Promise<EmailCampaign | null> { const value = this.campaigns.get(campaignId); return value ? structuredClone(value) : null; }
  async updateCampaign(campaign: EmailCampaign): Promise<EmailCampaign> { this.campaigns.set(campaign.id, structuredClone(campaign)); return structuredClone(campaign); }
  async listRecentCampaigns(limit: number): Promise<EmailCampaign[]> { return [...this.campaigns.values()].slice(-Math.max(1, limit)).reverse().map(row => structuredClone(row)); }
  async createEligibleRecipients(campaignId: string): Promise<number> {
    const eligible = [...this.subscribers.entries()].filter(([, value]) => value.status === "subscribed" && value.marketing_consent).map(([email]) => email);
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
  assert.equal(TELEGRAM_PANEL_COMMANDS.some(command => command.command === "discover-batch"), false);
  assert.equal(TELEGRAM_PANEL_COMMANDS.every(command => /^[a-z0-9_]+$/.test(command.command)), true);
  assert.match(renderReadPanelMenu(), /\/campanhas/);
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

test("test_sent keyboard shows confirmation before confirmation and start only after both confirmation fields exist", () => {
  const unconfirmed = { ...draft("campaign-keyboard-unconfirmed"), status: "test_sent" as const };
  assert.equal(campaignKeyboard(unconfirmed)[0][0].text, "✅ Confirmar envio geral");
  assert.equal(campaignKeyboard(unconfirmed)[0][0].callback_data, `campaign_confirm_general:${unconfirmed.id}`);

  const confirmed = {
    ...unconfirmed,
    generalSendConfirmedAt: "2026-08-26T05:55:00.000Z",
    generalSendConfirmedByTelegramId: "admin-1",
  };
  assert.equal(campaignKeyboard(confirmed)[0][0].text, "🚀 Iniciar envio geral");
  assert.equal(campaignKeyboard(confirmed)[0][0].callback_data, `campaign_start:${confirmed.id}`);
  assert.equal(unconfirmed.status, "test_sent");
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
  assert.match(rendered.html, /bgcolor="#0a0a0a"/);
  assert.match(rendered.html, /bgcolor="#141414"/);
  assert.match(rendered.html, /bgcolor="#c0392b"/);
  assert.match(rendered.html, /font-family:Georgia,'Times New Roman',serif/);
  assert.match(rendered.html, /<meta name="color-scheme" content="dark">/);
  assert.match(rendered.html, /<meta name="supported-color-schemes" content="dark">/);
  assert.doesNotMatch(rendered.html, /gmail-blend-screen|gmail-blend-difference|mix-blend-mode/);
  assert.match(rendered.html, /-webkit-text-fill-color:#ffffff/);
  assert.match(rendered.html, /data-ogsc="color: #ffffff;"/);
  assert.match(rendered.html, /color="#ffffff"/);
  assert.ok((rendered.html.match(/data-ogsc="color: #ffffff;"/g) ?? []).length >= 8);
  assert.match(rendered.html, /filter:none!important/);
  assert.equal(rendered.html.includes("background-image:linear-gradient(#0a0a0a,#0a0a0a)"), true);
  assert.match(rendered.html, /class="email-card"[^>]+style="[^"]*border:0/);
  assert.match(rendered.html, /class="email-price-card" bgcolor="#141414"[^>]+border:0/);
  assert.match(rendered.html, /\*,table,td,div\{border:0!important;outline:0!important;box-shadow:none!important;\}/);
  assert.doesNotMatch(rendered.html, /#b0b0b0|#888888/);
  assert.doesNotMatch(rendered.html, /border-(left|right):/);
  assert.doesNotMatch(rendered.html, /<td align="right"/);
  assert.match(rendered.html, /CERBERUS FINDS/);
  assert.match(rendered.html, /Seleção editorial/);
  assert.match(rendered.html, /<img src="https:\/\/cerberusfinds\.com\/assets\/newsletter\/social\/instagram\.png" width="24" height="24" alt="Instagram"/);
  assert.match(rendered.html, /luminaria-bauhaus-clean\.png/);
  assert.doesNotMatch(rendered.html, /socialMonogram|border-style:dashed|\bIG\b/);
  assert.doesNotMatch(rendered.html, /#0b0908|#181512|#8a1f1f|#e8e1d3|#211c18/);
  assert.doesNotMatch(rendered.html, /class="email-card"[^>]+border:1px solid #2b2b2b/);
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
  assert.match(rendered.html, /Por que selecionamos isso/);
  assert.match(rendered.html, /Ver no navegador/);
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
  });
  assert.match(created.bodyHtml, /https:\/\/cerberusfinds\.com\/politica-de-privacidade/);
  assert.match(created.bodyHtml, /https:\/\/cerberusfinds\.com\/termos-e-condicoes/);
  assert.match(created.bodyHtml, /Instagram ainda não configurado/);
  assert.match(created.bodyHtml, /assets\/newsletter\/social\/instagram\.png/);
  assert.doesNotMatch(created.bodyHtml, /<img[^>]+src="https:\/\/cdn\.example\.test\/kitchen\.jpg"/);
  assert.match(created.bodyHtml, /TikTok ainda não configurado/);
  assert.match(created.bodyHtml, /Facebook ainda não configurado/);
  assert.equal(created.bodyHtml.includes("example.com"), false);
});

test("institutional assets resolve to the configured public base and only known clean hero is allowed", () => {
  assert.equal(
    getNewsletterHeroImageUrl("prod-1787414659793", { PUBLIC_SITE_URL: "https://cerberusfinds.com" }),
    `${DEFAULT_NEWSLETTER_ASSET_BASE_URL}/assets/newsletter/products/luminaria-bauhaus-clean-email.jpg`,
  );
  assert.equal(
    getNewsletterHeroImageUrl("prod-1787414659793", {
      PUBLIC_SITE_URL: "https://cerberusfinds.com",
      NEWSLETTER_PUBLIC_ASSET_BASE_URL: "https://assets.example.test/newsletter",
    }),
    "https://assets.example.test/newsletter/assets/newsletter/products/luminaria-bauhaus-clean-email.jpg",
  );
  assert.equal(resolveNewsletterAssetBaseUrl({ NEWSLETTER_PUBLIC_ASSET_BASE_URL: "not-a-url" }), DEFAULT_NEWSLETTER_ASSET_BASE_URL);
  assert.equal(getNewsletterHeroImageUrl("prod-campaign-1", { PUBLIC_SITE_URL: "https://cerberusfinds.com" }), undefined);
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
  assert.match(rendered.html, /background-image:linear-gradient\(#0a0a0a,#0a0a0a\)/);
  assert.doesNotMatch(rendered.html, /#b0b0b0|#888888/);
  assert.doesNotMatch(rendered.html, /border-(left|right):/);
  assert.doesNotMatch(rendered.html, /<td align="right"/);
  assert.match(rendered.html, /Curadoria independente/);
  assert.match(rendered.html, /data-ogsc="color: #ffffff;"/);
  assert.match(rendered.html, /color="#ffffff"/);
  assert.match(rendered.html, /bgcolor="#0a0a0a"/);
  assert.match(rendered.html, /assets\/newsletter\/social\/instagram\.png/);
  assert.doesNotMatch(rendered.html, /socialMonogram|border-style:dashed/);
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
  assert.equal(rendered.html.includes("Ver no navegador"), false);
  assert.equal(rendered.html.includes("Política de privacidade"), false);
  assert.equal(rendered.html.includes("Termos e condições"), false);
  assert.equal(rendered.html.includes("Encontre a Cerberus Finds"), false);
  assert.equal(rendered.html.includes("Por que selecionamos isso"), false);
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
  const sending = await startGeneralSend(confirmed, "admin-1", { store });
  assert.equal(sending.status, "sending");
  assert.equal(sending.counts.total, 1);
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

test("administrative real-mode test does not require subscriber membership", async () => {
  const store = new FakeCampaignStore();
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

test("Telegram confirmation callback re-renders the confirmed start button without creating recipients", async () => {
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
  assert.equal(markups[0]["inline_keyboard"][0][0].text, "🚀 Iniciar envio geral");
  assert.equal(markups[0]["inline_keyboard"][0][0].callback_data, `campaign_start:${campaign.id}`);
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
