import type { Product } from "../../src/types";
import { appendUTMsToUrl } from "../../src/lib/utm";
import { getProductDisplayCategory } from "../../src/lib/productPresentation";
import { CERBERUS_NEWSLETTER_MASTHEAD_THEMES, CERBERUS_NEWSLETTER_MICROEDITORIALS } from "./newsletterEditorialVoice";
import { isValidProductDestinationUrl, resolveCanonicalProductImage, toCanonicalProduct } from "../../src/lib/productCanonical";
import { buildNewsletterAssetUrl } from "./newsletterInstitutional";

export type EditorialBlockName = "MASTHEAD" | "HERO" | "GRID-2" | "DESTAQUE-HORIZONTAL" | "COMPACTO" | "MICROEDITORIAL";
export type EditorialImageStatus = "clean" | "overlay_suspected" | "unreviewed";

export type EditorialCollectionRenderOptions = {
  trackingCampaignId?: string;
  mastheadImageStatus?: "clean" | "unavailable";
  mastheadAssetUrl?: string;
  mastheadLogoStatus?: "available" | "unavailable";
};

export type EditorialBlockPlan = {
  name: EditorialBlockName;
  productPositions: number[];
  editorialIndex?: number;
};

export type EditorialCollectionRenderResult = {
  html: string;
  mastheadVariant: "A" | "B";
  mastheadImageUrl: string | null;
  mastheadLogoUrl: string | null;
  text: string;
  offerUrls: string[];
  blockSequence: EditorialBlockName[];
  imageOverlayStatus: "clear" | "blocked" | "unreviewed";
  overlayProductPositions: number[];
  altCoverage: { totalImages: number; descriptiveAltImages: number };
  publicFieldAudit: {
    rendered: string[];
    excludedInternal: string[];
  };
};

const COLORS = {
  body: "#0B0908",
  surface: "#181512",
  border: "#3A342E",
  ivory: "#E8E1D3",
  secondary: "#E8E1D3",
  accent: "#E86B5F",
  cta: "#C0392B",
  white: "#FFFFFF",
} as const;

const EDITORIAL_VOICE_MICROTEXTS = CERBERUS_NEWSLETTER_MICROEDITORIALS.map(({ eyebrow, copy }) => [eyebrow, copy] as const);
const MASTHEAD_THEMES = CERBERUS_NEWSLETTER_MASTHEAD_THEMES;
const OFFICIAL_MASTHEAD_LOGO_URL = buildNewsletterAssetUrl("assets/newsletter/branding/cerberus-logo-official.png");

const RENDERED_PUBLIC_FIELDS = ["displayTitle/produto", "preco/ofertaPromocional", "categoria pública", "imagens canônicas", "destino rastreável"];
const EXCLUDED_INTERNAL_FIELDS = ["id", "ref", "status", "lifecycleState", "createdBy", "rawRowIndex", "rawTitle", "createdAt", "destaque", "providerRef", "providerId", "archive fields", "infrastructure"];

export function planEditorialBlocks(productCount: number): EditorialBlockPlan[] {
  if (!Number.isInteger(productCount) || productCount < 1) throw new Error("NEWSLETTER_COLLECTION_EMPTY");
  const plan: EditorialBlockPlan[] = [{ name: "MASTHEAD", productPositions: [] }, { name: "HERO", productPositions: [1] }];
  if (productCount === 1) {
    plan.push({ name: "MICROEDITORIAL", productPositions: [], editorialIndex: 2 });
    return plan;
  }

  plan.push({ name: "MICROEDITORIAL", productPositions: [], editorialIndex: 0 });
  if (productCount === 2) {
    plan.push({ name: "COMPACTO", productPositions: [2] });
    return plan;
  }

  plan.push({ name: "GRID-2", productPositions: [2, 3] });
  if (productCount === 3) return plan;

  plan.push({ name: "MICROEDITORIAL", productPositions: [], editorialIndex: 1 });
  plan.push({ name: "DESTAQUE-HORIZONTAL", productPositions: [4] });
  if (productCount === 4) return plan;

  plan.push({ name: "COMPACTO", productPositions: [5] });
  for (let position = 6; position <= productCount; position += 2) {
    const pair = position + 1 <= productCount ? [position, position + 1] : [position];
    plan.push({ name: pair.length === 2 ? "GRID-2" : "COMPACTO", productPositions: pair });
    if (position + pair.length <= productCount) plan.push({ name: "MICROEDITORIAL", productPositions: [], editorialIndex: 2 });
  }
  return plan;
}

