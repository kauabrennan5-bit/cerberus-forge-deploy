import type { Product } from "../../src/types";
import { appendUTMsToUrl } from "../../src/lib/utm";
import {
  isValidProductDestinationUrl,
  resolveCanonicalProductImage,
  toCanonicalProduct,
} from "../../src/lib/productCanonical";
import { buildNewsletterAssetUrl } from "./newsletterInstitutional";
import { getProductDisplayCategory } from "../../src/lib/productPresentation";
import { renderEditorialCollection, type EditorialBlockName, type EditorialCollectionRenderOptions, type EditorialCollectionRenderResult } from "./newsletterCampaignBlocks";

export const UNSUBSCRIBE_URL_PLACEHOLDER = "{{UNSUBSCRIBE_URL}}";

export type NewsletterSocialLink = {
  label: string;
  url: string;
  /** URL absoluta de um asset PNG público, nunca um monograma ou fonte de ícone. */
  iconUrl?: string;
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
  /** Hero editorial previamente validado como limpo; fontes canônicas não são usadas por padrão. */
  heroImageUrl?: string;
  heroImageStatus?: "clean" | "unavailable";
  microcopy?: string;
  includeUnsubscribe?: boolean;
};

export type RenderedNewsletterCampaign = {
  subject: string;
  html: string;
  text: string;
  offerUrl: string;
};

export type NewsletterProductCollectionRenderOptions = {
  trackingCampaignId?: string;
  mastheadImageStatus?: "clean" | "unavailable";
  mastheadAssetUrl?: string;
  mastheadLogoStatus?: "available" | "unavailable";
};

export type NewsletterCollectionCampaignRenderOptions = NewsletterCampaignRenderOptions & {
  mastheadImageStatus?: "clean" | "unavailable";
  mastheadAssetUrl?: string;
  mastheadLogoStatus?: "available" | "unavailable";
  collectionTitle?: string;
  collectionKicker?: string;
  collectionIntro?: string;
  finalBrowseUrl?: string;
  finalBrowseLabel?: string;
};

export type RenderedNewsletterProductCollection = {
  html: string;
  mastheadVariant?: "A" | "B";
  mastheadImageUrl?: string | null;
  mastheadLogoUrl?: string | null;
  text: string;
  offerUrls: string[];
  blockSequence?: EditorialBlockName[];
  imageOverlayStatus?: EditorialCollectionRenderResult["imageOverlayStatus"];
  overlayProductPositions?: number[];
  altCoverage?: EditorialCollectionRenderResult["altCoverage"];
  publicFieldAudit?: EditorialCollectionRenderResult["publicFieldAudit"];
};

