from pathlib import Path


def write(path: str, content: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"materializer anchor missing: {path}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


write("server/services/newsletterWeeklyCopy.ts", r'''import { GoogleGenAI } from "@google/genai";
import type { Product } from "../../src/types";
import { ExternalCallBudget } from "./operationalGuards";

export type WeeklyNewsletterCopy = {
  subject: string;
  previewText: string;
  heroHeadline: string;
  heroBody: string;
  secondaryCaptions: Record<string, string>;
};

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "",
  httpOptions: { headers: { "User-Agent": "aistudio-build" } },
});

const geminiBudget = new ExternalCallBudget(
  { gemini: Number.parseInt(process.env.GEMINI_HOURLY_BUDGET || "20", 10) },
  60 * 60 * 1000,
);

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function safeEditorialProduct(product: Product) {
  return {
    id: product.id,
    title: clean(product.displayTitle || product.produto, 120),
    category: clean(product.categoria, 80),
    description: clean(product.curatorNote || product.descricao, 500),
  };
}

export function buildWeeklyCopyPrompt(products: readonly Product[]): string {
  const safeProducts = products.map(safeEditorialProduct);
  return `Você é o curador editorial do Cerberus Finds. Use o MESMO tom direto, factual e curatorial já usado nas descrições do catálogo: sem hype, sem urgência artificial e sem inventar atributos.\n\nGere SOMENTE copy editorial para uma newsletter semanal. Você NÃO recebe preço, estoque, disponibilidade, frete ou links e está proibido de inventar qualquer um desses fatos. Não mencione preço, desconto, estoque, disponibilidade ou prazo.\n\nProdutos editoriais já validados:\n${JSON.stringify(safeProducts)}\n\nRetorne JSON estrito no formato:\n{\n  "subject":"até 90 caracteres",\n  "previewText":"até 140 caracteres",\n  "heroHeadline":"até 70 caracteres",\n  "heroBody":"1 ou 2 frases, até 220 caracteres",\n  "secondaryCaptions":{"PRODUCT_ID":"uma frase factual de até 120 caracteres"}\n}\n\nO primeiro produto é o destaque. Gere secondaryCaptions para todos os demais IDs, sem criar IDs novos.`;
}

function assertNoInventedCommercialFacts(value: string): void {
  if (/R\$\s*\d|\b(preço|estoque|em estoque|disponível agora|frete|desconto|cupom|por apenas)\b/i.test(value)) {
    throw new Error("WEEKLY_COPY_COMMERCIAL_FACT_FORBIDDEN");
  }
}

export function sanitizeWeeklyNewsletterCopy(value: unknown, products: readonly Product[]): WeeklyNewsletterCopy {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const subject = clean(raw.subject, 90);
  const previewText = clean(raw.previewText, 140);
  const heroHeadline = clean(raw.heroHeadline, 70);
  const heroBody = clean(raw.heroBody, 220);
  if (!subject || !previewText || !heroHeadline || !heroBody) throw new Error("WEEKLY_COPY_INCOMPLETE");

  const sourceCaptions = raw.secondaryCaptions && typeof raw.secondaryCaptions === "object"
    ? raw.secondaryCaptions as Record<string, unknown>
    : {};
  const secondaryCaptions: Record<string, string> = {};
  for (const product of products.slice(1)) {
    const caption = clean(sourceCaptions[product.id], 120);
    if (!caption) throw new Error(`WEEKLY_COPY_CAPTION_MISSING:${product.id}`);
    secondaryCaptions[product.id] = caption;
  }

  assertNoInventedCommercialFacts([subject, previewText, heroHeadline, heroBody, ...Object.values(secondaryCaptions)].join(" "));
  return { subject, previewText, heroHeadline, heroBody, secondaryCaptions };
}

export async function generateWeeklyNewsletterCopy(products: readonly Product[]): Promise<WeeklyNewsletterCopy> {
  if (products.length < 3 || products.length > 4) throw new Error("WEEKLY_COPY_PRODUCT_COUNT_INVALID");
  if (!process.env.GEMINI_API_KEY?.trim()) throw new Error("WEEKLY_COPY_GEMINI_NOT_CONFIGURED");
  const reservation = geminiBudget.reserve("gemini");
  if (!reservation.allowed) throw new Error("WEEKLY_COPY_GEMINI_BUDGET_EXCEEDED");

  const response = await ai.models.generateContent({
    model: process.env.GEMINI_PRODUCT_CURATOR_MODEL || "gemini-3.6-flash",
    contents: buildWeeklyCopyPrompt(products),
    config: { responseMimeType: "application/json" },
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text || "{}");
  } catch {
    throw new Error("WEEKLY_COPY_INVALID_JSON");
  }
  return sanitizeWeeklyNewsletterCopy(parsed, products);
}
''')

write("server/services/newsletterWeeklyTemplate.ts", r'''import type { Product } from "../../src/types";
import { resolveCanonicalProductImage } from "../../src/lib/productCanonical";
import { getProductDisplayCategory } from "../../src/lib/productPresentation";
import { buildNewsletterAssetUrl } from "./newsletterInstitutional";
import type { NewsletterSocialLink, RenderedNewsletterCampaign } from "./newsletterCampaignTemplate";
import type { WeeklyNewsletterCopy } from "./newsletterWeeklyCopy";

export const BREVO_NATIVE_UNSUBSCRIBE = "{{ unsubscribe }}";
const BG = "#0a0a0a";
const ACCENT = "#c0392b";
const TEXT = "#f3eee8";
const MUTED = "#bdb5ad";
const BORDER = "#302a26";

function esc(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

function price(product: Product): number {
  const offer = product.ofertaPromocional;
  if (offer?.source === "admin_confirmed" && Number.isFinite(offer.price) && offer.price > 0) return offer.price;
  return Number(product.preco);
}

function priceLabel(product: Product): string {
  const value = price(product);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`WEEKLY_CANONICAL_PRICE_MISSING:${product.id}`);
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

export function buildWeeklyGoUrl(publicBaseUrl: string, product: Product, campaignId: string, position: number): string {
  const ref = product.ref?.trim();
  if (!ref) throw new Error(`WEEKLY_PRODUCT_REF_MISSING:${product.id}`);
  let url: URL;
  try { url = new URL(`/go/${encodeURIComponent(ref)}`, publicBaseUrl); }
  catch { throw new Error("WEEKLY_PUBLIC_BASE_URL_INVALID"); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("WEEKLY_PUBLIC_BASE_URL_INVALID");
  url.searchParams.set("campaign_id", campaignId);
  url.searchParams.set("position", String(position));
  url.searchParams.set("utm_source", "email");
  url.searchParams.set("utm_medium", "newsletter");
  return url.toString();
}

function imageUrl(product: Product): string {
  const image = resolveCanonicalProductImage(product);
  if (image.status !== "ready" || !image.primaryImageUrl) throw new Error(`WEEKLY_PRODUCT_IMAGE_MISSING:${product.id}`);
  return image.primaryImageUrl;
}

function cta(url: string, label = "VER OFERTA"): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${ACCENT}" style="background:${ACCENT};background-color:${ACCENT};"><a href="${esc(url)}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 22px;color:#ffffff;font:700 12px/1.2 Arial,Helvetica,sans-serif;letter-spacing:1.5px;text-decoration:none;">${label}</a></td></tr></table>`;
}

function secondaryCard(product: Product, caption: string, url: string): string {
  const title = product.displayTitle || product.produto;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BG}" style="width:100%;border-collapse:collapse;background:${BG};background-color:${BG};"><tr><td bgcolor="${BG}" style="padding:0 0 14px;background:${BG};background-color:${BG};"><img src="${esc(imageUrl(product))}" alt="${esc(title)}" width="270" style="display:block;width:100%;max-width:270px;height:auto;border:0;" /></td></tr><tr><td bgcolor="${BG}" style="background:${BG};background-color:${BG};"><p style="margin:0 0 7px;color:${ACCENT};font:700 10px/1.4 Arial,Helvetica,sans-serif;letter-spacing:1.6px;text-transform:uppercase;">${esc(getProductDisplayCategory(product))}</p><h3 style="margin:0 0 8px;color:${TEXT};font:700 20px/1.15 Georgia,'Times New Roman',serif;">${esc(title)}</h3><p style="margin:0 0 8px;color:${MUTED};font:400 13px/1.55 Arial,Helvetica,sans-serif;">${esc(caption)}</p><p style="margin:0 0 14px;color:${TEXT};font:700 17px/1.2 Georgia,'Times New Roman',serif;">${esc(priceLabel(product))}</p>${cta(url, "VER OFERTA")}</td></tr></table>`;
}

function socialFooter(links: readonly NewsletterSocialLink[]): string {
  if (!links.length) return "";
  return `<p style="margin:0 0 14px;color:${MUTED};font:700 10px/1.4 Arial,Helvetica,sans-serif;letter-spacing:1.5px;text-transform:uppercase;">Encontre a Cerberus Finds</p><p style="margin:0 0 18px;">${links.map(link => `<a href="${esc(link.url)}" style="color:${TEXT};font:400 12px/1.5 Arial,Helvetica,sans-serif;text-decoration:underline;margin-right:12px;">${esc(link.label)}</a>`).join(" ")}</p>`;
}

export function renderWeeklyNewsletter(
  products: readonly Product[],
  copy: WeeklyNewsletterCopy,
  options: { campaignId: string; publicBaseUrl: string; socialLinks?: readonly NewsletterSocialLink[] },
): RenderedNewsletterCampaign & { preheader: string; offerUrls: string[] } {
  if (products.length < 3 || products.length > 4) throw new Error("WEEKLY_TEMPLATE_PRODUCT_COUNT_INVALID");
  const [hero, ...secondary] = products;
  const urls = products.map((product, index) => buildWeeklyGoUrl(options.publicBaseUrl, product, options.campaignId, index + 1));
  const heroTitle = hero.displayTitle || hero.produto;
  const logo = buildNewsletterAssetUrl("assets/newsletter/branding/cerberus-logo-square.png");

  const secondaryRows: string[] = [];
  for (let i = 0; i < secondary.length; i += 2) {
    const cells = secondary.slice(i, i + 2).map((product, localIndex) => {
      const absoluteIndex = i + localIndex + 1;
      return `<td width="50%" valign="top" bgcolor="${BG}" style="width:50%;padding:${localIndex === 0 ? "0 10px 28px 0" : "0 0 28px 10px"};background:${BG};background-color:${BG};">${secondaryCard(product, copy.secondaryCaptions[product.id], urls[absoluteIndex])}</td>`;
    });
    if (cells.length === 1) cells.push(`<td width="50%" bgcolor="${BG}" style="width:50%;background:${BG};background-color:${BG};">&nbsp;</td>`);
    secondaryRows.push(`<tr>${cells.join("")}</tr>`);
  }

  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body bgcolor="${BG}" style="margin:0;padding:0;background:${BG};background-color:${BG};"><span style="display:none!important;max-height:0;overflow:hidden;opacity:0;">${esc(copy.previewText)}</span><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BG}" style="width:100%;border-collapse:collapse;background:${BG};background-color:${BG};"><tr><td align="center" bgcolor="${BG}" style="background:${BG};background-color:${BG};"><table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" bgcolor="${BG}" style="width:100%;max-width:640px;border-collapse:collapse;background:${BG};background-color:${BG};"><tr><td align="center" bgcolor="${BG}" style="padding:28px 30px;border-bottom:1px solid ${BORDER};background:${BG};background-color:${BG};"><img src="${esc(logo)}" width="92" height="92" alt="Cerberus Finds" style="display:block;width:92px;height:92px;border:0;margin:0 auto 12px;"/><p style="margin:0;color:${TEXT};font:700 14px/1.2 Arial,Helvetica,sans-serif;letter-spacing:2.7px;">CERBERUS FINDS</p><p style="margin:5px 0 0;color:${MUTED};font:700 9px/1.3 Arial,Helvetica,sans-serif;letter-spacing:2px;text-transform:uppercase;">CURADORIA INDEPENDENTE</p></td></tr><tr><td bgcolor="${BG}" style="padding:32px 30px 20px;background:${BG};background-color:${BG};"><img src="${esc(imageUrl(hero))}" alt="${esc(heroTitle)}" width="580" style="display:block;width:100%;max-width:580px;height:auto;border:0;margin:0 0 26px;"/><p style="margin:0 0 10px;color:${ACCENT};font:700 10px/1.4 Arial,Helvetica,sans-serif;letter-spacing:1.8px;text-transform:uppercase;">${esc(getProductDisplayCategory(hero))}</p><h1 style="margin:0 0 14px;color:${TEXT};font:700 36px/1.05 Georgia,'Times New Roman',serif;">${esc(copy.heroHeadline)}</h1><p style="margin:0 0 9px;color:${TEXT};font:700 18px/1.3 Georgia,'Times New Roman',serif;">${esc(heroTitle)}</p><p style="margin:0 0 16px;color:${MUTED};font:400 14px/1.65 Arial,Helvetica,sans-serif;">${esc(copy.heroBody)}</p><p style="margin:0 0 20px;color:${TEXT};font:700 28px/1.1 Georgia,'Times New Roman',serif;">${esc(priceLabel(hero))}</p>${cta(urls[0])}</td></tr><tr><td bgcolor="${BG}" style="padding:20px 30px 8px;border-top:1px solid ${BORDER};background:${BG};background-color:${BG};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BG}" style="width:100%;border-collapse:collapse;background:${BG};background-color:${BG};">${secondaryRows.join("")}</table></td></tr><tr><td bgcolor="${BG}" style="padding:26px 30px 32px;border-top:1px solid ${BORDER};background:${BG};background-color:${BG};">${socialFooter(options.socialLinks || [])}<p style="margin:0 0 12px;color:${MUTED};font:400 11px/1.6 Arial,Helvetica,sans-serif;">Este e-mail pode conter links de afiliado. Se você comprar por um link, a Cerberus Finds poderá receber uma comissão, sem custo adicional para você.</p><p style="margin:0;color:${MUTED};font:400 11px/1.6 Arial,Helvetica,sans-serif;">Você recebeu esta mensagem porque autorizou comunicações de marketing. <a href="${BREVO_NATIVE_UNSUBSCRIBE}" style="color:${TEXT};text-decoration:underline;">Cancelar inscrição</a>.</p></td></tr></table></td></tr></table></body></html>`;

  const text = [copy.heroHeadline, copy.heroBody, `${heroTitle} — ${priceLabel(hero)} — ${urls[0]}`, ...secondary.map((product, i) => `${product.displayTitle || product.produto} — ${priceLabel(product)} — ${urls[i + 1]}\n${copy.secondaryCaptions[product.id]}`), `Cancelar inscrição: ${BREVO_NATIVE_UNSUBSCRIBE}`].join("\n\n");
  return { subject: copy.subject, preheader: copy.previewText, html, text, offerUrl: urls[0], offerUrls: urls };
}
''')

write("server/services/newsletterWeeklyCampaign.ts", r'''import { createHash } from "node:crypto";
import type { Product } from "../../src/types";
import { deriveConfidenceV2, deriveMinSampleSize, confidenceV2ToScore } from "../commercialBrain/statisticalRigor";
import * as productsRepository from "../repositories/productsRepository";
import { createSupabaseNewsletterCampaignStore, type NewsletterCampaignStore } from "../repositories/newsletterCampaignRepository";
import { cancelCampaign, submitCampaignForApproval } from "./newsletterCampaignService";
import { createCampaignDraft, type CampaignProductLink, type EmailCampaign } from "./newsletterCampaignState";
import { getNewsletterInstitutionalOptions } from "./newsletterInstitutional";
import { sendTelegramMessage, type TelegramDeliveryResult } from "./telegramBot";
import { generateWeeklyNewsletterCopy, type WeeklyNewsletterCopy } from "./newsletterWeeklyCopy";
import { renderWeeklyNewsletter } from "./newsletterWeeklyTemplate";

export type WeeklyDraftOutcome =
  | { status: "created"; campaign: EmailCampaign; products: Product[] }
  | { status: "skipped"; reason: "no_new_products" | "insufficient_new_products" | "duplicate"; newProductCount: number };

export type WeeklyDraftDeps = {
  store?: NewsletterCampaignStore;
  productsLoader?: () => Promise<Product[]>;
  lastSentAtLoader?: () => Promise<string | null>;
  clickCountLoader?: (productIds: string[]) => Promise<Map<string, number>>;
  copyGenerator?: (products: readonly Product[]) => Promise<WeeklyNewsletterCopy>;
  telegramSender?: (chatId: string, text: string, replyMarkup?: unknown) => Promise<TelegramDeliveryResult>;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  testMode?: boolean;
};

function envActor(env: NodeJS.ProcessEnv): string {
  const explicit = (env.TELEGRAM_ADMIN_USER_ID || "").trim();
  if (explicit) return explicit;
  const firstAllowed = (env.TELEGRAM_ALLOWED_USER_IDS || env.TELEGRAM_ALLOWED_USERS || "").split(",").map(v => v.trim()).find(Boolean);
  if (firstAllowed) return firstAllowed;
  const chat = (env.TELEGRAM_ADMIN_CHAT_ID || "").trim();
  if (chat) return chat;
  throw new Error("WEEKLY_TELEGRAM_ACTOR_MISSING");
}

function freshnessMs(product: Product): number {
  const created = product.createdAt ? Date.parse(product.createdAt) : 0;
  const offerConfirmed = product.ofertaPromocional?.source === "admin_confirmed" ? Number(product.ofertaPromocional.confirmedAt || 0) : 0;
  return Math.max(Number.isFinite(created) ? created : 0, Number.isFinite(offerConfirmed) ? offerConfirmed : 0);
}

export async function loadLastSuccessfulCollectionSentAt(): Promise<string | null> {
  const client = productsRepository.requireSupabase();
  const { data, error } = await client.from("email_campaigns").select("sent_at").eq("campaign_type", "collection").eq("status", "sent").not("sent_at", "is", null).order("sent_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data?.sent_at ? String(data.sent_at) : null;
}

export async function loadProductClickCounts(productIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!productIds.length) return counts;
  const client = productsRepository.requireSupabase();
  const { data, error } = await client.from("product_clicks").select("product_id").in("product_id", productIds);
  if (error) throw error;
  for (const row of data || []) {
    const id = String(row.product_id || "");
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function rankCandidates(products: Product[], clickCounts: Map<string, number>): Product[] {
  const minSample = deriveMinSampleSize().nTotal;
  return [...products].sort((a, b) => {
    const aClicks = clickCounts.get(a.id) || 0;
    const bClicks = clickCounts.get(b.id) || 0;
    const aConfidence = deriveConfidenceV2({ recordCount: aClicks, minSampleRequired: minSample }).confidence;
    const bConfidence = deriveConfidenceV2({ recordCount: bClicks, minSampleRequired: minSample }).confidence;
    return confidenceV2ToScore(bConfidence) - confidenceV2ToScore(aConfidence)
      || bClicks - aClicks
      || freshnessMs(b) - freshnessMs(a);
  });
}

function editionKey(products: readonly Product[], now: Date, testMode: boolean): string {
  const digest = createHash("sha256").update(products.map(p => p.id).sort().join("\n"), "utf8").digest("hex").slice(0, 20);
  return `${testMode ? "weekly-test" : "weekly"}:${now.toISOString().slice(0, 10)}:${digest}`;
}

function telegramPreview(campaign: EmailCampaign, products: readonly Product[], copy: WeeklyNewsletterCopy, clickCounts: Map<string, number>, testMode: boolean): string {
  const minSample = deriveMinSampleSize().nTotal;
  const lines = products.map((product, index) => {
    const clicks = clickCounts.get(product.id) || 0;
    const confidence = deriveConfidenceV2({ recordCount: clicks, minSampleRequired: minSample });
    const canonicalPrice = product.ofertaPromocional?.source === "admin_confirmed" && product.ofertaPromocional.price > 0 ? product.ofertaPromocional.price : product.preco;
    return `${index === 0 ? "⭐" : "•"} ${product.displayTitle || product.produto}\n   R$ ${Number(canonicalPrice).toFixed(2).replace(".", ",")} · ${clicks} cliques · confiança ${confidence.confidence}`;
  });
  return [
    testMode ? "🧪 <b>RASCUNHO SEMANAL — LISTA DE TESTE</b>" : "📨 <b>RASCUNHO SEMANAL CERBERUS</b>",
    "",
    `<b>Assunto:</b> ${copy.subject}`,
    `<b>Preview:</b> ${copy.previewText}`,
    "",
    ...lines,
    "",
    "Nenhum e-mail foi enviado ainda.",
    testMode ? "Ao aprovar, somente o destino de teste configurado receberá a campanha." : "Somente sua aprovação explícita cria os destinatários e inicia o envio pelo Brevo.",
    `<code>${campaign.id}</code>`,
  ].join("\n");
}

async function notify(sender: WeeklyDraftDeps["telegramSender"], chatId: string, text: string, markup?: unknown): Promise<TelegramDeliveryResult> {
  return (sender || sendTelegramMessage)(chatId, text, markup);
}

export async function runWeeklyDraftCycle(deps: WeeklyDraftDeps = {}): Promise<WeeklyDraftOutcome> {
  const env = deps.env || process.env;
  const now = deps.now || new Date();
  const testMode = deps.testMode === true;
  const chatId = (env.TELEGRAM_ADMIN_CHAT_ID || "").trim();
  if (!chatId) throw new Error("WEEKLY_TELEGRAM_ADMIN_CHAT_MISSING");
  const publicBaseUrl = (env.NEWSLETTER_PUBLIC_BASE_URL || env.PUBLIC_SITE_URL || env.APP_URL || "").trim();
  if (!publicBaseUrl) throw new Error("WEEKLY_PUBLIC_BASE_URL_MISSING");
  const store = deps.store || createSupabaseNewsletterCampaignStore();
  const products = await (deps.productsLoader || productsRepository.getProducts)();
  const lastSentAt = testMode
    ? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
    : await (deps.lastSentAtLoader || loadLastSuccessfulCollectionSentAt)();
  const cutoffMs = lastSentAt ? Date.parse(lastSentAt) : now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const fresh = products.filter(product => product.ativo === true && product.status === "published" && product.ref?.trim() && freshnessMs(product) > cutoffMs);
  if (fresh.length === 0) {
    await notify(deps.telegramSender, chatId, "📭 <b>Campanha semanal pulada</b>\n\nSem produto genuinamente novo desde o último envio bem-sucedido. Nenhum rascunho foi gerado e nenhum e-mail foi enviado.");
    return { status: "skipped", reason: "no_new_products", newProductCount: 0 };
  }
  if (fresh.length < 3) {
    await notify(deps.telegramSender, chatId, `📭 <b>Campanha semanal pulada</b>\n\nHá somente ${fresh.length} produto(s) novo(s) pronto(s); o formato exige 1 destaque + pelo menos 2 secundários. Nenhum e-mail foi enviado.`);
    return { status: "skipped", reason: "insufficient_new_products", newProductCount: fresh.length };
  }

  const clickCounts = await (deps.clickCountLoader || loadProductClickCounts)(fresh.map(p => p.id));
  const selected = rankCandidates(fresh, clickCounts).slice(0, 4);
  const key = editionKey(selected, now, testMode);
  const existing = await store.findOperationalCollectionByEditionKey(key);
  if (existing) return { status: "skipped", reason: "duplicate", newProductCount: fresh.length };

  const copy = await (deps.copyGenerator || generateWeeklyNewsletterCopy)(selected);
  const institutional = await getNewsletterInstitutionalOptions(env);
  const campaignId = crypto.randomUUID();
  const rendered = renderWeeklyNewsletter(selected, copy, { campaignId, publicBaseUrl, socialLinks: institutional.socialLinks });
  const links: CampaignProductLink[] = selected.map((product, index) => ({ productId: product.id, position: index + 1, layout: index === 0 ? "feature" : "grid" }));
  const draft = createCampaignDraft(null, envActor(env), rendered, now, campaignId, "collection", links, key);
  const persisted = await store.createCampaign(draft);
  await store.createCampaignProducts(persisted.id, links);
  const pending = await submitCampaignForApproval(persisted, envActor(env), { store, env, now });
  const delivery = await notify(deps.telegramSender, chatId, telegramPreview(pending, selected, copy, clickCounts, testMode), {
    inline_keyboard: [
      [{ text: testMode ? "✅ Aprovar teste" : "✅ Aprovar e enviar", callback_data: `campaign_weekly_approve:${pending.id}` }],
      [{ text: "❌ Cancelar", callback_data: `campaign_cancel:${pending.id}` }],
    ],
  });
  if (!delivery.ok) {
    await cancelCampaign(pending, envActor(env), { store, env, now });
    throw new Error(`WEEKLY_TELEGRAM_DELIVERY_FAILED:${delivery.failureReason || "unknown"}`);
  }
  const messageId = Number(delivery.result?.message_id);
  if (Number.isSafeInteger(messageId) && messageId > 0) await store.saveCampaignTelegramCard(pending.id, chatId, messageId);
  return { status: "created", campaign: pending, products: selected };
}

export async function runWeeklyStaleDraftCheck(options: { env?: NodeJS.ProcessEnv; now?: Date; telegramSender?: WeeklyDraftDeps["telegramSender"] } = {}): Promise<number> {
  const env = options.env || process.env;
  const now = options.now || new Date();
  const chatId = (env.TELEGRAM_ADMIN_CHAT_ID || "").trim();
  if (!chatId) throw new Error("WEEKLY_TELEGRAM_ADMIN_CHAT_MISSING");
  const ttlHours = Math.max(1, Math.min(168, Number.parseInt(env.NEWSLETTER_WEEKLY_APPROVAL_TTL_HOURS || "24", 10)));
  const upper = new Date(now.getTime() - ttlHours * 60 * 60 * 1000).toISOString();
  const lower = new Date(now.getTime() - (ttlHours + 24) * 60 * 60 * 1000).toISOString();
  const client = productsRepository.requireSupabase();
  const { data, error } = await client.from("email_campaigns").select("id, subject, created_at").eq("status", "pending_approval").like("edition_key", "weekly:%").gte("created_at", lower).lte("created_at", upper).order("created_at", { ascending: true }).limit(20);
  if (error) throw error;
  for (const campaign of data || []) {
    await notify(options.telegramSender, chatId, `⏳ <b>Rascunho semanal sem decisão</b>\n\n${String(campaign.subject || "Campanha semanal")}\n<code>${String(campaign.id)}</code>\n\nO prazo de aprovação passou. Por padrão, nada será enviado automaticamente.`);
  }
  return (data || []).length;
}
''')

write("server/routes/newsletterWeeklyRoutes.ts", r'''import { timingSafeEqual } from "node:crypto";
import type express from "express";
import * as productsRepository from "../repositories/productsRepository";
import { runWeeklyDraftCycle, runWeeklyStaleDraftCheck } from "../services/newsletterWeeklyCampaign";

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function registerNewsletterWeeklyRoutes(app: express.Express): void {
  const requireAutomation = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const expected = (process.env.CERBERUS_AUTOMATION_TOKEN || "").trim();
    const provided = String(req.headers["x-cerberus-automation-token"] || "").trim();
    if (!expected || !tokenMatches(provided, expected)) return res.status(401).json({ success: false, code: "AUTOMATION_UNAUTHORIZED" });
    next();
  };

  app.get("/go/:ref", async (req, res) => {
    const ref = String(req.params.ref || "").trim();
    if (!ref) return res.status(404).send("Produto não encontrado.");
    try {
      const products = await productsRepository.getProducts();
      const product = products.find(item => item.ref === ref);
      if (!product || product.ativo !== true || product.status !== "published") return res.status(404).send("Produto indisponível.");
      try {
        await productsRepository.recordProductClick({
          productId: product.id,
          productSlug: product.slug,
          productName: product.displayTitle || product.produto,
          productPrice: Number(product.ofertaPromocional?.source === "admin_confirmed" ? product.ofertaPromocional.price : product.preco),
          utmSource: String(req.query.utm_source || "email").slice(0, 120),
          utmMedium: String(req.query.utm_medium || "newsletter").slice(0, 120),
          utmCampaign: String(req.query.campaign_id || "").slice(0, 160),
          utmContent: String(req.query.position || product.id).slice(0, 120),
          referrer: String(req.headers.referer || "").slice(0, 500),
          landingPage: `/go/${encodeURIComponent(ref)}`,
          userAgent: String(req.headers["user-agent"] || "").slice(0, 500),
          ipAddress: String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(),
        });
      } catch (error) {
        console.error(`[NEWSLETTER-WEEKLY] click_tracking_failed ref=${ref} reason=${error instanceof Error ? error.message.replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 100) : "unknown"}`);
      }
      return res.redirect(302, product.link);
    } catch {
      return res.status(503).send("Destino temporariamente indisponível.");
    }
  });

  app.post("/api/internal/newsletter/weekly-draft", requireAutomation, async (req, res) => {
    try {
      const result = await runWeeklyDraftCycle({ testMode: req.body?.testMode === true });
      return res.status(result.status === "created" ? 201 : 200).json({ success: true, status: result.status, reason: result.status === "skipped" ? result.reason : undefined, campaignId: result.status === "created" ? result.campaign.id : undefined });
    } catch (error) {
      console.error(`[NEWSLETTER-WEEKLY] draft_failed reason=${error instanceof Error ? error.message.replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 120) : "unknown"}`);
      return res.status(500).json({ success: false, code: "WEEKLY_DRAFT_FAILED" });
    }
  });

  app.post("/api/internal/newsletter/weekly-stale", requireAutomation, async (_req, res) => {
    try {
      const notified = await runWeeklyStaleDraftCheck();
      return res.json({ success: true, notified });
    } catch (error) {
      console.error(`[NEWSLETTER-WEEKLY] stale_check_failed reason=${error instanceof Error ? error.message.replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 120) : "unknown"}`);
      return res.status(500).json({ success: false, code: "WEEKLY_STALE_CHECK_FAILED" });
    }
  });
}
''')

write("tests/newsletterWeeklyCampaign.test.ts", r'''import test from "node:test";
import assert from "node:assert/strict";
import type { Product } from "../src/types";
import { buildWeeklyCopyPrompt, sanitizeWeeklyNewsletterCopy } from "../server/services/newsletterWeeklyCopy";
import { buildWeeklyGoUrl, renderWeeklyNewsletter, BREVO_NATIVE_UNSUBSCRIBE } from "../server/services/newsletterWeeklyTemplate";
import { runWeeklyDraftCycle } from "../server/services/newsletterWeeklyCampaign";

function product(id: string, ref: string, createdAt: string, price: number, clicks = 0): Product & { clicks?: number } {
  return {
    id, ref, produto: `Produto ${id}`, displayTitle: `Peça editorial ${id}`, categoria: "Iluminação", preco: price,
    imagens: [`https://cdn.example.com/${id}.jpg`], imageEditorialStatus: "clean", link: `https://market.example.com/${id}`,
    ativo: true, destaque: false, status: "published", descricao: `Descrição factual ${id}`, createdAt, clicks,
  };
}

function memoryStore() {
  const campaigns = new Map<string, any>();
  return {
    campaigns,
    async createCampaign(c: any) { campaigns.set(c.id, structuredClone(c)); return structuredClone(c); },
    async createCampaignProducts() {}, async listCampaignProducts() { return []; },
    async getCampaign(id: string) { return structuredClone(campaigns.get(id) || null); },
    async listRecentCampaigns() { return []; }, async findOperationalCollectionByEditionKey() { return null; },
    async getCampaignTelegramCard() { return null; }, async saveCampaignTelegramCard() {},
    async updateCampaign(c: any) { campaigns.set(c.id, structuredClone(c)); return structuredClone(c); },
    async createEligibleRecipients() { throw new Error("REAL_RECIPIENTS_MUST_NOT_BE_CREATED_DURING_DRAFT"); },
    async claimRecipient() { return null; }, async readSubscriber() { return null; }, async prepareUnsubscribeToken() { throw new Error("unused"); },
    async markRecipientSent() { return null; }, async markRecipientSkipped() { return null; }, async markRecipientFailed() { return null; },
    async summarizeRecipients() { return { total: 0, success: 0, failed: 0, skipped: 0 }; }, async listRetryableRecipients() { return []; },
    async resetFailedRecipients() { return 0; }, async listSendingCampaigns() { return []; },
  } as any;
}

const copy = { subject: "Achados da semana", previewText: "Uma curadoria curta para esta semana.", heroHeadline: "Forma que merece atenção", heroBody: "Uma peça de presença limpa, escolhida pela forma e pelo uso.", secondaryCaptions: { b: "Uma leitura compacta e direta.", c: "Geometria simples para o cotidiano.", d: "Uma peça discreta com desenho marcado." } };

test("prompt Gemini semanal não recebe preço, disponibilidade nem links", () => {
  const p = product("a", "REF-A", "2026-08-28T12:00:00Z", 987.65);
  const prompt = buildWeeklyCopyPrompt([p]);
  assert.doesNotMatch(prompt, /987[.,]65/);
  assert.doesNotMatch(prompt, /market\.example\.com/);
  assert.doesNotMatch(prompt, /\"preco\"|\"link\"|\"availability\"/i);
});

test("copy rejeita preço ou disponibilidade inventados", () => {
  const products = [product("a", "REF-A", "2026-08-28T12:00:00Z", 10), product("b", "REF-B", "2026-08-28T11:00:00Z", 20), product("c", "REF-C", "2026-08-28T10:00:00Z", 30)];
  assert.throws(() => sanitizeWeeklyNewsletterCopy({ ...copy, heroBody: "Disponível agora por R$ 10" }, products), /COMMERCIAL_FACT_FORBIDDEN/);
});

test("template usa preço canônico, tabelas, bgcolor, /go/:ref e unsubscribe nativo Brevo", () => {
  const products = [product("a", "REF-A", "2026-08-28T12:00:00Z", 10), product("b", "REF-B", "2026-08-28T11:00:00Z", 20), product("c", "REF-C", "2026-08-28T10:00:00Z", 30)];
  const rendered = renderWeeklyNewsletter(products, copy, { campaignId: "camp-1", publicBaseUrl: "https://cerberus.example.com", socialLinks: [] });
  assert.match(rendered.html, /<table\b/i);
  assert.match(rendered.html, /bgcolor="#0a0a0a"/i);
  assert.match(rendered.html, /#c0392b/i);
  assert.match(rendered.html, /R\$\s*10,00/);
  assert.match(rendered.html, /\/go\/REF-A/);
  assert.doesNotMatch(rendered.html, /market\.example\.com/);
  assert.match(rendered.html, new RegExp(BREVO_NATIVE_UNSUBSCRIBE.replace(/[{}]/g, "\\$&")));
  assert.doesNotMatch(rendered.html, /display\s*:\s*(flex|grid)/i);
});

test("URL semanal sempre usa redirect mascarado e campaign_id", () => {
  const url = buildWeeklyGoUrl("https://cerberus.example.com", product("a", "REF 21", "2026-08-28T12:00:00Z", 10), "campaign-xyz", 1);
  assert.match(url, /^https:\/\/cerberus\.example\.com\/go\/REF%2021\?/);
  assert.match(url, /campaign_id=campaign-xyz/);
});

test("sem produto novo pula ciclo, notifica e não cria campanha", async () => {
  const store = memoryStore();
  const messages: string[] = [];
  const result = await runWeeklyDraftCycle({
    store,
    productsLoader: async () => [product("a", "REF-A", "2026-08-20T12:00:00Z", 10)],
    lastSentAtLoader: async () => "2026-08-27T00:00:00Z",
    telegramSender: async (_chat, text) => { messages.push(text); return { ok: true, result: { message_id: 1 } }; },
    now: new Date("2026-08-28T15:00:00Z"),
    env: { TELEGRAM_ADMIN_CHAT_ID: "123", TELEGRAM_ALLOWED_USER_IDS: "123", NEWSLETTER_PUBLIC_BASE_URL: "https://cerberus.example.com" },
  });
  assert.equal(result.status, "skipped");
  assert.equal(store.campaigns.size, 0);
  assert.match(messages[0], /Sem produto genuinamente novo/i);
});

test("draft semanal exige 1 destaque + ao menos 2 secundários", async () => {
  const store = memoryStore();
  const messages: string[] = [];
  const result = await runWeeklyDraftCycle({
    store,
    productsLoader: async () => [product("a", "REF-A", "2026-08-28T12:00:00Z", 10), product("b", "REF-B", "2026-08-28T11:00:00Z", 20)],
    lastSentAtLoader: async () => "2026-08-27T00:00:00Z",
    telegramSender: async (_chat, text) => { messages.push(text); return { ok: true, result: { message_id: 1 } }; },
    now: new Date("2026-08-28T15:00:00Z"), env: { TELEGRAM_ADMIN_CHAT_ID: "123", TELEGRAM_ALLOWED_USER_IDS: "123", NEWSLETTER_PUBLIC_BASE_URL: "https://cerberus.example.com" },
  });
  assert.equal(result.status, "skipped");
  assert.match(messages[0], /mínimo 3|pelo menos 2 secundários/i);
});

test("draft completo persiste pending_approval e nunca cria recipients antes do clique humano", async () => {
  const store = memoryStore();
  const products = [product("a", "REF-A", "2026-08-28T12:00:00Z", 10), product("b", "REF-B", "2026-08-28T11:00:00Z", 20), product("c", "REF-C", "2026-08-28T10:00:00Z", 30), product("d", "REF-D", "2026-08-28T09:00:00Z", 40)];
  let markup: any = null;
  const result = await runWeeklyDraftCycle({
    store, productsLoader: async () => products, lastSentAtLoader: async () => "2026-08-27T00:00:00Z",
    clickCountLoader: async () => new Map([["a", 0], ["b", 4], ["c", 1], ["d", 0]]), copyGenerator: async () => copy,
    telegramSender: async (_chat, _text, m) => { markup = m; return { ok: true, result: { message_id: 77 } }; },
    now: new Date("2026-08-28T15:00:00Z"), env: { TELEGRAM_ADMIN_CHAT_ID: "123", TELEGRAM_ALLOWED_USER_IDS: "123", NEWSLETTER_PUBLIC_BASE_URL: "https://cerberus.example.com" },
  });
  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  assert.equal(result.campaign.status, "pending_approval");
  assert.match(String(markup.inline_keyboard[0][0].callback_data), /^campaign_weekly_approve:/);
  assert.equal(store.campaigns.size, 1);
});
''')

# Register route in server.ts.
replace_once(
    "server.ts",
    'import { registerCommercialBrainRoutes } from "./server/routes/commercialBrainRoutes";\n',
    'import { registerCommercialBrainRoutes } from "./server/routes/commercialBrainRoutes";\nimport { registerNewsletterWeeklyRoutes } from "./server/routes/newsletterWeeklyRoutes";\n',
)
replace_once(
    "server.ts",
    '  registerCommercialBrainRoutes({ app, requireAdminAuth });\n',
    '  registerCommercialBrainRoutes({ app, requireAdminAuth });\n  registerNewsletterWeeklyRoutes(app);\n',
)

# Add one-click human approval for weekly drafts. Test drafts stop at the existing controlled-test path.
replace_once(
    "server/services/newsletterCampaignTelegram.ts",
    '    if (data.startsWith("campaign_approve:")) {\n',
    '''    if (data.startsWith("campaign_weekly_approve:")) {\n      if (campaign.status !== "pending_approval") return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);\n      const approved = await approveCampaign(campaign, senderId, { store, env });\n      if (approved.editionKey?.startsWith("weekly-test:")) {\n        const tested = await sendCampaignTest(approved, senderId, { store, env, provider: deps.provider });\n        await deps.answerCallbackQuery(callbackId, "Rascunho aprovado. Teste enviado somente ao destino controlado.");\n        await syncCampaignTelegramState(tested.campaign.id, deps, messageReference(chatId, messageId));\n        return true;\n      }\n      const confirmed = await confirmGeneralSend(approved, senderId, { store, env });\n      const sending = await startGeneralSend(confirmed, senderId, { store, env });\n      await deps.answerCallbackQuery(callbackId, "Campanha aprovada. Envio geral enfileirado.");\n      await syncCampaignTelegramState(sending.id, deps, messageReference(chatId, messageId));\n      return true;\n    }\n\n    if (data.startsWith("campaign_approve:")) {\n''',
)

# Weekly campaigns use the native Brevo unsubscribe placeholder. Legacy campaigns keep the canonical custom token flow unchanged.
replace_once(
    "server/services/newsletterCampaignWorker.ts",
    '''      let unsubscribeUrl: string;\n      try {\n        const token = await store.prepareUnsubscribeToken(claimed.recipient.subscriberEmail);\n        unsubscribeUrl = buildUnsubscribeUrl(publicBaseUrl, token);\n      } catch {\n        lastRecipient = await store.markRecipientFailed(claimed.recipient.id, claimed.leaseToken, "UNSUBSCRIBE_TOKEN_PREPARATION_FAILED", new Date(now().getTime() + retryDelayMs(claimed.recipient.attemptCount)).toISOString());\n        lastOutcome = "failed";\n        continue;\n      }\n      const htmlContent = campaign.bodyHtml.split(UNSUBSCRIBE_URL_PLACEHOLDER).join(unsubscribeUrl);\n      const textContent = campaign.bodyText.split(UNSUBSCRIBE_URL_PLACEHOLDER).join(unsubscribeUrl);\n''',
    '''      let htmlContent: string;\n      let textContent: string;\n      if (campaign.editionKey?.startsWith("weekly:")) {\n        // Weekly marketing campaigns deliberately use Brevo's native {{ unsubscribe }} link.\n        // Do not mint the legacy Supabase unsubscribe token for this campaign family.\n        htmlContent = campaign.bodyHtml;\n        textContent = campaign.bodyText;\n      } else {\n        let unsubscribeUrl: string;\n        try {\n          const token = await store.prepareUnsubscribeToken(claimed.recipient.subscriberEmail);\n          unsubscribeUrl = buildUnsubscribeUrl(publicBaseUrl, token);\n        } catch {\n          lastRecipient = await store.markRecipientFailed(claimed.recipient.id, claimed.leaseToken, "UNSUBSCRIBE_TOKEN_PREPARATION_FAILED", new Date(now().getTime() + retryDelayMs(claimed.recipient.attemptCount)).toISOString());\n          lastOutcome = "failed";\n          continue;\n        }\n        htmlContent = campaign.bodyHtml.split(UNSUBSCRIBE_URL_PLACEHOLDER).join(unsubscribeUrl);\n        textContent = campaign.bodyText.split(UNSUBSCRIBE_URL_PLACEHOLDER).join(unsubscribeUrl);\n      }\n''',
)

# Extend the existing watchdog scheduler instead of introducing a third scheduler.
watchdog = Path(".github/workflows/cerberus-watchdog.yml").read_text(encoding="utf-8")
watchdog = watchdog.replace('  schedule:\n    - cron: "*/15 * * * *"\n  workflow_dispatch:\n', '''  schedule:\n    - cron: "*/15 * * * *"\n    # Sexta 10:00 America/Fortaleza (13:00 UTC): cria somente o rascunho.\n    - cron: "0 13 * * 5"\n    # Sábado 10:00 America/Fortaleza: lembra rascunhos sem decisão; nunca envia.\n    - cron: "0 13 * * 6"\n  workflow_dispatch:\n    inputs:\n      operation:\n        description: "Operação controlada"\n        required: true\n        type: choice\n        default: health\n        options:\n          - health\n          - weekly-draft\n          - weekly-draft-test\n          - weekly-stale\n''')
watchdog = watchdog.replace('  health-check:\n    runs-on: ubuntu-latest\n', '  health-check:\n    if: github.event_name == \'schedule\' && github.event.schedule == \'*/15 * * * *\' || github.event_name == \'workflow_dispatch\' && inputs.operation == \'health\'\n    runs-on: ubuntu-latest\n')
watchdog += r'''

  weekly-draft:
    if: github.event_name == 'schedule' && github.event.schedule == '0 13 * * 5' || github.event_name == 'workflow_dispatch' && (inputs.operation == 'weekly-draft' || inputs.operation == 'weekly-draft-test')
    runs-on: ubuntu-latest
    timeout-minutes: 2
    env:
      CERBERUS_HEALTH_URL: ${{ secrets.CERBERUS_HEALTH_URL }}
      CERBERUS_AUTOMATION_TOKEN: ${{ secrets.CERBERUS_AUTOMATION_TOKEN }}
    steps:
      - name: Trigger weekly draft only
        shell: bash
        run: |
          set -euo pipefail
          [ -n "${CERBERUS_HEALTH_URL:-}" ] || { echo "CERBERUS_HEALTH_URL missing"; exit 1; }
          [ -n "${CERBERUS_AUTOMATION_TOKEN:-}" ] || { echo "CERBERUS_AUTOMATION_TOKEN missing"; exit 1; }
          base="${CERBERUS_HEALTH_URL%/health}"
          body='{}'
          if [ "${{ github.event_name }}" = "workflow_dispatch" ] && [ "${{ inputs.operation }}" = "weekly-draft-test" ]; then body='{"testMode":true}'; fi
          curl --fail-with-body --silent --show-error --max-time 45 \
            -H "Content-Type: application/json" \
            -H "X-Cerberus-Automation-Token: ${CERBERUS_AUTOMATION_TOKEN}" \
            -d "$body" \
            "$base/api/internal/newsletter/weekly-draft"

  weekly-stale:
    if: github.event_name == 'schedule' && github.event.schedule == '0 13 * * 6' || github.event_name == 'workflow_dispatch' && inputs.operation == 'weekly-stale'
    runs-on: ubuntu-latest
    timeout-minutes: 2
    env:
      CERBERUS_HEALTH_URL: ${{ secrets.CERBERUS_HEALTH_URL }}
      CERBERUS_AUTOMATION_TOKEN: ${{ secrets.CERBERUS_AUTOMATION_TOKEN }}
    steps:
      - name: Notify stale weekly draft without sending
        shell: bash
        run: |
          set -euo pipefail
          [ -n "${CERBERUS_HEALTH_URL:-}" ] || { echo "CERBERUS_HEALTH_URL missing"; exit 1; }
          [ -n "${CERBERUS_AUTOMATION_TOKEN:-}" ] || { echo "CERBERUS_AUTOMATION_TOKEN missing"; exit 1; }
          base="${CERBERUS_HEALTH_URL%/health}"
          curl --fail-with-body --silent --show-error --max-time 45 \
            -H "Content-Type: application/json" \
            -H "X-Cerberus-Automation-Token: ${CERBERUS_AUTOMATION_TOKEN}" \
            -d '{}' \
            "$base/api/internal/newsletter/weekly-stale"
'''
Path(".github/workflows/cerberus-watchdog.yml").write_text(watchdog, encoding="utf-8")

# Make the permanent gate watch and execute the weekly newsletter tests.
gate = Path(".github/workflows/telegram-contract.yml").read_text(encoding="utf-8")
gate = gate.replace('      - "tests/newsletterCampaign.test.ts"\n', '      - "tests/newsletterCampaign.test.ts"\n      - "tests/newsletterWeeklyCampaign.test.ts"\n      - "server/services/newsletterWeekly*.ts"\n      - "server/routes/newsletterWeeklyRoutes.ts"\n      - ".github/workflows/cerberus-watchdog.yml"\n')
gate = gate.replace('            tests/newsletterCampaign.test.ts\n', '            tests/newsletterCampaign.test.ts\n            tests/newsletterWeeklyCampaign.test.ts\n')
gate = gate.replace('            tests/newsletterCampaign.test.ts 2>&1 | tee', '            tests/newsletterCampaign.test.ts \\\n            tests/newsletterWeeklyCampaign.test.ts 2>&1 | tee')
Path(".github/workflows/telegram-contract.yml").write_text(gate, encoding="utf-8")

print("weekly newsletter materialization complete")
