import type { Product } from "../../src/types";
import {
  renderNewsletterCollectionCampaign,
  type NewsletterSocialLink,
  type RenderedNewsletterCampaign,
} from "./newsletterCampaignTemplate";
import type { WeeklyNewsletterCopy } from "./newsletterWeeklyCopy";
import { validPromotionAt } from "./promotionOffer";

export const BREVO_NATIVE_UNSUBSCRIBE = "{{ unsubscribe }}";

export function buildWeeklyGoUrl(
  publicBaseUrl: string,
  product: Product,
  campaignId: string,
  position: number,
): string {
  const ref = product.ref?.trim();
  if (!ref) throw new Error(`WEEKLY_PRODUCT_REF_MISSING:${product.id}`);
  let url: URL;
  try {
    url = new URL(`/go/${encodeURIComponent(ref)}`, publicBaseUrl);
  } catch {
    throw new Error("WEEKLY_PUBLIC_BASE_URL_INVALID");
  }
  if (!/^https?:$/.test(url.protocol))
    throw new Error("WEEKLY_PUBLIC_BASE_URL_INVALID");
  url.searchParams.set("campaign_id", campaignId);
  url.searchParams.set("position", String(position));
  url.searchParams.set("utm_source", "email");
  url.searchParams.set("utm_medium", "newsletter");
  return url.toString();
}

function projectWeeklyProduct(
  product: Product,
  offerUrl: string,
  now: Date,
): Product {
  const promotion = validPromotionAt(product.ofertaPromocional, now);
  return {
    ...product,
    // O renderer editorial recebe somente o redirect mascarado da edição.
    // O link bruto do marketplace nunca entra no HTML semanal.
    link: offerUrl,
    paginaPonteUrl: offerUrl,
    ofertaPromocional: promotion || undefined,
  };
}

function weeklyReferenceSocialLinks(
  links: readonly NewsletterSocialLink[] | undefined,
): readonly NewsletterSocialLink[] {
  const instagram = (links || []).find(link => link.label.trim().toLowerCase() === "instagram");
  return instagram ? [instagram] : [];
}

/**
 * A newsletter semanal usa o mesmo sistema editorial da referência oficial:
 * masthead com edição, hero, microeditorial, GRID-2 e módulos horizontais.
 * A seleção e os gates semanais permanecem isolados; apenas a apresentação é
 * compartilhada com o renderer editorial canônico.
 */
export function renderWeeklyNewsletter(
  products: readonly Product[],
  copy: WeeklyNewsletterCopy,
  options: {
    campaignId: string;
    publicBaseUrl: string;
    socialLinks?: readonly NewsletterSocialLink[];
    privacyUrl?: string;
    termsUrl?: string;
    now?: Date;
  },
): RenderedNewsletterCampaign & { preheader: string; offerUrls: string[] } {
  if (![3, 4, 8].includes(products.length))
    throw new Error("WEEKLY_TEMPLATE_PRODUCT_COUNT_INVALID");

  const now = options.now || new Date();
  const offerUrls = products.map((product, index) =>
    buildWeeklyGoUrl(
      options.publicBaseUrl,
      product,
      options.campaignId,
      index + 1,
    ),
  );
  const projectedProducts = products.map((product, index) =>
    projectWeeklyProduct(product, offerUrls[index], now),
  );
  const rendered = renderNewsletterCollectionCampaign(projectedProducts, {
    subject: copy.subject,
    preheader: copy.previewText,
    collectionKicker: "Curadoria semanal",
    collectionTitle: copy.heroHeadline,
    collectionIntro: copy.heroBody,
    unsubscribeUrl: BREVO_NATIVE_UNSUBSCRIBE,
    privacyUrl: options.privacyUrl,
    termsUrl: options.termsUrl,
    // A referência aprovada encerra com um único destino institucional.
    socialLinks: weeklyReferenceSocialLinks(options.socialLinks),
    mastheadLogoStatus: "available",
  });

  return {
    ...rendered,
    preheader: copy.previewText,
    offerUrl: offerUrls[0],
    offerUrls,
  };
}