const COLORS = {
  body: "#0B0908",
  surface: "#181512",
  border: "#3A342E",
  ivory: "#E8E1D3",
  secondary: "#E8E1D3",
  accent: "#E86B5F",
  red: "#8A1F1F",
  cta: "#C0392B",
  white: "#FFFFFF",
} as const;

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
  const includeUnsubscribe = options.includeUnsubscribe !== false;
  const unsubscribeUrl = includeUnsubscribe ? (options.unsubscribeUrl?.trim() || UNSUBSCRIBE_URL_PLACEHOLDER) : "";
  const imageUrl = options.heroImageStatus === "clean" ? normalizeHttpUrl(options.heroImageUrl) : null;
  const note = normalizeOptionalText(product.curatorNote);
  const description = normalizeOptionalText(product.descricao);
  const offer = normalizeOffer(product.ofertaPromocional);
  const verifiedPrice = formatPrice(offer?.price || product.preco);
  const previousPrice = offer && product.preco > offer.price ? formatPrice(product.preco) : "";
  const savings = offer && product.preco > offer.price ? formatPrice(product.preco - offer.price) : "";
  const viewInBrowserUrl = normalizeHttpUrl(options.viewInBrowserUrl);
  const privacyUrl = normalizeHttpUrl(options.privacyUrl);
  const termsUrl = normalizeHttpUrl(options.termsUrl);
  const socialLinks = normalizeSocialLinks(options.socialLinks);
  const canvasBackgroundUrl = buildNewsletterAssetUrl("assets/newsletter/backgrounds/cerberus-canvas-dark.png");
  const ctaBackgroundUrl = buildNewsletterAssetUrl("assets/newsletter/backgrounds/cerberus-cta-red.png");

  const htmlViewLink = viewInBrowserUrl
    ? `<tr><td align="right" bgcolor="${COLORS.surface}" style="padding:0 0 18px;background:${COLORS.surface};background-color:${COLORS.surface};"><a href="${escapeHtml(viewInBrowserUrl)}" target="_blank" rel="noopener" style="color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;letter-spacing:1.6px;text-decoration:underline;text-transform:uppercase;">${secondaryEmailText("Ver online")}</a></td></tr>`
    : "";

  const htmlImage = imageUrl
    ? `<tr><td class="email-hero-cell" align="center" bgcolor="${COLORS.surface}" style="padding:0 24px 30px;background:${COLORS.surface};background-color:${COLORS.surface};"><img class="email-hero" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(displayTitle)}" width="592" style="display:block;width:100%;max-width:592px;height:auto;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" /></td></tr>`
    : "";

  const htmlCategory = category
    ? `<p class="email-eyebrow" style="margin:0 0 13px;color:${COLORS.accent};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.4;font-weight:700;letter-spacing:2.4px;text-transform:uppercase;">${accentEmailText(escapeHtml(category))}</p>`
    : "";

  const htmlNote = note
    ? `<tr><td class="email-content-cell" bgcolor="${COLORS.surface}" style="padding:0 36px 26px;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};border-top:1px solid ${COLORS.border};border-bottom:1px solid ${COLORS.border};"><tr><td bgcolor="${COLORS.surface}" style="padding:19px 0 18px;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 8px;color:${COLORS.accent};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${accentEmailText("Sobre esta seleção")}</p><p class="email-body-copy" style="margin:0;color:${COLORS.ivory};font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;">${ivoryEmailText(escapeHtml(note))}</p></td></tr></table></td></tr>`
    : "";

  const htmlDescription = description
    ? `<tr><td class="email-content-cell" bgcolor="${COLORS.surface}" style="padding:0 36px 26px;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 8px;color:${COLORS.accent};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${accentEmailText("Detalhes da peça")}</p><p class="email-body-copy" style="margin:0;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.65;">${secondaryEmailText(escapeHtml(description))}</p></td></tr>`
    : "";

  const htmlPrice = `<tr><td class="email-content-cell" bgcolor="${COLORS.surface}" style="padding:0 36px 28px;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-price-card" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};border-top:1px solid ${COLORS.border};border-bottom:1px solid ${COLORS.border};"><tr><td bgcolor="${COLORS.surface}" style="padding:20px 0 19px;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 9px;color:${COLORS.accent};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${accentEmailText("Preço verificado")}</p><p class="email-price" style="margin:0;color:${COLORS.white};font-family:Georgia,'Times New Roman',serif;font-size:32px;line-height:1.1;font-weight:700;">${primaryEmailText(escapeHtml(verifiedPrice))}</p>${previousPrice ? `<p class="email-secondary" style="margin:9px 0 0;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.4;text-decoration:line-through;">${secondaryEmailText(escapeHtml(previousPrice))}</p><p style="margin:5px 0 0;color:${COLORS.accent};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.4;font-weight:700;">${accentEmailText(`Economia de ${escapeHtml(savings)}`)}</p>` : ""}</td></tr></table></td></tr>`;

  const htmlLinks = renderSocialLinks(socialLinks);
  const htmlInstitutionalLinks = privacyUrl || termsUrl
    ? `<p class="email-footer-copy" style="margin:0 0 16px;color:${COLORS.ivory};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;">${privacyUrl ? `<a href="${escapeHtml(privacyUrl)}" target="_blank" rel="noopener" style="color:${COLORS.ivory};text-decoration:underline;">${ivoryEmailText("Política de privacidade")}</a>` : ""}${privacyUrl && termsUrl ? `<font color="${COLORS.ivory}" style="color:${COLORS.ivory}!important;padding:0 8px;">|</font>` : ""}${termsUrl ? `<a href="${escapeHtml(termsUrl)}" target="_blank" rel="noopener" style="color:${COLORS.ivory};text-decoration:underline;">${ivoryEmailText("Termos e condições")}</a>` : ""}</p>`
    : "";
  const htmlUnsubscribe = includeUnsubscribe
    ? `<p class="email-footer-copy" style="margin:0;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.65;">${secondaryEmailText("Você recebeu esta mensagem porque autorizou comunicações de marketing do Cerberus Finds.")} <a href="${escapeHtml(unsubscribeUrl)}" style="color:${COLORS.ivory};text-decoration:underline;">${ivoryEmailText("Cancelar inscrição")}</a>.</p>`
    : `<p class="email-footer-copy" style="margin:0;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.65;">${secondaryEmailText("Você recebeu esta mensagem porque confirmou sua inscrição no Cerberus Finds.")}</p>`;

  const emailStyles = `<style>body{margin:0!important;padding:0!important;background:${COLORS.body}!important;color:${COLORS.secondary}!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}table{border-spacing:0;}img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}a{text-decoration:none;}@media only screen and (max-width:620px){.email-shell{width:100%!important;}.email-pad{padding-left:20px!important;padding-right:20px!important;}.email-hero-cell{padding-left:20px!important;padding-right:20px!important;padding-bottom:24px!important;}.email-title{font-size:32px!important;}.email-price{font-size:28px!important;}.email-content-cell{padding-left:20px!important;padding-right:20px!important;}.email-topline{padding-left:20px!important;padding-right:20px!important;}}@media (prefers-color-scheme:dark){body{background:${COLORS.body}!important;color:${COLORS.ivory}!important;}.email-shell,.email-surface,.email-pad{background:${COLORS.surface}!important;background-color:${COLORS.surface}!important;}.email-title{color:${COLORS.white}!important;-webkit-text-fill-color:${COLORS.white}!important;}.email-body-copy{color:${COLORS.secondary}!important;-webkit-text-fill-color:${COLORS.secondary}!important;}}</style>`;

  const html = protectGmailTextColors(addEmailBackgroundAssets(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">${emailStyles}</head><body bgcolor="${COLORS.body}" style="margin:0;padding:0;background:${COLORS.body};background-color:${COLORS.body};color:${COLORS.secondary};color-scheme:dark;"><span style="display:none!important;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</span><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.body}" style="width:100%;border-collapse:collapse;background:${COLORS.body};background-color:${COLORS.body};"><tr><td align="center" bgcolor="${COLORS.body}" style="padding:0;background:${COLORS.body};background-color:${COLORS.body};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-shell" bgcolor="${COLORS.surface}" style="width:100%;max-width:640px;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr><td class="email-surface" bgcolor="${COLORS.surface}" style="padding:28px 36px 22px;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};">${htmlViewLink}<tr><td align="center" bgcolor="${COLORS.surface}" style="padding:0 0 22px;background:${COLORS.surface};background-color:${COLORS.surface};">${renderNewsletterHeader("Curadoria independente")}</td></tr></table></td></tr>${htmlImage}<tr><td class="email-content-cell" bgcolor="${COLORS.surface}" style="padding:28px 36px 22px;background:${COLORS.surface};background-color:${COLORS.surface};">${htmlCategory}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr><td bgcolor="${COLORS.surface}" style="padding:0;background:${COLORS.surface};background-color:${COLORS.surface};"><h1 class="email-title" style="margin:0;color:${COLORS.white};font-family:Georgia,'Times New Roman',serif;font-size:40px;line-height:1.04;font-weight:700;letter-spacing:-0.6px;">${primaryEmailText(escapeHtml(displayTitle))}</h1></td></tr></table></td></tr>${htmlNote}${htmlDescription}${htmlPrice}<tr><td class="email-content-cell" bgcolor="${COLORS.surface}" style="padding:0 36px 14px;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.cta}" style="width:100%;border-collapse:collapse;background:${COLORS.cta};background-color:${COLORS.cta};"><tr><td class="email-cta-cell" align="center" bgcolor="${COLORS.cta}" style="padding:0;background:${COLORS.cta};background-color:${COLORS.cta};"><a class="email-cta-link" href="${escapeHtml(offerUrl)}" target="_blank" rel="noopener" style="display:block;padding:17px 20px;color:${COLORS.white};font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.3;font-weight:700;letter-spacing:2px;text-decoration:none;text-transform:uppercase;">${ctaEmailText("Ver oferta")}</a></td></tr></table></td></tr><tr><td class="email-content-cell" bgcolor="${COLORS.surface}" style="padding:0 36px 32px;text-align:center;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.65;">${secondaryEmailText(escapeHtml(microcopy))}</p></td></tr>${htmlLinks}<tr><td class="email-content-cell" bgcolor="${COLORS.surface}" style="padding:26px 36px 30px;text-align:center;background:${COLORS.surface};background-color:${COLORS.surface};border-top:1px solid ${COLORS.border};">${htmlInstitutionalLinks}<p class="email-footer-copy" style="margin:0 0 12px;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.65;">${secondaryEmailText(escapeHtml(disclosure))}</p>${htmlUnsubscribe}<p class="email-footer-copy" style="margin:19px 0 0;color:${COLORS.ivory};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:2px;">${ivoryEmailText("CERBERUS FINDS · CURADORIA INDEPENDENTE")}</p></td></tr></table></td></tr></table></td></tr></table></body></html>`, { body: canvasBackgroundUrl, cta: ctaBackgroundUrl }));
  const text = [
    "CERBERUS FINDS",
    category?.toUpperCase(),
    displayTitle,
    "",
    textNote(note),
    description ? `Detalhes da peça: ${description}` : "",
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

function renderLegacyNewsletterProductCollection(
  products: readonly Product[],
  options: NewsletterProductCollectionRenderOptions = {},
): RenderedNewsletterProductCollection {
  if (products.length === 0) throw new Error("NEWSLETTER_COLLECTION_EMPTY");

  const cards = products.map((product, index) => {
    const canonical = toCanonicalProduct(product);
    const image = resolveCanonicalProductImage(product);
    if (!canonical.id.trim() || canonical.title.length < 3 || !Number.isFinite(canonical.price) || canonical.price <= 0) {
      throw new Error(`NEWSLETTER_COLLECTION_PRODUCT_NOT_READY:${product.id || index}`);
    }
    if (image.status !== "ready" || !image.primaryImageUrl) {
      throw new Error(`NEWSLETTER_COLLECTION_PRODUCT_IMAGE_MISSING:${product.id || index}`);
    }
    if (!isValidProductDestinationUrl(canonical.destinationUrl)) {
      throw new Error(`NEWSLETTER_COLLECTION_PRODUCT_DESTINATION_INVALID:${product.id || index}`);
    }

    const offerUrl = options.trackingCampaignId?.trim()
      ? appendUTMsToUrl(canonical.destinationUrl, {
          utm_source: "email",
          utm_medium: "newsletter",
          utm_campaign: options.trackingCampaignId.trim(),
          utm_content: canonical.id,
        })
      : canonical.destinationUrl;
    const offer = normalizeOffer(product.ofertaPromocional);
    const currentPrice = offer?.price || canonical.price;
    const category = getProductDisplayCategory(product);
    const categoryHtml = category
      ? `<p class="email-collection-category" style="margin:0 0 7px;color:${COLORS.accent};font-family:Arial,Helvetica,sans-serif;font-size:9px;line-height:1.35;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;">${accentEmailText(escapeHtml(category))}</p>`
      : "";
    const previousPrice = offer && product.preco > offer.price ? formatPrice(product.preco) : "";
    const priceHtml = `<p style="margin:0;color:${COLORS.white};font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.35;font-weight:700;">${primaryEmailText(escapeHtml(formatPrice(currentPrice)))}</p>${previousPrice ? `<p style="margin:4px 0 0;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.35;text-decoration:line-through;">${secondaryEmailText(escapeHtml(previousPrice))}</p>` : ""}`;
    const cardHtml = (variant: "feature" | "grid") => {
      const imageClass = "email-collection-image";
      const imageWidth = variant === "feature" ? 592 : 286;
      const imageStyle = variant === "feature"
        ? "display:block;width:100%;max-width:592px;height:240px;object-fit:contain;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;"
        : "display:block;width:100%;max-width:286px;height:152px;object-fit:contain;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;";
      const titleSize = variant === "feature" ? 27 : 17;
      const titleLineHeight = variant === "feature" ? "1.08" : "1.14";
      const cardPadding = variant === "feature" ? "18px 0 10px" : "11px 10px 8px";
      const actionPadding = variant === "feature" ? "12px 0 4px" : "9px 0 2px";
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-collection-card email-collection-card-${variant}" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};margin:0;"><tr><td bgcolor="${COLORS.surface}" style="padding:0;background:${COLORS.surface};background-color:${COLORS.surface};"><img class="${imageClass}" src="${escapeHtml(image.primaryImageUrl)}" alt="${escapeHtml(canonical.title)}" width="${imageWidth}" style="${imageStyle}" /></td></tr><tr><td class="email-collection-card-copy" bgcolor="${COLORS.surface}" style="padding:${cardPadding};background:${COLORS.surface};background-color:${COLORS.surface};">${categoryHtml}<h2 class="email-collection-title" style="margin:0;color:${COLORS.white};font-family:Georgia,'Times New Roman',serif;font-size:${titleSize}px;line-height:${titleLineHeight};font-weight:700;">${primaryEmailText(escapeHtml(canonical.title))}</h2><div class="email-collection-price" style="min-height:${variant === "feature" ? "20px" : "19px"};margin-top:8px;">${priceHtml}</div></td></tr><tr><td bgcolor="${COLORS.surface}" style="padding:${actionPadding};background:${COLORS.surface};background-color:${COLORS.surface};"><a href="${escapeHtml(offerUrl)}" target="_blank" rel="noopener" style="display:inline-block;padding:${variant === "feature" ? "13px 18px" : "10px 12px"};background:${COLORS.cta};background-color:${COLORS.cta};color:${COLORS.white};font-family:Arial,Helvetica,sans-serif;font-size:${variant === "feature" ? "12px" : "10px"};line-height:1.3;font-weight:700;letter-spacing:${variant === "feature" ? "1.7px" : "1.3px"};text-decoration:none;text-transform:uppercase;">${ctaEmailText("VER OFERTA")}</a></td></tr></table>`;
    };
    return {
      offerUrl,
      text: `${canonical.title} — ${formatPrice(currentPrice)} — ${offerUrl}`,
      featureHtml: cardHtml("feature"),
      gridHtml: cardHtml("grid"),
    };
  });

  const first = cards[0];
  const pairs: typeof cards[] = [];
  for (let index = 1; index < cards.length; index += 2) pairs.push(cards.slice(index, index + 2));
  const featureHtml = `<tr><td class="email-collection-feature" bgcolor="${COLORS.surface}" style="padding:0 0 24px;background:${COLORS.surface};background-color:${COLORS.surface};">${first.featureHtml}</td></tr>`;
  const gridHtml = pairs.map((pair, pairIndex) => {
    const editorialBreak = pairIndex === 0
      ? `<tr><td colspan="2" class="email-collection-interlude" bgcolor="${COLORS.body}" style="padding:16px 12px 18px;background:${COLORS.body};background-color:${COLORS.body};"><p style="margin:0 0 5px;color:${COLORS.accent};font-family:Arial,Helvetica,sans-serif;font-size:9px;line-height:1.4;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;">${accentEmailText("Olha o que encontramos")}</p><p style="margin:0;color:${COLORS.ivory};font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.25;font-weight:700;">${ivoryEmailText("Peças com presença, escolhidas para sair do óbvio.")}</p></td></tr>`
      : pairIndex === 1
        ? `<tr><td colspan="2" class="email-collection-interlude" bgcolor="${COLORS.body}" style="padding:16px 12px 18px;background:${COLORS.body};background-color:${COLORS.body};"><p style="margin:0 0 5px;color:${COLORS.accent};font-family:Arial,Helvetica,sans-serif;font-size:9px;line-height:1.4;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;">${accentEmailText("Seu próximo achado")}</p><p style="margin:0;color:${COLORS.ivory};font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.25;font-weight:700;">${ivoryEmailText("Qual desses combina com você?")}</p></td></tr>`
        : "";
    return `<tr class="email-collection-grid-row"><td bgcolor="${COLORS.surface}" style="padding:0;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-collection-grid-table" bgcolor="${COLORS.surface}" style="width:100%;table-layout:fixed;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr>${pair.map(card => `<td class="email-collection-grid-cell" width="50%" valign="top" bgcolor="${COLORS.surface}" style="width:50%;padding:0 6px 18px;background:${COLORS.surface};background-color:${COLORS.surface};">${card.gridHtml}</td>`).join("")}${pair.length === 1 ? `<td class="email-collection-grid-cell email-collection-grid-spacer" width="50%" bgcolor="${COLORS.surface}" style="width:50%;padding:0 6px 18px;background:${COLORS.surface};background-color:${COLORS.surface};">&nbsp;</td>` : ""}</tr>${editorialBreak}</table></td></tr>`;
  }).join("");

  return {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};">${featureHtml}${gridHtml}</table>`,
    text: cards.map((card, index) => `${String(index + 1).padStart(2, "0")}. ${card.text}`).join("\\n"),
    offerUrls: cards.map(card => card.offerUrl),
  };
}

