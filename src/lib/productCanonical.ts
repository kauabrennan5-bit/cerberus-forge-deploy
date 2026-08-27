import type { Product } from "../types";

export type ProductChannel = "site" | "card" | "newsletter" | "campaign" | "bridge";

import type { ProductImageCuration } from "./productImageCuration";
import { resolvePublicProductCategory } from "./productCategory";

export type CanonicalProductImageResolution = {
  status: "ready" | "incomplete";
  allImageUrls: string[];
  publicHttpsImageUrls: string[];
  rawImageUrls: string[];
  galleryImageUrls: string[];
  /** Imagem principal aprovada pela curadoria; nunca escolhida por consumer. */
  primaryImageUrl?: string;
  curation?: ProductImageCuration;
  reason?: "missing" | "no_valid_https_image" | "image_review_required";
};

export type CanonicalProduct = {
  id: string;
  ref?: string;
  title: string;
  price: number;
  category: string;
  description: string;
  imageUrls: string[];
  rawImageUrls: string[];
  galleryImageUrls: string[];
  primaryImageUrl?: string;
  primaryUsableImageUrl?: string;
  destinationUrl: string;
  slug?: string;
};

export type ProductReadiness = {
  channel: ProductChannel;
  ready: boolean;
  errors: string[];
  warnings: string[];
  product: CanonicalProduct;
  image: CanonicalProductImageResolution;
  imageAccessible?: boolean;
};

export type ProductImageProbe = (url: string) => Promise<boolean>;

  /**
 * Fonte canônica compartilhada pelos canais. Produtos novos carregam
 * `imageCuration` e só a imagem principal aprovada pode virar primary; a
 * persistência legada continua sendo lida para compatibilidade, mas não há
 * escolha arbitrária em consumidores nem mapa por product ID.
 */
export function resolveCanonicalProductImage(product: Pick<Product, "imagens"> & Partial<Pick<Product, "imageCuration" | "imageEditorialStatus">>): CanonicalProductImageResolution {
  const allImageUrls = normalizeProductImageUrls(product.imagens);
  const curation = product.imageCuration;
  const rawImageUrls = normalizeProductImageUrls(curation?.rawImageUrls ?? allImageUrls);
  const observedHttpsImageUrls = allImageUrls.filter(isPublicHttpsImageUrl);
  const curatedPrimary = curation?.status === "ready" && curation.primaryImageUrl && isPublicHttpsImageUrl(curation.primaryImageUrl)
    ? curation.primaryImageUrl
    : undefined;
  const curatedGallery = curation?.status === "ready"
    ? normalizeProductImageUrls(curation.galleryImageUrls).filter(isPublicHttpsImageUrl)
    : [];
  const publicHttpsImageUrls = curatedPrimary
    ? [curatedPrimary, ...curatedGallery.filter(url => url !== curatedPrimary)]
    : observedHttpsImageUrls;
  const galleryImageUrls = curatedPrimary ? publicHttpsImageUrls.slice(1) : normalizeProductImageUrls(curation?.galleryImageUrls ?? observedHttpsImageUrls.slice(1));
  const primaryImageUrl = curatedPrimary || publicHttpsImageUrls.at(0);

  if (product.imageEditorialStatus === "review_required" || product.imageEditorialStatus === "overlay_suspected" || curation?.status === "review_required") {
    return { status: "incomplete", allImageUrls, publicHttpsImageUrls: [], rawImageUrls, galleryImageUrls: [], curation, reason: "image_review_required" };
  }
  if (!primaryImageUrl) {
    return { status: "incomplete", allImageUrls, publicHttpsImageUrls, rawImageUrls, galleryImageUrls, curation, reason: allImageUrls.length === 0 ? "missing" : "no_valid_https_image" };
  }

  return { status: "ready", allImageUrls, publicHttpsImageUrls, rawImageUrls, galleryImageUrls, curation, primaryImageUrl };
}

export function normalizeProductImageUrls(value: unknown): string[] {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? parseImageString(value)
      : [];

  return candidates
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map(candidate => candidate.trim())
    .filter(Boolean)
    .filter((candidate, index, list) => list.indexOf(candidate) === index);
}

