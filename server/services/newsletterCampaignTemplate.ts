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
  const offer = normalizeOffer(product.ofertaPromocional);
  const verifiedPrice = formatPrice(offer?.price || product.preco);
  const previousPrice = offer && product.preco > offer.price ? formatPrice(product.preco) : "";
  const savings = offer && product.preco > offer.price ? formatPrice(product.preco - offer.price) : "";
  const viewInBrowserUrl = normalizeHttpUrl(options.viewInBrowserUrl);
  const privacyUrl = normalizeHttpUrl(options.privacyUrl);
  const termsUrl = normalizeHttpUrl(options.termsUrl);
  const socialLinks = normalizeSocialLinks(options.socialLinks);

  const htmlImage = imageUrl
    ? `<tr><td class="email-pad email-hero-cell" bgcolor="#141414" style="padding:0 36px 30px;background:#141414;"><img class="email-hero" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(displayTitle)}" width="568" style="display:block;width:100%;max-width:568px;height:auto;border:0;border-radius:8px;background:#1e1e1e;filter:none!important;" /></td></tr>`
    : "";
  const htmlCategory = category
    ? `<p class="email-eyebrow" style="margin:0 0 10px;color:#c0392b;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.4;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${escapeHtml(category)}</p>`
    : "";
  const htmlNote = note
    ? `<tr><td class="email-pad" bgcolor="#141414" style="padding:0 36px 26px;background:#141414;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#141414" style="border-collapse:collapse;background:#141414;border-left:3px solid #c0392b;"><tr><td bgcolor="#141414" style="padding:18px 20px;background:#141414;"><p style="margin:0 0 7px;color:#c0392b;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.4;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">Por que selecionamos isso?</p><p style="margin:0;color:#f2f2f2;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;">${escapeHtml(note)}</p></td></tr></table></td></tr>`
    : "";
  const htmlPrice = `<tr><td class="email-pad" bgcolor="#141414" style="padding:0 36px 26px;background:#141414;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-price-card" bgcolor="#141414" style="border-collapse:collapse;background:#141414;border:1px solid #c0392b;border-radius:8px;"><tr><td bgcolor="#141414" style="padding:20px 22px;background:#141414;"><p style="margin:0 0 8px;color:#c0392b;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.4;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">Preço verificado</p><p class="email-price" style="margin:0;color:#f2f2f2;font-family:Arial,Helvetica,sans-serif;font-size:30px;line-height:1.1;font-weight:700;">${escapeHtml(verifiedPrice)}</p>${previousPrice ? `<p style="margin:8px 0 0;color:#b0b0b0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.4;text-decoration:line-through;">${escapeHtml(previousPrice)}</p><p style="margin:5px 0 0;color:#c0392b;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.4;font-weight:700;">Economia de ${escapeHtml(savings)}</p>` : ""}</td></tr></table></td></tr>`;
  const htmlLinks = renderSocialLinks(socialLinks);
  const htmlInstitutionalLinks = privacyUrl || termsUrl
    ? `<p style="margin:0 0 13px;color:#b0b0b0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;">${privacyUrl ? `<a href="${escapeHtml(privacyUrl)}" target="_blank" rel="noopener" style="color:#f2f2f2;text-decoration:underline;">Política de privacidade</a>` : ""}${privacyUrl && termsUrl ? `<span style="color:#888888;padding:0 8px;">|</span>` : ""}${termsUrl ? `<a href="${escapeHtml(termsUrl)}" target="_blank" rel="noopener" style="color:#f2f2f2;text-decoration:underline;">Termos e condições</a>` : ""}</p>`
    : "";
  const htmlViewLink = viewInBrowserUrl
    ? `<p style="margin:0 0 22px;text-align:right;"><a href="${escapeHtml(viewInBrowserUrl)}" target="_blank" rel="noopener" style="color:#b0b0b0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.4;text-decoration:underline;">Ver no navegador</a></p>`
    : "";
  const htmlUnsubscribe = includeUnsubscribe
    ? `<p style="margin:0;color:#b0b0b0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;">Você recebeu esta mensagem porque autorizou comunicações de marketing do Cerberus Finds. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#f2f2f2;text-decoration:underline;">Cancelar inscrição</a>.</p>`
    : `<p style="margin:0;color:#b0b0b0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;">Você recebeu esta mensagem porque confirmou sua inscrição no Cerberus Finds.</p>`;
  const emailStyles = `<style>:root{color-scheme:light dark!important;supported-color-schemes:light dark!important;}body{margin:0!important;padding:0!important;background:#0a0a0a!important;color:#f2f2f2!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}.email-shell,.email-card,.email-pad{background:#141414!important;}.email-card{border:0!important;}.email-price-card{background:#141414!important;border:1px solid #c0392b!important;}.email-cta-cell{background:#c0392b!important;}table{border-spacing:0;}img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}a{color:inherit;}@media only screen and (max-width:620px){.email-shell{width:100%!important;}.email-card{border-radius:0!important;}.email-pad{padding-left:20px!important;padding-right:20px!important;}.email-hero-cell{padding-bottom:24px!important;}.email-title{font-size:30px!important;}.email-price{font-size:27px!important;}.email-cta-cell{width:100%!important;}.email-cta-link{display:block!important;padding-top:16px!important;padding-bottom:16px!important;}}@media (prefers-color-scheme:dark){.email-body{background:#0a0a0a!important;}.email-shell,.email-card,.email-pad{background:#141414!important;}.email-card{border:0!important;}.email-price-card{background:#141414!important;border:1px solid #c0392b!important;}.email-cta-cell{background:#c0392b!important;}.email-title,.email-copy{color:#f2f2f2!important;}}[data-ogsc] .email-body{background:#0a0a0a!important;}[data-ogsc] .email-shell,[data-ogsc] .email-card,[data-ogsc] .email-pad{background:#141414!important;}[data-ogsc] .email-price-card{background:#141414!important;border:1px solid #c0392b!important;}[data-ogsc] .email-cta-cell{background:#c0392b!important;}[data-ogsc] .email-title,[data-ogsc] .email-copy{color:#f2f2f2!important;}</style>`;
  const html = protectGmailTextColors(protectGmailDarkModeBackgrounds(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">${emailStyles}</head><body class="email-body" bgcolor="#0a0a0a" style="margin:0;padding:0;background:#0a0a0a;background-color:#0a0a0a;color:#f2f2f2;color-scheme:light dark;"><span style="display:none!important;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</span><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0a0a0a" style="width:100%;border-collapse:collapse;background:#0a0a0a;background-color:#0a0a0a;"><tr><td align="center" bgcolor="#0a0a0a" style="padding:24px 12px;background:#0a0a0a;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-shell" bgcolor="#141414" style="width:100%;max-width:640px;border-collapse:collapse;background:#141414;background-color:#141414;"><tr><td class="email-card" bgcolor="#141414" style="background:#141414;border:0;border-radius:12px;overflow:hidden;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#141414" style="border-collapse:collapse;background:#141414;"> <tr><td class="email-pad" bgcolor="#141414" style="padding:24px 36px 18px;">${htmlViewLink}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#141414" style="background:#141414;"><tr><td valign="middle" bgcolor="#141414"><table role="presentation" cellpadding="0" cellspacing="0" border="0" bgcolor="#141414" style="background:#141414;"><tr><td bgcolor="#c0392b" style="width:31px;height:31px;background:#c0392b;color:#f2f2f2;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:31px;font-weight:700;text-align:center;">CF</td><td style="padding-left:11px;color:#f2f2f2;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.3;font-weight:700;letter-spacing:2px;">CERBERUS FINDS</td></tr></table></td><td align="right" valign="middle"><span style="color:#b0b0b0;font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;letter-spacing:1.5px;text-transform:uppercase;">Seleção editorial</span></td></tr></table></td></tr><tr><td bgcolor="#141414" style="padding:0 36px;background:#141414;"><div style="height:1px;background:#2b2b2b;font-size:1px;line-height:1px;">&nbsp;</div></td></tr>${htmlImage}<tr><td class="email-pad" bgcolor="#141414" style="padding:26px 36px 22px;">${htmlCategory}<h1 class="email-title" style="margin:0;color:#f2f2f2;font-family:Georgia,'Times New Roman',serif;font-size:38px;line-height:1.08;font-weight:700;letter-spacing:-0.5px;">${escapeHtml(displayTitle)}</h1></td></tr>${htmlNote}${htmlPrice}<tr><td class="email-pad" bgcolor="#141414" style="padding:0 36px 12px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#141414" style="background:#141414;"><tr><td class="email-cta-cell" align="center" bgcolor="#c0392b" style="border-radius:6px;background:#c0392b;"><a class="email-cta-link" href="${escapeHtml(offerUrl)}" target="_blank" rel="noopener" style="display:block;padding:15px 20px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.3;font-weight:700;letter-spacing:1.6px;text-decoration:none;text-transform:uppercase;">Ver oferta</a></td></tr></table></td></tr><tr><td class="email-pad" bgcolor="#141414" style="padding:0 36px 30px;"><p class="email-copy" style="margin:0;color:#b0b0b0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;text-align:center;">${escapeHtml(microcopy)}</p></td></tr><tr><td bgcolor="#141414" style="padding:0 36px;background:#141414;"><div style="height:1px;background:#2b2b2b;font-size:1px;line-height:1px;">&nbsp;</div></td></tr><tr><td class="email-pad" bgcolor="#141414" style="padding:24px 36px 8px;text-align:center;"><p style="margin:0 0 10px;color:#b0b0b0;font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">Sobre esta seleção</p><p class="email-copy" style="margin:0;color:#f2f2f2;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;">Curadoria direta para encontrar peças e objetos que valem a sua atenção.</p></td></tr>${htmlLinks}<tr><td class="email-pad" bgcolor="#141414" style="padding:4px 36px 30px;text-align:center;">${htmlInstitutionalLinks}<p style="margin:0 0 11px;color:#b0b0b0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;">${escapeHtml(disclosure)}</p>${htmlUnsubscribe}<p style="margin:17px 0 0;color:#888888;font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;letter-spacing:1px;">CERBERUS FINDS · CURADORIA INDEPENDENTE</p></td></tr></table></td></tr></table></td></tr></table></td></tr></table></body></html>`));
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
    ? `<p style="margin:0 0 22px;text-align:right;"><a href="${escapeHtml(viewInBrowserUrl)}" target="_blank" rel="noopener" style="color:#b0b0b0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.4;text-decoration:underline;">Ver no navegador</a></p>`
    : "";
  const htmlLinks = renderSocialLinks(socialLinks);
  const htmlInstitutionalLinks = privacyUrl || termsUrl
    ? `<p style="margin:0 0 13px;color:#b0b0b0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;">${privacyUrl ? `<a href="${escapeHtml(privacyUrl)}" target="_blank" rel="noopener" style="color:#f2f2f2;text-decoration:underline;">Política de privacidade</a>` : ""}${privacyUrl && termsUrl ? `<span style="color:#888888;padding:0 8px;">|</span>` : ""}${termsUrl ? `<a href="${escapeHtml(termsUrl)}" target="_blank" rel="noopener" style="color:#f2f2f2;text-decoration:underline;">Termos e condições</a>` : ""}</p>`
    : "";
  const htmlUnsubscribe = includeUnsubscribe
    ? `<p style="margin:0;color:#b0b0b0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;">Você recebeu esta mensagem porque autorizou comunicações de marketing do Cerberus Finds. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#f2f2f2;text-decoration:underline;">Cancelar inscrição</a>.</p>`
    : `<p style="margin:0;color:#b0b0b0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;">Você recebeu esta mensagem porque confirmou sua inscrição no Cerberus Finds.</p>`;
  const emailStyles = `<style>:root{color-scheme:light dark!important;supported-color-schemes:light dark!important;}body{margin:0!important;padding:0!important;background:#0a0a0a!important;color:#f2f2f2!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}.email-shell,.email-card,.email-pad{background:#141414!important;}.email-card{border:0!important;}.email-price-card{background:#141414!important;border:1px solid #c0392b!important;}.email-cta-cell{background:#c0392b!important;}table{border-spacing:0;}a{color:inherit;}@media only screen and (max-width:620px){.email-shell{width:100%!important;}.email-card{border-radius:0!important;}.email-pad{padding-left:20px!important;padding-right:20px!important;}.email-title{font-size:32px!important;}.email-copy{font-size:15px!important;}}@media (prefers-color-scheme:dark){.email-body{background:#0a0a0a!important;}.email-shell,.email-card,.email-pad{background:#141414!important;}.email-title,.email-copy{color:#f2f2f2!important;}}</style>`;
  const html = protectGmailTextColors(protectGmailDarkModeBackgrounds(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">${emailStyles}</head><body class="email-body" bgcolor="#0a0a0a" style="margin:0;padding:0;background:#0a0a0a;background-color:#0a0a0a;color:#f2f2f2;color-scheme:light dark;"><span style="display:none!important;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</span><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0a0a0a" style="width:100%;border-collapse:collapse;background:#0a0a0a;background-color:#0a0a0a;"><tr><td align="center" bgcolor="#0a0a0a" style="padding:24px 12px;background:#0a0a0a;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-shell" bgcolor="#141414" style="width:100%;max-width:640px;border-collapse:collapse;background:#141414;background-color:#141414;"><tr><td class="email-card" bgcolor="#141414" style="background:#141414;border:0;border-radius:12px;overflow:hidden;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#141414" style="border-collapse:collapse;background:#141414;"><tr><td class="email-pad" bgcolor="#141414" style="padding:24px 36px 18px;">${htmlViewLink}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#141414" style="background:#141414;"><tr><td valign="middle" bgcolor="#141414"><table role="presentation" cellpadding="0" cellspacing="0" border="0" bgcolor="#141414" style="background:#141414;"><tr><td bgcolor="#c0392b" style="width:31px;height:31px;background:#c0392b;color:#f2f2f2;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:31px;font-weight:700;text-align:center;">CF</td><td style="padding-left:11px;color:#f2f2f2;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.3;font-weight:700;letter-spacing:2px;">CERBERUS FINDS</td></tr></table></td><td align="right" valign="middle"><span style="color:#b0b0b0;font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;letter-spacing:1.5px;text-transform:uppercase;">Curadoria independente</span></td></tr></table></td></tr><tr><td bgcolor="#141414" style="padding:0 36px;background:#141414;"><div style="height:1px;background:#2b2b2b;font-size:1px;line-height:1px;">&nbsp;</div></td></tr><tr><td class="email-pad" bgcolor="#141414" style="padding:42px 36px 30px;"><p style="margin:0 0 12px;color:#c0392b;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.4;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Boas-vindas</p><h1 class="email-title" style="margin:0 0 24px;color:#f2f2f2;font-family:Georgia,'Times New Roman',serif;font-size:42px;line-height:1.06;font-weight:700;letter-spacing:-0.5px;">Bem-vindo à<br>Cerberus Finds</h1><p class="email-copy" style="margin:0;color:#f2f2f2;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.65;">Sua inscrição foi confirmada. A partir de agora, você receberá novas seleções, recomendações e ofertas escolhidas com olhar curatorial.</p><p class="email-copy" style="margin:18px 0 0;color:#b0b0b0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;">A proposta é simples: menos ruído, mais achados que merecem a sua atenção. Quando uma seleção fizer sentido, ela chegará até você com contexto, transparência e um caminho claro para conhecer a oferta.</p></td></tr><tr><td class="email-pad" bgcolor="#141414" style="padding:0 36px 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#141414" style="border-collapse:collapse;background:#141414;border-left:3px solid #c0392b;"><tr><td bgcolor="#141414" style="padding:20px;background:#141414;"><p style="margin:0 0 8px;color:#c0392b;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.4;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">O que você pode esperar</p><p class="email-copy" style="margin:0;color:#f2f2f2;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;">Seleções editoriais, recomendações e ofertas de parceiros, sempre com identificação da operação, disclosure de afiliado e opção de descadastro individual.</p></td></tr></table></td></tr>${htmlLinks}<tr><td bgcolor="#141414" style="padding:0 36px;background:#141414;"><div style="height:1px;background:#2b2b2b;font-size:1px;line-height:1px;">&nbsp;</div></td></tr><tr><td class="email-pad" bgcolor="#141414" style="padding:24px 36px 30px;text-align:center;">${htmlInstitutionalLinks}<p style="margin:0 0 11px;color:#b0b0b0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;">${escapeHtml(disclosure)}</p>${htmlUnsubscribe}<p style="margin:17px 0 0;color:#888888;font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.4;letter-spacing:1px;">CERBERUS FINDS · CURADORIA INDEPENDENTE</p></td></tr></table></td></tr></table></td></tr></table></td></tr></table></body></html>`));
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
product: Pick<Product, "link" | "paginaPonteUrl">): string {
  const candidate = (product.paginaPonteUrl || product.link || "").trim();
  if (!/^https?:\/\/[^\s]+$/i.test(candidate)) {
    throw new Error("CAMPAIGN_OFFER_URL_INVALID");
  }
  return candidate;
}

function protectGmailTextColors(html: string): string {
  const colors = ["#f2f2f2", "#b0b0b0", "#c0392b", "#ffffff", "#888888"];
  return colors.reduce((output, color) => output
    .replaceAll(`;color:${color}!important;`, `;color:${color}!important;-webkit-text-fill-color:${color}!important;`)
    .replaceAll(`;color:${color};`, `;color:${color};-webkit-text-fill-color:${color};`), html);
}

function protectGmailDarkModeBackgrounds(html: string): string {
  const colors = ["#0a0a0a", "#141414", "#c0392b", "#1e1e1e", "#2b2b2b"];
  return colors.reduce((output, color) => output
    .replaceAll(`background:${color}!important;`, `background:${color}!important;background-image:linear-gradient(${color},${color})!important;`)
    .replaceAll(`background:${color};`, `background:${color};background-image:linear-gradient(${color},${color});`), html);
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

function renderSocialLinks(links: NewsletterSocialLink[]): string {
  const items = links
    .filter(link => Boolean(link.iconUrl))
    .map(link => {
      const icon = `<img src="${escapeHtml(link.iconUrl || "")}" width="24" height="24" alt="${escapeHtml(link.label)}" style="display:block;width:24px;height:24px;border:0;outline:none;text-decoration:none;filter:none!important;" />`;
      const item = link.url
        ? `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener" aria-label="${escapeHtml(link.label)}" style="display:inline-block;text-decoration:none;">${icon}</a>`
        : `<span aria-label="${escapeHtml(link.label)} ainda não configurado" style="display:inline-block;">${icon}</span>`;
      return `<td valign="middle" style="padding:0 4px;">${item}</td>`;
    })
    .join("");
  if (!items) return "";
  return `<tr><td bgcolor="#141414" style="padding:0 36px 20px;text-align:center;background:#141414;"><p style="margin:0;color:#b0b0b0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.5;letter-spacing:1px;text-transform:uppercase;">Encontre a Cerberus Finds</p><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" bgcolor="#141414" style="margin:10px auto 0;border-collapse:collapse;background:#141414;"><tr>${items}</tr></table></td></tr>`;
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