export function renderNewsletterProductCollection(
  products: readonly Product[],
  options: NewsletterProductCollectionRenderOptions = {},
): RenderedNewsletterProductCollection {
  const rendered: EditorialCollectionRenderResult = renderEditorialCollection(products, options as EditorialCollectionRenderOptions);
  return rendered;
}

export function renderNewsletterCollectionCampaign(
  products: readonly Product[],
  options: NewsletterCollectionCampaignRenderOptions = {},
): RenderedNewsletterCampaign {
  if (products.length === 0) throw new Error("NEWSLETTER_COLLECTION_EMPTY");
  const collectionTitle = normalizeRequiredText(options.collectionTitle || `${products.length} NOVOS ACHADOS`, "collectionTitle");
  const collectionKicker = normalizeRequiredText(options.collectionKicker || "Novidades", "collectionKicker");
  const collectionIntro = normalizeRequiredText(options.collectionIntro || "Produtos que acabaram de entrar na curadoria da Cerberus Finds.", "collectionIntro");
  const trackingCampaignId = options.trackingCampaignId?.trim();
  const renderedCollection = renderNewsletterProductCollection(products, {
    trackingCampaignId,
    mastheadImageStatus: options.mastheadImageStatus,
    mastheadAssetUrl: options.mastheadAssetUrl,
    mastheadLogoStatus: options.mastheadLogoStatus,
  });
  const subject = normalizeRequiredText(options.subject || `Novidades da semana: ${collectionTitle}`, "subject");
  const preheader = normalizeRequiredText(options.preheader || collectionIntro, "preheader");
  const disclosure = normalizeRequiredText(options.disclosure || DEFAULT_DISCLOSURE, "disclosure");
  const includeUnsubscribe = options.includeUnsubscribe !== false;
  const unsubscribeUrl = includeUnsubscribe ? (options.unsubscribeUrl?.trim() || UNSUBSCRIBE_URL_PLACEHOLDER) : "";
  const viewInBrowserUrl = normalizeHttpUrl(options.viewInBrowserUrl);
  const privacyUrl = normalizeHttpUrl(options.privacyUrl);
  const termsUrl = normalizeHttpUrl(options.termsUrl);
  const socialLinks = normalizeSocialLinks(options.socialLinks);
  const finalBrowseUrl = normalizeHttpUrl(options.finalBrowseUrl);
  const finalBrowseLabel = normalizeRequiredText(options.finalBrowseLabel || "VER TODAS AS NOVIDADES", "finalBrowseLabel");
  const canvasBackgroundUrl = buildNewsletterAssetUrl("assets/newsletter/backgrounds/cerberus-canvas-dark.png");
  const ctaBackgroundUrl = buildNewsletterAssetUrl("assets/newsletter/backgrounds/cerberus-cta-red.png");
  const htmlViewLink = viewInBrowserUrl
    ? `<tr><td align="right" bgcolor="${COLORS.surface}" style="padding:0 0 18px;background:${COLORS.surface};background-color:${COLORS.surface};"><a href="${escapeHtml(viewInBrowserUrl)}" target="_blank" rel="noopener" style="color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;letter-spacing:1.6px;text-decoration:underline;text-transform:uppercase;">${secondaryEmailText("Ver online")}</a></td></tr>`
    : "";
  const htmlInstitutionalLinks = privacyUrl || termsUrl
    ? `<p class="email-footer-copy" style="margin:0 0 16px;color:${COLORS.ivory};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;">${privacyUrl ? `<a href="${escapeHtml(privacyUrl)}" target="_blank" rel="noopener" style="color:${COLORS.ivory};text-decoration:underline;">${ivoryEmailText("Política de privacidade")}</a>` : ""}${privacyUrl && termsUrl ? `<font color="${COLORS.ivory}" style="color:${COLORS.ivory}!important;padding:0 8px;">|</font>` : ""}${termsUrl ? `<a href="${escapeHtml(termsUrl)}" target="_blank" rel="noopener" style="color:${COLORS.ivory};text-decoration:underline;">${ivoryEmailText("Termos e condições")}</a>` : ""}</p>`
    : "";
  const htmlUnsubscribe = includeUnsubscribe
    ? `<p class="email-footer-copy" style="margin:0;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.65;">${secondaryEmailText("Você recebeu esta mensagem porque autorizou comunicações de marketing do Cerberus Finds.")} <a href="${escapeHtml(unsubscribeUrl)}" style="color:${COLORS.ivory};text-decoration:underline;">${ivoryEmailText("Cancelar inscrição")}</a>.</p>`
    : `<p class="email-footer-copy" style="margin:0;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.65;">${secondaryEmailText("Você recebeu esta mensagem porque confirmou sua inscrição no Cerberus Finds.")}</p>`;
  const htmlLinks = renderSocialLinks(socialLinks);
  const finalCta = finalBrowseUrl
    ? `<tr><td class="email-content-cell email-editorial-closure" align="center" bgcolor="${COLORS.surface}" style="padding:12px 36px 38px;text-align:center;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 8px;color:${COLORS.accent};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:2.2px;text-transform:uppercase;">${accentEmailText("Continue descobrindo")}</p><p style="margin:0 0 18px;color:${COLORS.ivory};font-family:Georgia,'Times New Roman',serif;font-size:19px;line-height:1.35;font-weight:700;">${ivoryEmailText("A curadoria continua sendo atualizada.")}</p><a href="${escapeHtml(finalBrowseUrl)}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 18px;background:${COLORS.cta};background-color:${COLORS.cta};color:${COLORS.white};font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.3;font-weight:700;letter-spacing:1.6px;text-decoration:none;text-transform:uppercase;">${ctaEmailText(escapeHtml(finalBrowseLabel))}</a></td></tr>`
    : `<tr><td class="email-content-cell email-editorial-closure" align="center" bgcolor="${COLORS.surface}" style="padding:12px 36px 38px;text-align:center;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 8px;color:${COLORS.accent};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:2.2px;text-transform:uppercase;">${accentEmailText("Continue descobrindo")}</p><p style="margin:0;color:${COLORS.ivory};font-family:Georgia,'Times New Roman',serif;font-size:19px;line-height:1.35;font-weight:700;">${ivoryEmailText("A curadoria continua sendo atualizada.")}</p></td></tr>`;
  const emailStyles = `<style>body{margin:0!important;padding:0!important;background:${COLORS.body}!important;color:${COLORS.secondary}!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}table{border-spacing:0;}img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}a{text-decoration:none;}@media only screen and (max-width:620px){.email-shell{width:100%!important;}.email-pad,.email-content-cell{padding-left:20px!important;padding-right:20px!important;}.email-collection-grid-cell{padding:0 4px 16px!important;vertical-align:top!important;}.email-collection-grid-spacer{display:none!important;}.email-collection-feature .email-collection-image{height:220px!important;max-height:220px!important;}.email-collection-hero-meta{display:block!important;width:100%!important;}.email-collection-hero-meta tr{display:block!important;width:100%!important;}.email-collection-hero-copy,.email-collection-hero-action{display:block!important;width:100%!important;padding:0!important;text-align:left!important;}.email-collection-hero-action{padding-top:14px!important;}.email-collection-grid-image-cell{height:118px!important;}.email-collection-grid-image-cell img{height:96px!important;max-height:96px!important;}.email-collection-grid-title{height:58px!important;}.email-collection-grid-title .email-collection-title{font-size:14px!important;line-height:1.16!important;}.email-collection-grid-price{height:29px!important;padding-top:5px!important;}.email-collection-grid-action{height:40px!important;padding-top:1px!important;}.email-collection-grid-action a{font-size:9px!important;padding:8px 8px!important;letter-spacing:1px!important;}.email-collection-horizontal-table,.email-collection-horizontal-table tbody,.email-collection-horizontal-table tr{display:block!important;width:100%!important;}.email-collection-horizontal-image,.email-collection-horizontal-copy{display:block!important;width:100%!important;padding:14px 0!important;text-align:left!important;}.email-collection-horizontal-image{text-align:center!important;}.email-collection-horizontal-image img{height:150px!important;max-height:150px!important;}.email-collection-compact-copy{padding-left:0!important;}.email-collection-card a{font-size:9px!important;padding:8px 8px!important;letter-spacing:1px!important;}.email-editorial-closure{padding-left:20px!important;padding-right:20px!important;}.email-masthead{padding-bottom:28px!important;}.email-masthead-brand-mark{width:170px!important;height:170px!important;}.email-masthead-logo{width:156px!important;height:156px!important;}.email-masthead-fallback{width:90px!important;height:90px!important;line-height:90px!important;font-size:24px!important;}.email-welcome-brand-mark{width:170px!important;height:170px!important;}.email-welcome-logo{width:156px!important;height:156px!important;}.email-welcome-fallback{width:90px!important;height:90px!important;line-height:90px!important;font-size:24px!important;}.email-masthead-edition{width:62px!important;}.email-masthead-b .email-masthead-copy,.email-masthead-b .email-masthead-image{display:block!important;width:100%!important;}.email-masthead-b .email-masthead-copy{padding:0 0 18px!important;}.email-masthead-b .email-masthead-image{padding:0!important;text-align:left!important;}.email-masthead-headline{font-size:30px!important;line-height:1.04!important;}}@media only screen and (max-width:374px){.email-collection-grid-table,.email-collection-grid-table tbody,.email-collection-grid-table tr{display:block!important;width:100%!important;}.email-collection-grid-cell{display:block!important;width:100%!important;padding:0 0 16px!important;}.email-collection-grid-spacer{display:none!important;}}@media (prefers-color-scheme:dark){body{background:${COLORS.body}!important;color:${COLORS.ivory}!important;}.email-shell,.email-surface,.email-pad,.email-collection-grid-table,.email-collection-grid-card,.email-collection-horizontal-table,.email-collection-compact-copy{background:${COLORS.surface}!important;background-color:${COLORS.surface}!important;}.email-collection-title{color:${COLORS.white}!important;-webkit-text-fill-color:${COLORS.white}!important;}.editorial-micro{background:${COLORS.surface}!important;background-color:${COLORS.surface}!important;}}</style>`;
  const html = protectGmailTextColors(addEmailBackgroundAssets(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">${emailStyles}</head><body bgcolor="${COLORS.body}" style="margin:0;padding:0;background:${COLORS.body};background-color:${COLORS.body};color:${COLORS.secondary};color-scheme:dark;"><span style="display:none!important;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</span><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.body}" style="width:100%;border-collapse:collapse;background:${COLORS.body};background-color:${COLORS.body};"><tr><td align="center" bgcolor="${COLORS.body}" style="padding:0;background:${COLORS.body};background-color:${COLORS.body};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-shell" bgcolor="${COLORS.surface}" style="width:100%;max-width:640px;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr><td class="email-surface" bgcolor="${COLORS.surface}" style="padding:28px 36px 0;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};">${htmlViewLink}</table></td></tr><tr><td class="email-content-cell" bgcolor="${COLORS.surface}" style="padding:0 36px 10px;background:${COLORS.surface};background-color:${COLORS.surface};">${renderedCollection.html}</td></tr>${finalCta}${htmlLinks}<tr><td class="email-content-cell" bgcolor="${COLORS.surface}" style="padding:26px 36px 30px;text-align:center;background:${COLORS.surface};background-color:${COLORS.surface};border-top:1px solid ${COLORS.border};">${htmlInstitutionalLinks}<p class="email-footer-copy" style="margin:0 0 12px;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.65;">${secondaryEmailText(escapeHtml(disclosure))}</p>${htmlUnsubscribe}<p class="email-footer-copy" style="margin:19px 0 0;color:${COLORS.ivory};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:2px;">${ivoryEmailText("CERBERUS FINDS · CURADORIA INDEPENDENTE")}</p></td></tr></table></td></tr></table></td></tr></table></body></html>`, { body: canvasBackgroundUrl, cta: ctaBackgroundUrl }));
  const text = [
    "CERBERUS FINDS",
    collectionKicker.toUpperCase(),
    collectionTitle,
    collectionIntro,
    "",
    renderedCollection.text,
    "",
    finalBrowseUrl ? `${finalBrowseLabel}: ${finalBrowseUrl}` : "Continue acompanhando as próximas descobertas da Cerberus Finds.",
    privacyUrl ? `Política de privacidade: ${privacyUrl}` : "",
    termsUrl ? `Termos e condições: ${termsUrl}` : "",
    ...socialLinks.filter(link => link.url).map(link => `${link.label}: ${link.url}`),
    disclosure,
    "",
    "Você recebeu esta mensagem porque autorizou comunicações de marketing do Cerberus Finds.",
    `Cancelar inscrição: ${unsubscribeUrl}`,
  ].filter(Boolean).join("\\n");
  return { subject, html, text, offerUrl: renderedCollection.offerUrls[0] || "" };
}

export function renderNewsletterWelcomeCampaign(
  options: NewsletterCampaignRenderOptions = {},
): RenderedNewsletterCampaign {
  const subject = normalizeRequiredText(options.subject || "Bem-vindo à Cerberus Finds", "subject");
  const preheader = normalizeRequiredText(options.preheader || "Você agora faz parte da lista editorial da Cerberus Finds.", "preheader");
  const disclosure = normalizeRequiredText(options.disclosure || DEFAULT_DISCLOSURE, "disclosure");
  const includeUnsubscribe = options.includeUnsubscribe !== false;
  const unsubscribeUrl = includeUnsubscribe ? (options.unsubscribeUrl?.trim() || UNSUBSCRIBE_URL_PLACEHOLDER) : "";
  const viewInBrowserUrl = normalizeHttpUrl(options.viewInBrowserUrl);
  const privacyUrl = normalizeHttpUrl(options.privacyUrl);
  const termsUrl = normalizeHttpUrl(options.termsUrl);
  const socialLinks = normalizeSocialLinks(options.socialLinks);
  const canvasBackgroundUrl = buildNewsletterAssetUrl("assets/newsletter/backgrounds/cerberus-canvas-dark.png");
  const ctaBackgroundUrl = buildNewsletterAssetUrl("assets/newsletter/backgrounds/cerberus-cta-red.png");
  const htmlViewLink = viewInBrowserUrl
    ? `<tr><td align="right" bgcolor="${COLORS.surface}" style="padding:0 0 18px;background:${COLORS.surface};background-color:${COLORS.surface};"><a href="${escapeHtml(viewInBrowserUrl)}" target="_blank" rel="noopener" style="color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;letter-spacing:1.6px;text-decoration:underline;text-transform:uppercase;">${secondaryEmailText("Ver online")}</a></td></tr>`
    : "";
  const htmlLinks = renderSocialLinks(socialLinks);
  const htmlInstitutionalLinks = privacyUrl || termsUrl
    ? `<p class="email-footer-copy" style="margin:0 0 16px;color:${COLORS.ivory};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;">${privacyUrl ? `<a href="${escapeHtml(privacyUrl)}" target="_blank" rel="noopener" style="color:${COLORS.ivory};text-decoration:underline;">${ivoryEmailText("Política de privacidade")}</a>` : ""}${privacyUrl && termsUrl ? `<font color="${COLORS.ivory}" style="color:${COLORS.ivory}!important;padding:0 8px;">|</font>` : ""}${termsUrl ? `<a href="${escapeHtml(termsUrl)}" target="_blank" rel="noopener" style="color:${COLORS.ivory};text-decoration:underline;">${ivoryEmailText("Termos e condições")}</a>` : ""}</p>`
    : "";
  const htmlUnsubscribe = includeUnsubscribe
    ? `<p class="email-footer-copy" style="margin:0;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.65;">${secondaryEmailText("Você recebeu esta mensagem porque autorizou comunicações de marketing do Cerberus Finds.")} <a href="${escapeHtml(unsubscribeUrl)}" style="color:${COLORS.ivory};text-decoration:underline;">${ivoryEmailText("Cancelar inscrição")}</a>.</p>`
    : `<p class="email-footer-copy" style="margin:0;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.65;">${secondaryEmailText("Você recebeu esta mensagem porque confirmou sua inscrição no Cerberus Finds.")}</p>`;
  const emailStyles = `<style>body{margin:0!important;padding:0!important;background:${COLORS.body}!important;color:${COLORS.secondary}!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}table{border-spacing:0;}img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}a{text-decoration:none;}@media only screen and (max-width:620px){.email-shell{width:100%!important;}.email-pad,.email-content-cell{padding-left:20px!important;padding-right:20px!important;}.email-welcome-brand-mark{width:170px!important;height:170px!important;}.email-welcome-logo{width:156px!important;height:156px!important;}.email-welcome-fallback{width:90px!important;height:90px!important;line-height:90px!important;font-size:24px!important;}.email-title{font-size:32px!important;}.email-body-copy{font-size:15px!important;}}@media (prefers-color-scheme:dark){body{background:${COLORS.body}!important;color:${COLORS.ivory}!important;}.email-shell,.email-surface,.email-pad{background:${COLORS.surface}!important;background-color:${COLORS.surface}!important;}.email-title{color:${COLORS.white}!important;-webkit-text-fill-color:${COLORS.white}!important;}.email-body-copy{color:${COLORS.secondary}!important;-webkit-text-fill-color:${COLORS.secondary}!important;}}</style>`;
  const html = protectGmailTextColors(addEmailBackgroundAssets(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">${emailStyles}</head><body bgcolor="${COLORS.body}" style="margin:0;padding:0;background:${COLORS.body};background-color:${COLORS.body};color:${COLORS.secondary};color-scheme:dark;"><span style="display:none!important;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</span><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.body}" style="width:100%;border-collapse:collapse;background:${COLORS.body};background-color:${COLORS.body};"><tr><td align="center" bgcolor="${COLORS.body}" style="padding:0;background:${COLORS.body};background-color:${COLORS.body};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-shell" bgcolor="${COLORS.surface}" style="width:100%;max-width:640px;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr><td class="email-surface" bgcolor="${COLORS.surface}" style="padding:28px 36px 24px;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};">${htmlViewLink}<tr><td align="center" bgcolor="${COLORS.surface}" style="padding:0 0 22px;background:${COLORS.surface};background-color:${COLORS.surface};">${renderNewsletterHeader("Curadoria independente")}</td></tr><tr><td bgcolor="${COLORS.surface}" style="padding:30px 0 4px;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 12px;color:${COLORS.accent};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:2.4px;text-transform:uppercase;">${accentEmailText("Boas-vindas")}</p><h1 class="email-title" style="margin:0 0 22px;color:${COLORS.white};font-family:Georgia,'Times New Roman',serif;font-size:42px;line-height:1.05;font-weight:700;letter-spacing:-0.6px;">${primaryEmailText("Bem-vindo à")}<br>${primaryEmailText("Cerberus Finds")}</h1><p class="email-body-copy" style="margin:0;color:${COLORS.white};font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.65;">${primaryEmailText("Sua inscrição foi confirmada. A partir de agora, você receberá novas seleções, recomendações e ofertas escolhidas com olhar curatorial.")}</p><p class="email-body-copy" style="margin:18px 0 0;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;">${secondaryEmailText("A proposta é simples: menos ruído, mais achados que merecem a sua atenção. Quando uma seleção fizer sentido, ela chegará até você com contexto, transparência e um caminho claro para conhecer a oferta.")}</p></td></tr></table></td></tr><tr><td bgcolor="${COLORS.surface}" style="padding:0 36px 28px;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};border-top:1px solid ${COLORS.border};border-bottom:1px solid ${COLORS.border};"><tr><td bgcolor="${COLORS.surface}" style="padding:19px 0;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 8px;color:${COLORS.accent};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${accentEmailText("O que você pode esperar")}</p><p class="email-body-copy" style="margin:0;color:${COLORS.ivory};font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;">${ivoryEmailText("Seleções editoriais, recomendações e ofertas de parceiros, sempre com identificação da operação, disclosure de afiliado e opção de descadastro individual.")}</p></td></tr></table></td></tr>${htmlLinks}<tr><td class="email-content-cell" bgcolor="${COLORS.surface}" style="padding:26px 36px 30px;text-align:center;background:${COLORS.surface};background-color:${COLORS.surface};border-top:1px solid ${COLORS.border};">${htmlInstitutionalLinks}<p class="email-footer-copy" style="margin:0 0 12px;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.65;">${secondaryEmailText(escapeHtml(disclosure))}</p>${htmlUnsubscribe}<p class="email-footer-copy" style="margin:19px 0 0;color:${COLORS.ivory};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:2px;">${ivoryEmailText("CERBERUS FINDS · CURADORIA INDEPENDENTE")}</p></td></tr></table></td></tr></table></td></tr></table></body></html>`, { body: canvasBackgroundUrl, cta: ctaBackgroundUrl }));
  const text = [
    "CERBERUS FINDS",
    "BOAS-VINDAS",
    "Bem-vindo à Cerberus Finds",
    "",
    "Sua inscrição foi confirmada.",
    "A partir de agora, você receberá novas seleções, recomendações e ofertas escolhidas com olhar curatorial.",
    "",
    includeUnsubscribe
      ? "Você recebeu esta mensagem porque autorizou comunicações de marketing do Cerberus Finds."
      : "Você recebeu esta mensagem porque confirmou sua inscrição no Cerberus Finds.",
    privacyUrl ? `Política de privacidade: ${privacyUrl}` : "",
    termsUrl ? `Termos e condições: ${termsUrl}` : "",
    disclosure,
    ...(includeUnsubscribe ? [`Cancelar inscrição: ${unsubscribeUrl}`] : []),
  ].filter(Boolean).join("\n");
  return { subject, html, text, offerUrl: "" };
}