export function renderEditorialCollection(
  products: readonly Product[],
  options: EditorialCollectionRenderOptions = {},
): EditorialCollectionRenderResult {
  if (products.length === 0) throw new Error("NEWSLETTER_COLLECTION_EMPTY");

  const cards = products.map((product, index) => buildProductCard(product, index, options.trackingCampaignId));
  const overlayProductPositions = cards.filter((card) => card.imageStatus === "overlay_suspected").map((card) => card.position);
  const hasUnreviewed = cards.some((card) => card.imageStatus === "unreviewed");
  if (overlayProductPositions.length > 0) {
    throw new Error(`NEWSLETTER_COLLECTION_IMAGE_OVERLAY_SUSPECTED:${overlayProductPositions.join(",")}`);
  }

  const mastheadImageUrl = resolveMastheadImageUrl(cards, options);
  const mastheadLogoUrl = options.mastheadLogoStatus === "unavailable" ? null : OFFICIAL_MASTHEAD_LOGO_URL;
  const mastheadVariant = mastheadImageUrl ? "B" : "A";
  const chunks = buildSequence(cards, { mastheadVariant, mastheadImageUrl, mastheadLogoUrl });
  const blockSequence = chunks.flatMap((chunk) => chunk.blockNames);
  const html = chunks.map((chunk) => chunk.html).join("");
  const text = chunks.map((chunk) => chunk.text).filter(Boolean).join("\n\n");
  const totalImages = cards.filter((card) => card.imageUrl).length;

  return {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};">${html}</table>`,
    text,
    mastheadVariant,
    mastheadImageUrl,
    mastheadLogoUrl,
    offerUrls: cards.map((card) => card.offerUrl),
    blockSequence,
    imageOverlayStatus: overlayProductPositions.length > 0 ? "blocked" : hasUnreviewed ? "unreviewed" : "clear",
    overlayProductPositions,
    altCoverage: { totalImages, descriptiveAltImages: cards.filter((card) => card.imageUrl && card.alt.length >= 3).length },
    publicFieldAudit: { rendered: [...RENDERED_PUBLIC_FIELDS], excludedInternal: [...EXCLUDED_INTERNAL_FIELDS] },
  };
}

type ProductCard = {
  position: number;
  title: string;
  category: string;
  price: string;
  previousPrice: string;
  imageUrl: string;
  alt: string;
  offerUrl: string;
  imageStatus: EditorialImageStatus;
  text: string;
};

type RenderChunk = { html: string; text: string; blockNames: EditorialBlockName[] };

function buildProductCard(product: Product, index: number, trackingCampaignId?: string): ProductCard {
  const canonical = toCanonicalProduct(product);
  const image = resolveCanonicalProductImage(product);
  if (!canonical.id.trim() || canonical.title.length < 3 || !Number.isFinite(canonical.price) || canonical.price <= 0) {
    throw new Error(`NEWSLETTER_COLLECTION_PRODUCT_NOT_READY:${product.id || index}`);
  }
  if (product.imageEditorialStatus === "overlay_suspected") {
    throw new Error(`NEWSLETTER_COLLECTION_IMAGE_OVERLAY_SUSPECTED:${index + 1}`);
  }
  if (image.status !== "ready" || !image.primaryImageUrl) {
    throw new Error(image.reason === "image_review_required"
      ? `NEWSLETTER_COLLECTION_IMAGE_REVIEW_REQUIRED:${product.id || index}`
      : `NEWSLETTER_COLLECTION_PRODUCT_IMAGE_MISSING:${product.id || index}`);
  }
  if (!isValidProductDestinationUrl(canonical.destinationUrl)) {
    throw new Error(`NEWSLETTER_COLLECTION_PRODUCT_DESTINATION_INVALID:${product.id || index}`);
  }

  const offerUrl = trackingCampaignId?.trim()
    ? appendUTMsToUrl(canonical.destinationUrl, {
        utm_source: "email",
        utm_medium: "newsletter",
        utm_campaign: trackingCampaignId.trim(),
        utm_content: canonical.id,
      })
    : canonical.destinationUrl;
  const offer = product.ofertaPromocional && Number.isFinite(product.ofertaPromocional.price) && product.ofertaPromocional.price > 0
    ? product.ofertaPromocional
    : null;
  const currentPrice = offer?.price || canonical.price;
  const category = getProductDisplayCategory(product);
  const imageStatus = (product as Product & { imageEditorialStatus?: EditorialImageStatus }).imageEditorialStatus || "unreviewed";
  const title = canonical.title;
  return {
    position: index + 1,
    title,
    category,
    price: formatPrice(currentPrice),
    previousPrice: offer && product.preco > offer.price ? formatPrice(product.preco) : "",
    imageUrl: image.primaryImageUrl,
    alt: title,
    offerUrl,
    imageStatus,
    text: `${String(index + 1).padStart(2, "0")}. ${title} — ${formatPrice(currentPrice)} — Ver oferta`,
  };
}

