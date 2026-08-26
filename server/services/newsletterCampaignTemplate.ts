import type { Product } from "../../src/types";
import { appendUTMsToUrl } from "../../src/lib/utm";

export const UNSUBSCRIBE_URL_PLACEHOLDER = "{{UNSUBSCRIBE_URL}}";

export type NewsletterSocialLink = {
  label: string;
  url: string;
  icon?: string;
};

export type NewsletterCampaignRenderOptions = {
  subject?: string;
  unsubscribeUrl?: string;
  disclosure?: string;
  trackingCampaignId?: string;
  preheader?: string;
  viewInBrowserUrl?: string;
  privacyUrl?: string;
  termsUrl?: string;
  socialLinks?: readonly NewsletterSocialLink[];
  microcopy?: string;
};

export type RenderedNewsletterCampaign = {
  subject: string;
  html: string;
  text: string;
  offerUrl: string;
};

const DEFAULT_DISCLOSURE =
  "Este e-mail pode conter links de afiliado. Se você comprar por um link, o Cerberus Finds poderá receber uma comissão, sem custo adicional para você.";
const DEFAULT_MICROCOPY = "Uma seleção encontrada pela Cerberus Finds.";
const DEFAULT_PREHEADER = "Uma seleção editorial encontrada para você.";

export function renderNewsletterCampaign(
  product: Product,
  options: NewsletterCampaignRenderOptions = {},
): RenderedNewsletterCampaign {
  const displayTitle = normalizeRequiredText(product.displayTitle || product.produto, "displayTitle");
  const category = normalizeOptionalText(product.categoria);
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
  const preheader = normalizeRequiredText(options.preheader || DEFAULT_PREHEADER, "preheader");
  const disclosure = normalizeRequiredText(options.disclosure || DEFAULT_DISCLOSURE, "disclosure");
  const microcopy = normalizeRequiredText(options.microcopy || DEFAULT_MICROCOPY, "microcopy");
  const unsubscribeUrl = options.unsubscribeUrl?.trim() || UNSUBSCRIBE_URL_PLACEHOLDER;
  const imageUrl = firstHttpImage(product.imagens);
  const note = normalizeOptionalText(product.curatorNote);
  const offer = normalizeOffer(product.ofertaPromocional);
  const verifiedPrice = formatPrice(offer?.price || product.preco);
  const previousPrice = offer && product.preco > offer.price ? formatPrice(product.preco) : "";
  const savings = offer && product.preco > offer.price ? formatPrice(product.preco - offer.price) : "";
  const viewInBrowserUrl = normalizeHttpUrl(options.viewInBrowserUrl);
  const privacyUrl = normalizeHttpUrl(options.privacyUrl);
  const termsUrl = normalizeHttpUrl(options.termsUrl);
  const socialLinks = normalizeSocialLinks(options.socialLinks);

  const htmlImage = imageUrl
    ? `<tr><td class="email-pad email-hero-cell" style="padding:0 36px 30px;"><img class="email-hero" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(displayTitle)}" width="568" style="display:block;width:100%;max-width:568px;height:auto;border:0;border-radius:8px;background:#2a2622;" /></td></tr>`
    : "";
  const htmlCategory = category
    ? `<p class="email-eyebrow" style="margin:0 0 10px;color:#c97964;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.4;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${escapeHtml(category)}</p>`
    : "";
  const htmlNote = note
    ? `<tr><td class="email-pad" style="padding:0 36px 26px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:#211c18;border-left:3px solid #8a1f1f;"><tr><td style="padding:18px 20px;"><p style="margin:0 0 7px;color:#c97964;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.4;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">Por que selecionamos isso?</p><p style="margin:0;color:#e8e1d3;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;">${escapeHtml(note)}</p></td></tr></table></td></tr>`
    : "";
  const htmlPrice = `<tr><td class="email-pad" style="padding:0 36px 26px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-price-card" style="border-collapse:collapse;background:#e8e1d3;border-radius:8px;"><tr><td style="padding:20px 22px;"><p style="margin:0 0 8px;color:#5e5148;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.4;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">Preço verificado</p><p class="email-price" style="margin:0;color:#0b0908;font-family:Arial,Helvetica,sans-serif;font-size:30px;line-height:1.1;font-weight:700;">${escapeHtml(verifiedPrice)}</p>${previousPrice ? `<p style="margin:8px 0 0;color:#71665e;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.4;text-decoration:line-through;">${escapeHtml(previousPrice)}</p><p style="margin:5px 0 0;color:#8a1f1f;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.4;font-weight:700;">Economia de ${escapeHtml(savings)}</p>` : ""}</td></tr></table></td></tr>`;
  const htmlLinks = socialLinks.length
    ? `<tr><td style="padding:0 36px 20px;text-align:center;"><p style="margin:0;color:#9b9085;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.5;letter-spacing:1px;text-transform:uppercase;">Encontre a Cerberus Finds</p><p style="margin:10px 0 0;">${socialLinks.map(link => {
      const icon = escapeHtml(link.icon || socialMonogram(link.label));
      const iconStyle = "display:inline-block;width:30px;height:30px;margin:0 4px;border:1px solid #3a342e;color:#e8e1d3;font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:30px;font-weight:700;text-align:center;text-decoration:none;";
      return link.url
        ? `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener" aria-label="${escapeHtml(link.label)}" style="${iconStyle}background:#211c18;">${icon}</a>`
        : `<span aria-label="${escapeHtml(link.label)} ainda não configurado" style="${iconStyle}border-style:dashed;color:#6d6259;">${icon}</span>`;
    }).join("")}</p></td></tr>`
    : "";
  const htmlInstitutionalLinks = privacyUrl || termsUrl
    ? `<p style="margin:0 0 13px;color:#9b9085;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;">${privacyUrl ? `<a href="${escapeHtml(privacyUrl)}" target="_blank" rel="noopener" style="color:#e8e1d3;text-decoration:underline;">Política de privacidade</a>` : ""}${privacyUrl && termsUrl ? `<span style="color:#5e5148;padding:0 8px;">|</span>` : ""}${termsUrl ? `<a href="${escapeHtml(termsUrl)}" target="_blank" rel="noopener" style="color:#e8e1d3;text-decoration:underline;">Termos e condições</a>` : ""}</p>`
    : "";
  const htmlViewLink = viewInBrowserUrl
    ? `<p style="margin:0 0 22px;text-align:right;"><a href="${escapeHtml(viewInBrowserUrl)}" target="_blank" rel="noopener" style="color:#9b9085;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.4;text-decoration:underline;">Ver no navegador</a></p>`
    : "";
  const emailStyles = `<style>body{margin:0!important;padding:0!important;background:#0b0908;color:#e8e1d3;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}table{border-spacing:0;}img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}a{color:inherit;}@media only screen and (max-width:620px){.email-shell{width:100%!important;}.email-card{border-radius:0!important;}.email-pad{padding-left:20px!important;padding-right:20px!important;}.email-hero-cell{padding-bottom:24px!important;}.email-title{font-size:30px!important;}.email-price{font-size:27px!important;}.email-cta-cell{width:100%!important;}.email-cta-link{display:block!important;padding-top:16px!important;padding-bottom:16px!important;}}@media (prefers-color-scheme:dark){.email-body{background:#0b0908!important;}.email-card{background:#181512!important;}.email-price-card{background:#e8e1d3!important;}.email-title,.email-copy{color:#e8e1d3!important;}}</style>`;
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><meta name="supported-color-schemes" content="dark light">${emailStyles}</head><body class="email-body" style="margin:0;padding:0;background:#0b0908;color:#e8e1d3;"><span style="display:none!important;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</span><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background:#0b0908;"><tr><td align="center" style="padding:24px 12px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-shell" style="width:100%;max-width:640px;border-collapse:collapse;"><tr><td class="email-card" style="background:#181512;border:1px solid #3a342e;border-radius:12px;overflow:hidden;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"> <tr><td class="email-pad" style="padding:24px 36px 18px;">${htmlViewLink}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="width:31px;height:31px;background:#8a1f1f;color:#e8e1d3;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:31px;font-weight:700;text-align:center;">CF</td><td style="padding-left:11px;color:#e8e1d3;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.3;font-weight:700;letter-spacing:2px;">CERBERUS FINDS</td></tr></table></td><td align="right" valign="middle"><span style="color:#9b9085;font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;letter-spacing:1.5px;text-transform:uppercase;">Seleção editorial</span></td></tr></table></td></tr><tr><td style="padding:0 36px;"><div style="height:1px;background:#3a342e;font-size:1px;line-height:1px;">&nbsp;</div></td></tr>${htmlImage}<tr><td class="email-pad" style="padding:26px 36px 22px;">${htmlCategory}<h1 class="email-title" style="margin:0;color:#e8e1d3;font-family:Georgia,'Times New Roman',serif;font-size:38px;line-height:1.08;font-weight:700;letter-spacing:-0.5px;">${escapeHtml(displayTitle)}</h1></td></tr>${htmlNote}${htmlPrice}<tr><td class="email-pad" style="padding:0 36px 12px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="email-cta-cell" align="center" bgcolor="#8a1f1f" style="border-radius:6px;background:#8a1f1f;"><a class="email-cta-link" href="${escapeHtml(offerUrl)}" target="_blank" rel="noopener" style="display:block;padding:15px 20px;color:#fff9f3;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.3;font-weight:700;letter-spacing:1.6px;text-decoration:none;text-transform:uppercase;">Ver oferta</a></td></tr></table></td></tr><tr><td class="email-pad" style="padding:0 36px 30px;"><p class="email-copy" style="margin:0;color:#9b9085;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;text-align:center;">${escapeHtml(microcopy)}</p></td></tr><tr><td style="padding:0 36px;"><div style="height:1px;background:#3a342e;font-size:1px;line-height:1px;">&nbsp;</div></td></tr><tr><td class="email-pad" style="padding:24px 36px 8px;text-align:center;"><p style="margin:0 0 10px;color:#9b9085;font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">Sobre esta seleção</p><p class="email-copy" style="margin:0;color:#e8e1d3;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;">Curadoria direta para encontrar peças e objetos que valem a sua atenção.</p></td></tr>${htmlLinks}<tr><td class="email-pad" style="padding:4px 36px 30px;text-align:center;">${htmlInstitutionalLinks}<p style="margin:0 0 11px;color:#9b9085;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;">${escapeHtml(disclosure)}</p><p style="margin:0;color:#9b9085;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;">Você recebeu esta mensagem porque autorizou comunicações de marketing do Cerberus Finds. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#e8e1d3;text-decoration:underline;">Cancelar inscrição</a>.</p><p style="margin:17px 0 0;color:#5e5148;font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;letter-spacing:1px;">CERBERUS FINDS · CURADORIA INDEPENDENTE</p></td></tr></table></td></tr></table></td></tr></table></td></tr></table></body></html>`;
  const text = [
    "CERBERUS FINDS",
    category?.toUpperCase(),
    displayTitle,
    "",
    textNote(note),
    `Preço verificado: ${verifiedPrice}`,
    previousPrice ? `Preço anterior: ${previousPrice}` : "",
    savings ? `Economia de ${savings}` : "",
    `Ver oferta: ${offerUrl}`,
    microcopy,
    "",
    privacyUrl ? `Política de privacidade: ${privacyUrl}` : "",
    termsUrl ? `Termos e condições: ${termsUrl}` : "",
    ...socialLinks.filter(link => link.url).map(link => `${link.label}: ${link.url}`),
    disclosure,
    "",
    "Você recebeu esta mensagem porque autorizou comunicações de marketing do Cerberus Finds.",
    `Cancelar inscrição: ${unsubscribeUrl}`,
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

function normalizeOptionalText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
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

function normalizeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^https?:\/\/[^\s]+$/i.test(normalized) ? normalized : null;
}

function normalizeSocialLinks(links: readonly NewsletterSocialLink[] | undefined): NewsletterSocialLink[] {
  if (!Array.isArray(links)) return [];
  return links
    .map(link => ({
      label: normalizeOptionalText(link?.label),
      url: normalizeHttpUrl(link?.url) || "",
      icon: normalizeOptionalText(link?.icon),
    }))
    .filter(link => Boolean(link.label))
    .slice(0, 8);
}

function socialMonogram(label: string): string {
  const normalized = label.toLowerCase();
  if (normalized.includes("instagram")) return "IG";
  if (normalized.includes("tiktok")) return "TK";
  if (normalized.includes("facebook")) return "FB";
  if (normalized.includes("youtube")) return "YT";
  if (normalized === "x" || normalized.includes("twitter")) return "X";
  if (normalized.includes("pinterest")) return "PI";
  return label.slice(0, 2).toUpperCase();
}

function textNote(note: string): string {
  return note ? `Por que selecionamos isso? ${note}` : "";
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