export function resolveCampaignOfferUrl(
  product: Pick<Product, "link" | "paginaPonteUrl">,
): string {
  const candidate = (product.paginaPonteUrl || product.link || "").trim();
  if (!/^https?:\/\/[^\s]+$/i.test(candidate)) {
    throw new Error("CAMPAIGN_OFFER_URL_INVALID");
  }
  return candidate;
}

function addEmailBackgroundAssets(
  html: string,
  assets: { body: string; cta: string },
): string {
  const byColor: Record<string, string> = {
    [COLORS.body]: assets.body,
    [COLORS.cta]: assets.cta,
  };
  return html.replace(/<(body|table|td)([^>]*)>/gi, (full, tag: string, attributes: string) => {
    const match = attributes.match(/\bbgcolor=["'](#[0-9a-f]+)["']/i);
    const backgroundUrl = match ? byColor[match[1].toUpperCase()] : undefined;
    if (!backgroundUrl || /\bbackground=["']/i.test(attributes)) return full;
    const escapedUrl = escapeHtml(backgroundUrl);
    const withBackgroundAttribute = ` background="${escapedUrl}"${attributes}`;
    const withBackgroundImage = /\bstyle=["'][^"']*["']/i.test(withBackgroundAttribute)
      ? withBackgroundAttribute.replace(/\bstyle=["']([^"']*)["']/i, (_styleMatch, style: string) =>
        `style="${style};background-image:url('${escapedUrl}');background-repeat:repeat;"`)
      : `${withBackgroundAttribute} style="background-image:url('${escapedUrl}');background-repeat:repeat;"`;
    return `<${tag}${withBackgroundImage}>`;
  });
}

function protectGmailTextColors(html: string): string {
  const colors = Object.values(COLORS);
  return colors.reduce((output, color) => output
    .replaceAll(`;color:${color}!important;`, `;color:${color}!important;-webkit-text-fill-color:${color}!important;`)
    .replaceAll(`;color:${color};`, `;color:${color}!important;-webkit-text-fill-color:${color}!important;`), html);
}

function normalizeRequiredText(value: string, field: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error(`CAMPAIGN_${field.toUpperCase()}_REQUIRED`);
  return normalized;
}

function normalizeOptionalText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
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
      iconUrl: normalizeHttpUrl(link?.iconUrl) || defaultSocialIconUrl(link?.label),
    }))
    .filter(link => Boolean(link.label))
    .slice(0, 8);
}