function buildSequence(cards: ProductCard[], masthead: { mastheadVariant: "A" | "B"; mastheadImageUrl: string | null; mastheadLogoUrl: string | null }): RenderChunk[] {
  return planEditorialBlocks(cards.length).map((block) => {
    if (block.name === "MASTHEAD") {
      const theme = MASTHEAD_THEMES[(cards.length - 1) % MASTHEAD_THEMES.length];
      return { html: mastheadBlock(theme.headline, theme.deck, cards.length, masthead.mastheadVariant, masthead.mastheadImageUrl, masthead.mastheadLogoUrl), text: `MASTHEAD\n${theme.headline}\n${theme.deck}`, blockNames: ["MASTHEAD"] };
    }
    if (block.name === "HERO") {
      const card = cards[block.productPositions[0] - 1];
      return { html: hero(card), text: `HERO\n${card.text}`, blockNames: ["HERO"] };
    }
    if (block.name === "MICROEDITORIAL") {
      const [eyebrow, copy] = EDITORIAL_VOICE_MICROTEXTS[(block.editorialIndex || 0) % EDITORIAL_VOICE_MICROTEXTS.length];
      return { html: microEditorial(eyebrow, copy), text: `${eyebrow}: ${copy}`, blockNames: ["MICROEDITORIAL"] };
    }
    const selected = block.productPositions.map((position) => cards[position - 1]);
    if (block.name === "GRID-2") {
      return { html: grid2(selected), text: `GRID-2\n${selected.map((card) => card.text).join("\n")}`, blockNames: ["GRID-2"] };
    }
    if (block.name === "DESTAQUE-HORIZONTAL") {
      return { html: horizontal(selected[0]), text: `DESTAQUE-HORIZONTAL\n${selected[0].text}`, blockNames: ["DESTAQUE-HORIZONTAL"] };
    }
    return { html: compact(selected[0]), text: `COMPACTO\n${selected[0].text}`, blockNames: ["COMPACTO"] };
  });
}

function resolveMastheadImageUrl(cards: ProductCard[], options: EditorialCollectionRenderOptions): string | null {
  if (options.mastheadImageStatus === "unavailable") return null;
  const dedicated = options.mastheadAssetUrl?.trim();
  if (options.mastheadImageStatus === "clean" && dedicated && /^https:\/\/[^\s]+$/i.test(dedicated)) return dedicated;
  const first = cards[0];
  return first?.imageStatus === "clean" && /^https:\/\/[^\s]+$/i.test(first.imageUrl) ? first.imageUrl : null;
}

