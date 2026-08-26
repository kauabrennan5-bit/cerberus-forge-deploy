import type { Product } from "../../src/types";
import { appendUTMsToUrl } from "../../src/lib/utm";

export const UNSUBSCRIBE_URL_PLACEHOLDER = "{{UNSUBSCRIBE_URL}}";

export type NewsletterCampaignRenderOptions = {
  subject?: string;
  unsubscribeUrl?: string;
  disclosure?: string;
  trackingCampaignId?: string;
};

export type RenderedNewsletterCampaign = {
  subject: string;
  html: string;
  text: string;
  offerUrl: string;
};

const DEFAULT_DISCLOSURE =
  "Este e-mail pode conter links de afiliado. Se você comprar por um link, o Cerberus Finds poderá receber uma comissão, sem custo adicional para você.";

export function renderNewsletterCampaign(
  product: Product,
  options: NewsletterCampaignRenderOptions = {},
): RenderedNewsletterCampaign {
  const displayTitle = normalizeRequiredText(product.displayTitle || product.produto, "displayTitle");
  const baseOfferUrl = resolveCampaignOfferUrl(product);
  const offerUrl = options.trackingCampaignId?.trim()
    ? appendUTMsToUrl(baseOfferUrl, {
        utm_source: "email",
        utm_medium: "newsletter",
        utm_campaign: options.trackingCampaignId.trim(),
        utm_content: product.id,
      })
    : baseOfferUrl;
  const subject = normalizeRequiredText(options.subject || `Nova seleção: ${displayTitle}`, "subject");
  const disclosure = normalizeRequiredText(options.disclosure || DEFAULT_DISCLOSURE, "disclosure");
  const unsubscribeUrl = options.unsubscribeUrl?.trim() || UNSUBSCRIBE_URL_PLACEHOLDER;
  const imageUrl = firstHttpImage(product.imagens);
  const note = product.curatorNote?.trim() || "";
  const offer = normalizeOffer(product.ofertaPromocional);
  const verifiedPrice = formatPrice(product.preco);
  const previousPrice = offer ? formatPrice(product.preco) : "";
  const htmlImage = imageUrl
    ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(displayTitle)}" style="display:block;width:100%;max-width:560px;height:auto;border:0;margin:0 auto 24px;" />`
    : "";
  const htmlNote = note
    ? `<p style="margin:0 0 18px;color:#4b4037;font-size:16px;line-height:1.55;"><strong>Nota do curador:</strong> ${escapeHtml(note)}</p>`
    : "";
  const htmlOffer = offer
    ? `<p style="margin:0 0 20px;color:#231b16;font-size:19px;line-height:1.45;"><strong>Preço verificado:</strong> <span style="color:#8a1f1f;font-weight:700;">${escapeHtml(formatPrice(offer.price))}</span><br /><span style="color:#6d6259;text-decoration:line-through;font-size:15px;">${escapeHtml(previousPrice)}</span></p>`
    : `<p style="margin:0 0 20px;color:#231b16;font-size:19px;line-height:1.45;"><strong>Preço verificado:</strong> <span style="color:#8a1f1f;font-weight:700;">${escapeHtml(verifiedPrice)}</span></p>`;
  const textNote = note ? `\nNota do curador: ${note}\n` : "";
  const textOffer = offer
    ? `Preço verificado: ${formatPrice(offer.price)}\nPreço anterior: ${previousPrice}\n`
    : `Preço verificado: ${verifiedPrice}\n`;
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f5f1ed;font-family:Arial,Helvetica,sans-serif;color:#231b16;"><div style="width:100%;background:#f5f1ed;padding:24px 0;"><div style="max-width:600px;margin:0 auto;background:#fff;padding:28px 24px;border:1px solid #e1d8d0;"><p style="margin:0 0 12px;color:#8a1f1f;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Cerberus Finds</p><h1 style="margin:0 0 24px;font-size:28px;line-height:1.2;color:#231b16;">${escapeHtml(subject)}</h1>${htmlImage}<h2 style="margin:0 0 14px;font-size:23px;line-height:1.3;color:#231b16;">${escapeHtml(displayTitle)}</h2>${htmlNote}${htmlOffer}<p style="margin:0 0 24px;"><a href="${escapeHtml(offerUrl)}" style="display:inline-block;background:#8a1f1f;color:#fff;text-decoration:none;padding:13px 22px;font-size:15px;font-weight:700;">Ver oferta</a></p><p style="margin:0 0 18px;color:#6d6259;font-size:12px;line-height:1.55;">${escapeHtml(disclosure)}</p><p style="margin:0;color:#6d6259;font-size:12px;line-height:1.55;">Você recebeu esta mensagem por ter autorizado comunicações de marketing do Cerberus Finds. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#8a1f1f;">Descadastrar-se</a>.</p></div></div></body></html>`;
  const text = [
    "Cerberus Finds",
    subject,
    "",
    displayTitle,
    textNote.trim(),
    textOffer.trim(),
    `Ver oferta: ${offerUrl}`,
    "",
    disclosure,
    "",
    `Descadastrar-se: ${unsubscribeUrl}`,
  ].filter(Boolean).join("\n");

  return { subject, html, text, offerUrl };
}

export function resolveCampaignOfferUrl(product: Pick<Product, "link" | "paginaPonteUrl">): string {
  const candidate = (product.paginaPonteUrl || product.link || "").trim();
  if (!/^https?:\/\/[^\s]+$/i.test(candidate)) {
    throw new Error("CAMPAIGN_OFFER_URL_INVALID");
  }
  return candidate;
}

function normalizeRequiredText(value: string, field: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error(`CAMPAIGN_${field.toUpperCase()}_REQUIRED`);
  return normalized;
}

function firstHttpImage(images: unknown): string | null {
  if (!Array.isArray(images)) return null;
  const image = images.find((value): value is string => typeof value === "string" && /^https?:\/\/[^\s]+$/i.test(value.trim()));
  return image?.trim() || null;
}

function normalizeOffer(offer: Product["ofertaPromocional"]): Product["ofertaPromocional"] | null {
  if (!offer || !Number.isFinite(offer.price) || offer.price <= 0) return null;
  return offer;
}

function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) throw new Error("CAMPAIGN_PRICE_INVALID");
  return `R$ ${value.toFixed(2).replace(".", ",")}`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