function renderNewsletterHeader(tagline: string): string {
  const logoUrl = buildNewsletterAssetUrl("assets/newsletter/branding/cerberus-logo-square.png");
  const brandMark = logoUrl
    ? `<img class="email-welcome-logo" src="${escapeHtml(logoUrl)}" width="156" height="156" alt="Logo Cerberus Finds" style="display:block;width:156px;height:156px;object-fit:contain;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" />`
    : `<span class="email-welcome-fallback" style="display:block;width:90px;height:90px;background:${COLORS.red};background-color:${COLORS.red};color:${COLORS.white};font:700 24px/90px Arial,Helvetica,sans-serif;text-align:center;">${ctaEmailText("CF")}</span>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr><td align="center" bgcolor="${COLORS.surface}" style="padding:0;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr><td class="email-welcome-brand-mark" width="170" height="170" align="center" valign="middle" bgcolor="${COLORS.surface}" style="width:170px;height:170px;background:${COLORS.surface};background-color:${COLORS.surface};">${brandMark}</td><td width="10" bgcolor="${COLORS.surface}" style="width:10px;font-size:0;line-height:0;background:${COLORS.surface};background-color:${COLORS.surface};">&nbsp;</td><td valign="middle" bgcolor="${COLORS.surface}" style="background:${COLORS.surface};background-color:${COLORS.surface};color:${COLORS.ivory};font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:34px;font-weight:700;letter-spacing:2.4px;white-space:nowrap;">${ivoryEmailText("CERBERUS FINDS")}</td></tr></table><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr><td align="center" bgcolor="${COLORS.surface}" style="padding:16px 0 0;background:${COLORS.surface};background-color:${COLORS.surface};border-top:1px solid ${COLORS.border};"><p style="margin:0;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${secondaryEmailText(escapeHtml(tagline))}</p></td></tr></table></td></tr></table>`;
}