function mastheadBlock(headline: string, deck: string, productCount: number, variant: "A" | "B", imageUrl: string | null, logoUrl: string | null): string {
  const editionNumber = String(productCount).padStart(2, "0");
  const brandMark = logoUrl
    ? `<img class="email-masthead-logo" src="${escapeHtml(logoUrl)}" width="64" height="44" alt="Logo Cerberus Finds" style="display:block;width:64px;height:44px;object-fit:contain;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" />`
    : `<span style="display:block;width:46px;height:46px;background:${COLORS.cta};background-color:${COLORS.cta};color:${COLORS.white};font:700 14px/46px Arial,Helvetica,sans-serif;text-align:center;">${white("CF")}</span>`;
  const brand = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr><td width="72" height="52" valign="middle" bgcolor="${COLORS.surface}" style="width:72px;height:52px;background:${COLORS.surface};background-color:${COLORS.surface};">${brandMark}</td><td width="14" bgcolor="${COLORS.surface}" style="width:14px;font-size:0;line-height:0;background:${COLORS.surface};background-color:${COLORS.surface};">&nbsp;</td><td valign="middle" bgcolor="${COLORS.surface}" style="background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 5px;color:${COLORS.ivory};font:700 16px/1.1 Arial,Helvetica,sans-serif;letter-spacing:2.8px;white-space:nowrap;">${ivory("CERBERUS FINDS")}</p><p style="margin:0;color:${COLORS.secondary};font:700 9px/1.4 Arial,Helvetica,sans-serif;letter-spacing:2.1px;text-transform:uppercase;">${ivory("CURADORIA INDEPENDENTE")}</p></td><td width="74" align="right" valign="middle" bgcolor="${COLORS.surface}" style="width:74px;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 2px;color:${COLORS.secondary};font:700 8px/1.2 Arial,Helvetica,sans-serif;letter-spacing:1.8px;text-transform:uppercase;">${ivory("EDIÇÃO")}</p><p style="margin:0;color:${COLORS.accent};font:700 28px/1 Georgia,'Times New Roman',serif;text-align:right;">${accent(editionNumber)}</p></td></tr></table>`;
  const copy = `<td class="email-masthead-copy" width="${variant === "B" ? "58%" : "100%"}" valign="middle" bgcolor="${COLORS.surface}" style="width:${variant === "B" ? "58%" : "100%"};padding:${variant === "B" ? "0 20px 0 0" : "0"};background:${COLORS.surface};background-color:${COLORS.surface};"><h1 class="email-masthead-headline" style="margin:0 0 13px;color:${COLORS.white};font:700 38px/1.02 Georgia,'Times New Roman',serif;letter-spacing:-0.5px;">${white(headline)}</h1><p class="email-masthead-deck" style="margin:0;color:${COLORS.ivory};font:400 14px/1.6 Arial,Helvetica,sans-serif;">${ivory(deck)}</p></td>`;
  const image = variant === "B" && imageUrl
    ? `<td class="email-masthead-image" width="42%" valign="middle" align="center" bgcolor="${COLORS.surface}" style="width:42%;padding:0;background:${COLORS.surface};background-color:${COLORS.surface};"><img src="${escapeHtml(imageUrl)}" width="250" height="210" alt="Imagem editorial da edição Cerberus Finds" style="display:block;width:100%;max-width:250px;height:210px;object-fit:contain;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" /></td>`
    : "";
  return `<tr><td class="editorial-block editorial-masthead editorial-masthead-${variant.toLowerCase()}" bgcolor="${COLORS.surface}" style="padding:0 0 36px;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr><td bgcolor="${COLORS.surface}" style="padding:0 0 18px;border-top:1px solid ${COLORS.border};background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr><td align="left" bgcolor="${COLORS.surface}" style="padding:18px 0 0;background:${COLORS.surface};background-color:${COLORS.surface};">${brand}</td></tr></table></td></tr><tr><td bgcolor="${COLORS.surface}" style="padding:4px 0 0;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr>${copy}${image}</tr></table></td></tr></table></td></tr>`;
}

function hero(card: ProductCard): string {
  return `<tr><td class="editorial-block editorial-hero email-collection-feature" bgcolor="${COLORS.surface}" style="padding:0 0 34px;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr><td align="center" bgcolor="${COLORS.surface}" style="padding:0 18px 24px;background:${COLORS.surface};background-color:${COLORS.surface};"><img class="email-collection-image" src="${escapeHtml(card.imageUrl)}" width="520" alt="${escapeHtml(card.alt)}" style="display:block;width:100%;max-width:520px;height:280px;object-fit:contain;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" /></td></tr><tr><td bgcolor="${COLORS.surface}" style="padding:0;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-collection-hero-meta" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr><td class="email-collection-hero-copy" width="70%" valign="top" bgcolor="${COLORS.surface}" style="width:70%;padding:0 18px 0 0;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 8px;color:${COLORS.accent};font:700 10px/1.35 Arial,Helvetica,sans-serif;letter-spacing:1.8px;text-transform:uppercase;">${accent(card.category)}</p><h2 style="margin:0;color:${COLORS.white};font:700 29px/1.08 Georgia,'Times New Roman',serif;">${white(card.title)}</h2></td><td class="email-collection-hero-action" width="30%" valign="bottom" align="right" bgcolor="${COLORS.surface}" style="width:30%;padding:0;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 10px;color:${COLORS.white};font:700 15px/1.35 Arial,Helvetica,sans-serif;">${white(card.price)}</p>${solidCta(card.offerUrl)}</td></tr></table></td></tr></table></td></tr>`;
}

