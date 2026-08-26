import type { Product } from "../../src/types";
import { appendUTMsToUrl } from "../../src/lib/utm";

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

const COLORS = {
  body: "#0B0908",
  surface: "#181512",
  border: "#3A342E",
  ivory: "#E8E1D3",
  secondary: "#B8B0A3",
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

  const htmlViewLink = viewInBrowserUrl
    ? `<tr><td align="right" bgcolor="${COLORS.surface}" style="padding:0 0 18px;background:${COLORS.surface};background-color:${COLORS.surface};"><a href="${escapeHtml(viewInBrowserUrl)}" target="_blank" rel="noopener" style="color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;letter-spacing:1.6px;text-decoration:underline;text-transform:uppercase;">${secondaryEmailText("Ver online")}</a></td></tr>`
    : "";

  const htmlImage = imageUrl
    ? `<tr><td class="email-hero-cell" align="center" bgcolor="${COLORS.surface}" style="padding:0 24px 30px;background:${COLORS.surface};background-color:${COLORS.surface};"><img class="email-hero" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(displayTitle)}" width="592" style="display:block;width:100%;max-width:592px;height:auto;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" /></td></tr>`
    : "";

  const htmlCategory = category
    ? `<p class="email-eyebrow" style="margin:0 0 13px;color:${COLORS.cta};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.4;font-weight:700;letter-spacing:2.4px;text-transform:uppercase;">${accentEmailText(escapeHtml(category))}</p>`
    : "";

  const htmlNote = note
    ? `<tr><td class="email-content-cell" bgcolor="${COLORS.surface}" style="padding:0 36px 26px;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};border-top:1px solid ${COLORS.border};border-bottom:1px solid ${COLORS.border};"><tr><td bgcolor="${COLORS.surface}" style="padding:19px 0 18px;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 8px;color:${COLORS.cta};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${accentEmailText("Sobre esta seleção")}</p><p class="email-body-copy" style="margin:0;color:${COLORS.ivory};font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;">${ivoryEmailText(escapeHtml(note))}</p></td></tr></table></td></tr>`
    : "";

  const htmlDescription = description
    ? `<tr><td class="email-content-cell" bgcolor="${COLORS.surface}" style="padding:0 36px 26px;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 8px;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${secondaryEmailText("Detalhes da peça")}</p><p class="email-body-copy" style="margin:0;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.65;">${secondaryEmailText(escapeHtml(description))}</p></td></tr>`
    : "";

  const htmlPrice = `<tr><td class="email-content-cell" bgcolor="${COLORS.surface}" style="padding:0 36px 28px;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-price-card" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};border-top:1px solid ${COLORS.border};border-bottom:1px solid ${COLORS.border};"><tr><td bgcolor="${COLORS.surface}" style="padding:20px 0 19px;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 9px;color:${COLORS.cta};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${accentEmailText("Preço verificado")}</p><p class="email-price" style="margin:0;color:${COLORS.ivory};font-family:Georgia,'Times New Roman',serif;font-size:32px;line-height:1.1;font-weight:700;">${ivoryEmailText(escapeHtml(verifiedPrice))}</p>${previousPrice ? `<p class="email-secondary" style="margin:9px 0 0;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.4;text-decoration:line-through;">${secondaryEmailText(escapeHtml(previousPrice))}</p><p style="margin:5px 0 0;color:${COLORS.cta};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.4;font-weight:700;">${accentEmailText(`Economia de ${escapeHtml(savings)}`)}</p>` : ""}</td></tr></table></td></tr>`;

  const htmlLinks = renderSocialLinks(socialLinks);
  const htmlInstitutionalLinks = privacyUrl || termsUrl
    ? `<p class="email-footer-copy" style="margin:0 0 16px;color:${COLORS.ivory};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;">${privacyUrl ? `<a href="${escapeHtml(privacyUrl)}" target="_blank" rel="noopener" style="color:${COLORS.ivory};text-decoration:underline;">${ivoryEmailText("Política de privacidade")}</a>` : ""}${privacyUrl && termsUrl ? `<font color="${COLORS.ivory}" style="color:${COLORS.ivory}!important;padding:0 8px;">|</font>` : ""}${termsUrl ? `<a href="${escapeHtml(termsUrl)}" target="_blank" rel="noopener" style="color:${COLORS.ivory};text-decoration:underline;">${ivoryEmailText("Termos e condições")}</a>` : ""}</p>`
    : "";
  const htmlUnsubscribe = includeUnsubscribe
    ? `<p class="email-footer-copy" style="margin:0;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.65;">${secondaryEmailText("Você recebeu esta mensagem porque autorizou comunicações de marketing do Cerberus Finds.")} <a href="${escapeHtml(unsubscribeUrl)}" style="color:${COLORS.ivory};text-decoration:underline;">${ivoryEmailText("Cancelar inscrição")}</a>.</p>`
    : `<p class="email-footer-copy" style="margin:0;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.65;">${secondaryEmailText("Você recebeu esta mensagem porque confirmou sua inscrição no Cerberus Finds.")}</p>`;

  const emailStyles = `<style>body{margin:0!important;padding:0!important;background:${COLORS.body}!important;color:${COLORS.ivory}!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}table{border-spacing:0;}img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}a{text-decoration:none;}@media only screen and (max-width:620px){.email-shell{width:100%!important;}.email-pad{padding-left:20px!important;padding-right:20px!important;}.email-hero-cell{padding-left:20px!important;padding-right:20px!important;padding-bottom:24px!important;}.email-title{font-size:32px!important;}.email-price{font-size:28px!important;}.email-content-cell{padding-left:20px!important;padding-right:20px!important;}.email-topline{padding-left:20px!important;padding-right:20px!important;}}@media (prefers-color-scheme:dark){body{background:${COLORS.body}!important;color:${COLORS.ivory}!important;}.email-shell,.email-surface,.email-pad{background:${COLORS.surface}!important;background-color:${COLORS.surface}!important;}.email-title,.email-body-copy{color:${COLORS.ivory}!important;-webkit-text-fill-color:${COLORS.ivory}!important;}}</style>`;

  const html = protectGmailTextColors(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">${emailStyles}</head><body bgcolor="${COLORS.body}" style="margin:0;padding:0;background:${COLORS.body};background-color:${COLORS.body};color:${COLORS.ivory};color-scheme:dark;"><span style="display:none!important;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</span><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.body}" style="width:100%;border-collapse:collapse;background:${COLORS.body};background-color:${COLORS.body};"><tr><td align="center" bgcolor="${COLORS.body}" style="padding:0;background:${COLORS.body};background-color:${COLORS.body};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-shell" bgcolor="${COLORS.surface}" style="width:100%;max-width:640px;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr><td class="email-surface" bgcolor="${COLORS.surface}" style="padding:28px 36px 22px;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};">${htmlViewLink}<tr><td align="center" bgcolor="${COLORS.surface}" style="padding:0 0 22px;background:${COLORS.surface};background-color:${COLORS.surface};">${renderNewsletterHeader("Curadoria independente")}</td></tr></table></td></tr>${htmlImage}<tr><td class="email-content-cell" bgcolor="${COLORS.surface}" style="padding:28px 36px 22px;background:${COLORS.surface};background-color:${COLORS.surface};">${htmlCategory}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr><td width="8" valign="top" bgcolor="${COLORS.red}" style="width:8px;padding:0;background:${COLORS.red};background-color:${COLORS.red};">&nbsp;</td><td bgcolor="${COLORS.surface}" style="padding:0 0 0 16px;background:${COLORS.surface};background-color:${COLORS.surface};"><h1 class="email-title" style="margin:0;color:${COLORS.ivory};font-family:Georgia,'Times New Roman',serif;font-size:40px;line-height:1.04;font-weight:700;letter-spacing:-0.6px;">${ivoryEmailText(escapeHtml(displayTitle))}</h1></td></tr></table></td></tr>${htmlNote}${htmlDescription}${htmlPrice}<tr><td class="email-content-cell" bgcolor="${COLORS.surface}" style="padding:0 36px 14px;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.cta}" style="width:100%;border-collapse:collapse;background:${COLORS.cta};background-color:${COLORS.cta};"><tr><td class="email-cta-cell" align="center" bgcolor="${COLORS.cta}" style="padding:0;background:${COLORS.cta};background-color:${COLORS.cta};"><a class="email-cta-link" href="${escapeHtml(offerUrl)}" target="_blank" rel="noopener" style="display:block;padding:17px 20px;color:${COLORS.white};font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.3;font-weight:700;letter-spacing:2px;text-decoration:none;text-transform:uppercase;">${ctaEmailText("Ver oferta")}</a></td></tr></table></td></tr><tr><td class="email-content-cell" bgcolor="${COLORS.surface}" style="padding:0 36px 32px;text-align:center;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.65;">${secondaryEmailText(escapeHtml(microcopy))}</p></td></tr>${htmlLinks}<tr><td class="email-content-cell" bgcolor="${COLORS.surface}" style="padding:26px 36px 30px;text-align:center;background:${COLORS.surface};background-color:${COLORS.surface};border-top:1px solid ${COLORS.border};">${htmlInstitutionalLinks}<p class="email-footer-copy" style="margin:0 0 12px;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.65;">${secondaryEmailText(escapeHtml(disclosure))}</p>${htmlUnsubscribe}<p class="email-footer-copy" style="margin:19px 0 0;color:${COLORS.ivory};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:2px;">${ivoryEmailText("CERBERUS FINDS · CURADORIA INDEPENDENTE")}</p></td></tr></table></td></tr></table></td></tr></table></body></html>`);
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
  const emailStyles = `<style>body{margin:0!important;padding:0!important;background:${COLORS.body}!important;color:${COLORS.ivory}!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}table{border-spacing:0;}img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}a{text-decoration:none;}@media only screen and (max-width:620px){.email-shell{width:100%!important;}.email-pad,.email-content-cell{padding-left:20px!important;padding-right:20px!important;}.email-title{font-size:32px!important;}.email-body-copy{font-size:15px!important;}}@media (prefers-color-scheme:dark){body{background:${COLORS.body}!important;color:${COLORS.ivory}!important;}.email-shell,.email-surface,.email-pad{background:${COLORS.surface}!important;background-color:${COLORS.surface}!important;}.email-title,.email-body-copy{color:${COLORS.ivory}!important;-webkit-text-fill-color:${COLORS.ivory}!important;}}</style>`;
  const html = protectGmailTextColors(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">${emailStyles}</head><body bgcolor="${COLORS.body}" style="margin:0;padding:0;background:${COLORS.body};background-color:${COLORS.body};color:${COLORS.ivory};color-scheme:dark;"><span style="display:none!important;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</span><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.body}" style="width:100%;border-collapse:collapse;background:${COLORS.body};background-color:${COLORS.body};"><tr><td align="center" bgcolor="${COLORS.body}" style="padding:0;background:${COLORS.body};background-color:${COLORS.body};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-shell" bgcolor="${COLORS.surface}" style="width:100%;max-width:640px;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr><td class="email-surface" bgcolor="${COLORS.surface}" style="padding:28px 36px 24px;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};">${htmlViewLink}<tr><td align="center" bgcolor="${COLORS.surface}" style="padding:0 0 22px;background:${COLORS.surface};background-color:${COLORS.surface};">${renderNewsletterHeader("Curadoria independente")}</td></tr><tr><td bgcolor="${COLORS.surface}" style="padding:30px 0 4px;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 12px;color:${COLORS.cta};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:2.4px;text-transform:uppercase;">${accentEmailText("Boas-vindas")}</p><h1 class="email-title" style="margin:0 0 22px;color:${COLORS.ivory};font-family:Georgia,'Times New Roman',serif;font-size:42px;line-height:1.05;font-weight:700;letter-spacing:-0.6px;">${ivoryEmailText("Bem-vindo à")}<br>${ivoryEmailText("Cerberus Finds")}</h1><p class="email-body-copy" style="margin:0;color:${COLORS.ivory};font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.65;">${ivoryEmailText("Sua inscrição foi confirmada. A partir de agora, você receberá novas seleções, recomendações e ofertas escolhidas com olhar curatorial.")}</p><p class="email-body-copy" style="margin:18px 0 0;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;">${secondaryEmailText("A proposta é simples: menos ruído, mais achados que merecem a sua atenção. Quando uma seleção fizer sentido, ela chegará até você com contexto, transparência e um caminho claro para conhecer a oferta.")}</p></td></tr></table></td></tr><tr><td bgcolor="${COLORS.surface}" style="padding:0 36px 28px;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};border-top:1px solid ${COLORS.border};border-bottom:1px solid ${COLORS.border};"><tr><td bgcolor="${COLORS.surface}" style="padding:19px 0;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 8px;color:${COLORS.cta};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${accentEmailText("O que você pode esperar")}</p><p class="email-body-copy" style="margin:0;color:${COLORS.ivory};font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;">${ivoryEmailText("Seleções editoriais, recomendações e ofertas de parceiros, sempre com identificação da operação, disclosure de afiliado e opção de descadastro individual.")}</p></td></tr></table></td></tr>${htmlLinks}<tr><td class="email-content-cell" bgcolor="${COLORS.surface}" style="padding:26px 36px 30px;text-align:center;background:${COLORS.surface};background-color:${COLORS.surface};border-top:1px solid ${COLORS.border};">${htmlInstitutionalLinks}<p class="email-footer-copy" style="margin:0 0 12px;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.65;">${secondaryEmailText(escapeHtml(disclosure))}</p>${htmlUnsubscribe}<p class="email-footer-copy" style="margin:19px 0 0;color:${COLORS.ivory};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:2px;">${ivoryEmailText("CERBERUS FINDS · CURADORIA INDEPENDENTE")}</p></td></tr></table></td></tr></table></td></tr></table></body></html>`);
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
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr><td align="center" bgcolor="${COLORS.surface}" style="padding:0;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr><td width="34" height="34" align="center" valign="middle" bgcolor="${COLORS.red}" style="width:34px;height:34px;background:${COLORS.red};background-color:${COLORS.red};border:1px solid ${COLORS.red};color:${COLORS.white};font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:32px;font-weight:700;text-align:center;">${ctaEmailText("CF")}</td><td width="12" bgcolor="${COLORS.surface}" style="width:12px;font-size:0;line-height:0;background:${COLORS.surface};background-color:${COLORS.surface};">&nbsp;</td><td valign="middle" bgcolor="${COLORS.surface}" style="background:${COLORS.surface};background-color:${COLORS.surface};color:${COLORS.ivory};font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:34px;font-weight:700;letter-spacing:2.4px;white-space:nowrap;">${ivoryEmailText("CERBERUS FINDS")}</td></tr></table><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr><td align="center" bgcolor="${COLORS.surface}" style="padding:16px 0 0;background:${COLORS.surface};background-color:${COLORS.surface};border-top:1px solid ${COLORS.border};"><p style="margin:0;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${secondaryEmailText(escapeHtml(tagline))}</p></td></tr></table></td></tr></table>`;
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
  return `<tr><td class="email-content-cell" align="center" bgcolor="${COLORS.surface}" style="padding:0 36px 24px;text-align:center;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 12px;color:${COLORS.secondary};font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.5;letter-spacing:2px;text-transform:uppercase;">${secondaryEmailText("Encontre a Cerberus Finds")}</p><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" bgcolor="${COLORS.surface}" style="border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr>${items}</tr></table></td></tr>`;
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
  return network ? `https://cerberus-forge-deploy-backend.onrender.com/assets/newsletter/social/${network}.png` : "";
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

function ivoryEmailText(value: string): string {
  return `<font color="${COLORS.ivory}" style="color:${COLORS.ivory}!important;-webkit-text-fill-color:${COLORS.ivory}!important;">${value}</font>`;
}

function secondaryEmailText(value: string): string {
  return `<font color="${COLORS.secondary}" style="color:${COLORS.secondary}!important;-webkit-text-fill-color:${COLORS.secondary}!important;">${value}</font>`;
}

function accentEmailText(value: string): string {
  return `<font color="${COLORS.cta}" style="color:${COLORS.cta}!important;-webkit-text-fill-color:${COLORS.cta}!important;">${value}</font>`;
}

function ctaEmailText(value: string): string {
  return `<font color="${COLORS.white}" style="color:${COLORS.white}!important;-webkit-text-fill-color:${COLORS.white}!important;">${value}</font>`;
}