function renderSocialLinks(links: NewsletterSocialLink[]): string {
  const items = links
    .filter(link => Boolean(link.iconUrl))
    .map(link => {
      const icon = `<img src="${escapeHtml(link.iconUrl || "")}" width="24" height="24" alt="${escapeHtml(link.label)}" style="display:block;width:24px;height:24px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" />`;
      const item = link.url
        ? `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener" aria-label="${escapeHtml(link.label)}" style="display:block;text-decoration:none;">${icon}</a>`
        : `<div aria-label="${escapeHtml(link.label)} ainda não configurado">${icon}</div>`;
      return `<td width="32" height="32" valign="middle" align="center" bgcolor="${COLORS.surface}" style="width:32px;height:32px;padding:3px;background:${COLORS.surface};background-color:${COLORS.surface};border:1px solid ${COLORS.border};">${item}</td>`;
    })
    .join("");
  if (!items) return "";
  return `<tr><td class="email-content-cell" align="center" bgcolor="${COLORS.surface}" style="padding:0 36px 24px;text-align:center;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 12px;color:${COLORS.accent};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.5;letter-spacing:2px;text-transform:uppercase;">${accentEmailText("Encontre a Cerberus Finds")}</p><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" bgcolor="${COLORS.surface}" style="border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr>${items}</tr></table></td></tr>`;
}