function grid2(cards: ProductCard[]): string {
  const cells = cards.map((card) => `<td class="editorial-grid-cell email-collection-grid-cell" width="50%" valign="top" align="left" bgcolor="${COLORS.surface}" style="width:50%;padding:0 8px 28px;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-collection-grid-card" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};border-top:1px solid ${COLORS.border};"><tr><td class="email-collection-grid-image-cell" height="156" align="center" bgcolor="${COLORS.surface}" style="height:156px;padding:10px 0 12px;background:${COLORS.surface};background-color:${COLORS.surface};"><img class="email-collection-image" src="${escapeHtml(card.imageUrl)}" width="286" alt="${escapeHtml(card.alt)}" style="display:block;width:100%;max-width:286px;height:134px;object-fit:contain;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" /></td></tr><tr><td class="email-collection-grid-category" height="24" valign="top" bgcolor="${COLORS.surface}" style="height:24px;padding:0 4px;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 5px;color:${COLORS.accent};font:700 8px/1.35 Arial,Helvetica,sans-serif;letter-spacing:1.3px;text-transform:uppercase;">${accent(card.category)}</p></td></tr><tr><td class="email-collection-grid-title" height="72" valign="top" bgcolor="${COLORS.surface}" style="height:72px;padding:0 4px;background:${COLORS.surface};background-color:${COLORS.surface};"><h3 class="email-collection-title" style="margin:0;color:${COLORS.white};font:700 17px/1.14 Georgia,'Times New Roman',serif;">${white(card.title)}</h3></td></tr><tr><td class="email-collection-grid-price" height="34" valign="top" bgcolor="${COLORS.surface}" style="height:34px;padding:7px 4px 0;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0;color:${COLORS.white};font:700 13px/1.35 Arial,Helvetica,sans-serif;">${white(card.price)}</p></td></tr><tr><td class="email-collection-grid-action" height="45" valign="top" bgcolor="${COLORS.surface}" style="height:45px;padding:3px 4px 0;background:${COLORS.surface};background-color:${COLORS.surface};">${outlineCta(card.offerUrl)}</td></tr></table></td>`).join("");
  const spacer = cards.length === 1
    ? `<td class="editorial-grid-cell email-collection-grid-spacer" width="50%" valign="top" bgcolor="${COLORS.surface}" style="width:50%;padding:0 8px 28px;background:${COLORS.surface};background-color:${COLORS.surface};">&nbsp;</td>`
    : "";
  return `<tr><td class="editorial-block editorial-grid-2" bgcolor="${COLORS.surface}" style="padding:0;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-collection-grid-table" bgcolor="${COLORS.surface}" style="width:100%;table-layout:fixed;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr>${cells}${spacer}</tr></table></td></tr>`;
}

function horizontal(card: ProductCard): string {
  return `<tr><td class="editorial-block editorial-horizontal" bgcolor="${COLORS.surface}" style="padding:6px 0 30px;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-collection-horizontal-table" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};border-top:1px solid ${COLORS.border};border-bottom:1px solid ${COLORS.border};"><tr><td class="editorial-horizontal-image email-collection-horizontal-image" width="42%" valign="middle" align="center" bgcolor="${COLORS.surface}" style="width:42%;padding:18px 18px 18px 0;background:${COLORS.surface};background-color:${COLORS.surface};"><img class="email-collection-image" src="${escapeHtml(card.imageUrl)}" width="250" alt="${escapeHtml(card.alt)}" style="display:block;width:100%;max-width:250px;height:160px;object-fit:contain;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" /></td><td class="editorial-horizontal-copy email-collection-horizontal-copy" width="58%" valign="middle" bgcolor="${COLORS.surface}" style="width:58%;padding:18px 0 18px 8px;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 7px;color:${COLORS.accent};font:700 8px/1.35 Arial,Helvetica,sans-serif;letter-spacing:1.4px;text-transform:uppercase;">${accent(card.category)}</p><h3 style="margin:0;color:${COLORS.white};font:700 20px/1.12 Georgia,'Times New Roman',serif;">${white(card.title)}</h3><p style="margin:9px 0 11px;color:${COLORS.white};font:700 13px/1.35 Arial,Helvetica,sans-serif;">${white(card.price)}</p>${outlineCta(card.offerUrl)}</td></tr></table></td></tr>`;
}

