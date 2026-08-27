import type { Product } from "../types";

export type ProductChannel = "site" | "card" | "newsletter" | "campaign" | "bridge";

export type CanonicalProductImageResolution = {
  status: "ready" | "incomplete";
  allImageUrls: string[];
  publicHttpsImageUrls: string[];
  /** Primeira imagem pública HTTPS, apta para todos os renderers. */
  primaryImageUrl?: string;
  reason?: "missing" | "no_valid_https_image";
};

export type CanonicalProduct = {
  id: string;
  ref?: string;
  title: string;
  price: number;
  category: string;
  description: string;
  imageUrls: string[];
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
 * Fonte canônica compartilhada pelos canais: a ordem de `products.imagens`
 * é preservada e a primeira URL HTTPS pública é a imagem principal. Nenhum
 * mapa por product ID participa desta decisão.
 */
export function resolveCanonicalProductImage(product: Pick<Product, "imagens">): CanonicalProductImageResolution {
  const allImageUrls = normalizeProductImageUrls(product.imagens);
  const publicHttpsImageUrls = allImageUrls.filter(isPublicHttpsImageUrl);
  const primaryImageUrl = publicHttpsImageUrls[0];

  if (!primaryImageUrl) {
    return {
      status: "incomplete",
      allImageUrls,
      publicHttpsImageUrls,
      reason: allImageUrls.length === 0 ? "missing" : "no_valid_https_image",
    };
  }

  return {
    status: "ready",
    allImageUrls,
    publicHttpsImageUrls,
    primaryImageUrl,
  };
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
    category: (product.categoria || "").trim(),
    description: (product.descricao || "").trim(),
    imageUrls: image.publicHttpsImageUrls,
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
  if (image.status !== "ready") errors.push(image.reason === "missing" ? "PRODUCT_IMAGE_MISSING" : "PRODUCT_IMAGE_HTTPS_INVALID");
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