export function isPublicHttpsImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".local") || hostname === "0.0.0.0" || hostname === "::1") return false;
    if (/^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^169\.254\./.test(hostname)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export function isValidProductDestinationUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    if (!(["http:", "https:"].includes(url.protocol))) return false;
    if ((url.pathname === "" || url.pathname === "/") && !url.search) return false;
    return true;
  } catch {
    return false;
  }
}

export function toCanonicalProduct(product: Product): CanonicalProduct {
  const image = resolveCanonicalProductImage(product);
  const title = (product.displayTitle || product.produto || "").replace(/\s+/g, " ").trim();
  const destinationUrl = (product.paginaPonteUrl || product.link || "").trim();
  return {
    id: product.id,
    ref: product.ref,
    title,
    price: product.preco,
    category: resolvePublicProductCategory(product.categoria, { title: product.displayTitle || product.produto, description: product.descricao }) || "",
    description: (product.descricao || "").trim(),
    imageUrls: image.publicHttpsImageUrls,
    rawImageUrls: image.rawImageUrls,
    galleryImageUrls: image.galleryImageUrls,
    primaryImageUrl: image.primaryImageUrl,
    destinationUrl,
    slug: product.slug,
  };
}

export async function assessProductReadiness(
  product: Product,
  options: {
    channel?: ProductChannel;
    requireDescription?: boolean;
    verifyImageAccessibility?: boolean;
    imageProbe?: ProductImageProbe;
  } = {},
): Promise<ProductReadiness> {
  const channel = options.channel || "newsletter";
  const canonical = toCanonicalProduct(product);
  const image = resolveCanonicalProductImage(product);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!canonical.id.trim()) errors.push("PRODUCT_ID_MISSING");
  if (canonical.title.length < 3) errors.push("PRODUCT_TITLE_MISSING");
  if (!Number.isFinite(canonical.price) || canonical.price <= 0) errors.push("PRODUCT_PRICE_INVALID");
  if (!isValidProductDestinationUrl(canonical.destinationUrl)) errors.push("PRODUCT_DESTINATION_URL_INVALID");
  if (image.status !== "ready") {
    if (image.reason === "missing") errors.push("PRODUCT_IMAGE_MISSING");
    else if (image.reason === "image_review_required") errors.push("IMAGE_REVIEW_REQUIRED");
    else errors.push("PRODUCT_IMAGE_HTTPS_INVALID");
  }
  if (!canonical.category) errors.push("PUBLIC_CATEGORY_REVIEW_REQUIRED");
  if (!product.imageCuration && product.imageEditorialStatus !== "clean") warnings.push("PRODUCT_IMAGE_SUITABILITY_UNCONFIRMED");
  if (options.requireDescription && !canonical.description) errors.push("PRODUCT_DESCRIPTION_MISSING");
  if (!canonical.category) warnings.push("PRODUCT_CATEGORY_UNCONFIRMED");
  if (!canonical.description && !options.requireDescription) warnings.push("PRODUCT_DESCRIPTION_UNCONFIRMED");

  let imageAccessible: boolean | undefined;
  if (image.primaryImageUrl && options.verifyImageAccessibility) {
    const probe = options.imageProbe || probePublicImageUrl;
    imageAccessible = await probe(image.primaryImageUrl);
    if (!imageAccessible) errors.push("PRODUCT_IMAGE_INACCESSIBLE");
  }

  return {
    channel,
    ready: errors.length === 0,
    errors,
    warnings,
    product: canonical,
    image,
    imageAccessible,
  };
}

export async function probePublicImageUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!isPublicHttpsImageUrl(url)) return false;
  try {
    const head = await fetchImpl(url, { method: "HEAD", redirect: "follow" });
    if (head.ok && isImageContentType(head.headers.get("content-type"))) return true;
  } catch {
    // Alguns CDNs recusam HEAD; a leitura mínima abaixo é a alternativa segura.
  }

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: { Range: "bytes=0-0" },
    });
    return response.ok && isImageContentType(response.headers.get("content-type"));
  } catch {
    return false;
  }
}

function isImageContentType(value: string | null): boolean {
  return Boolean(value && /^image\//i.test(value.trim()));
}

function parseImageString(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // O formato legado separado por pipe permanece suportado.
  }
  return trimmed.split(" | ");
}