function compact(card: ProductCard): string {
  return `<tr><td class="editorial-block editorial-compact" bgcolor="${COLORS.surface}" style="padding:0 0 20px;background:${COLORS.surface};background-color:${COLORS.surface};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};border-top:1px solid ${COLORS.border};"><tr><td width="84" height="80" valign="middle" bgcolor="${COLORS.surface}" style="width:84px;height:80px;padding:14px 16px 14px 0;background:${COLORS.surface};background-color:${COLORS.surface};"><img class="email-collection-image" src="${escapeHtml(card.imageUrl)}" width="70" alt="${escapeHtml(card.alt)}" style="display:block;width:70px;height:70px;object-fit:contain;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" /></td><td class="email-collection-compact-copy" valign="middle" bgcolor="${COLORS.surface}" style="padding:14px 0;background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 4px;color:${COLORS.accent};font:700 8px/1.35 Arial,Helvetica,sans-serif;letter-spacing:1.2px;text-transform:uppercase;">${accent(card.category)}</p><h3 style="margin:0;color:${COLORS.white};font:700 16px/1.15 Georgia,'Times New Roman',serif;">${white(card.title)}</h3><p style="margin:6px 0 0;color:${COLORS.white};font:700 12px/1.35 Arial,Helvetica,sans-serif;">${white(card.price)}</p></td><td width="100" valign="middle" align="right" bgcolor="${COLORS.surface}" style="width:100px;padding:14px 0;background:${COLORS.surface};background-color:${COLORS.surface};">${outlineCta(card.offerUrl)}</td></tr></table></td></tr>`;
}

function microEditorial(eyebrow: string, copy: string): string {
  return `<tr><td class="editorial-block editorial-micro" bgcolor="${COLORS.surface}" style="padding:22px 10px 24px;background:${COLORS.surface};background-color:${COLORS.surface};border-top:1px solid ${COLORS.border};border-bottom:1px solid ${COLORS.border};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.surface}" style="width:100%;border-collapse:collapse;background:${COLORS.surface};background-color:${COLORS.surface};"><tr><td valign="top" bgcolor="${COLORS.surface}" style="padding:0 0 0 14px;border-left:2px solid ${COLORS.accent};background:${COLORS.surface};background-color:${COLORS.surface};"><p style="margin:0 0 6px;color:${COLORS.accent};font:700 9px/1.4 Arial,Helvetica,sans-serif;letter-spacing:1.8px;text-transform:uppercase;">${accent(eyebrow)}</p><p style="margin:0;color:${COLORS.ivory};font:700 16px/1.25 Georgia,'Times New Roman',serif;">${ivory(copy)}</p></td></tr></table></td></tr>`;
}

function solidCta(url: string): string {
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 18px;background:${COLORS.cta};background-color:${COLORS.cta};color:${COLORS.white};font:700 12px/1.3 Arial,Helvetica,sans-serif;letter-spacing:1.6px;text-decoration:none;text-transform:uppercase;">${white("VER OFERTA")}</a>`;
}

function outlineCta(url: string): string {
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="display:inline-block;padding:9px 11px;border:1px solid ${COLORS.cta};background:${COLORS.surface};background-color:${COLORS.surface};color:${COLORS.white};font:700 10px/1.3 Arial,Helvetica,sans-serif;letter-spacing:1.1px;text-decoration:none;text-transform:uppercase;">${white("VER OFERTA")}</a>`;
}

function accent(value: string): string {
  return `<font color="${COLORS.accent}" style="color:${COLORS.accent}!important;-webkit-text-fill-color:${COLORS.accent}!important;">${escapeHtml(value)}</font>`;
}

function white(value: string): string {
  return `<font color="${COLORS.white}" style="color:${COLORS.white}!important;-webkit-text-fill-color:${COLORS.white}!important;">${escapeHtml(value)}</font>`;
}

function ivory(value: string): string {
  return `<font color="${COLORS.ivory}" style="color:${COLORS.ivory}!important;-webkit-text-fill-color:${COLORS.ivory}!important;">${escapeHtml(value)}</font>`;
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