function defaultSocialIconUrl(label: unknown): string {
  const normalized = normalizeOptionalText(label).toLowerCase();
  const network = normalized.includes("instagram")
    ? "instagram"
    : normalized.includes("tiktok")
      ? "tiktok"
      : normalized.includes("facebook")
        ? "facebook"
        : normalized.includes("youtube")
          ? "youtube"
          : normalized === "x" || normalized.includes("twitter")
            ? "x"
            : normalized.includes("pinterest")
              ? "pinterest"
              : "";
  return network ? buildNewsletterAssetUrl(`assets/newsletter/social/${network}.png`) : "";
}

function textNote(note: string): string {
  return note ? `Sobre esta seleção: ${note}` : "";
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

function primaryEmailText(value: string): string {
  return `<font color="${COLORS.white}" style="color:${COLORS.white}!important;-webkit-text-fill-color:${COLORS.white}!important;">${value}</font>`;
}

function ivoryEmailText(value: string): string {
  return `<font color="${COLORS.ivory}" style="color:${COLORS.ivory}!important;-webkit-text-fill-color:${COLORS.ivory}!important;">${value}</font>`;
}

function secondaryEmailText(value: string): string {
  return `<font color="${COLORS.secondary}" style="color:${COLORS.secondary}!important;-webkit-text-fill-color:${COLORS.secondary}!important;">${value}</font>`;
}

function accentEmailText(value: string): string {
  return `<font color="${COLORS.accent}" style="color:${COLORS.accent}!important;-webkit-text-fill-color:${COLORS.accent}!important;">${value}</font>`;
}

function ctaEmailText(value: string): string {
  return `<font color="${COLORS.white}" style="color:${COLORS.white}!important;-webkit-text-fill-color:${COLORS.white}!important;">${value}</font>`;
}
