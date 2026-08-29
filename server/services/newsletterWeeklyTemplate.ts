import type { Product } from "../../src/types";
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
