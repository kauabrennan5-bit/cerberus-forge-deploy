import type { ProductCandidate } from "./productLifecycle";
import { extractShopeeIdentity } from "../commercial/marketplace/shopeeIdentity";
import * as curatorRepo from "../repositories/autonomousCuratorRepository";
import { extractProductForReview } from "./productAutomation";
import { fetchProductDataFromUrl } from "./scraper";
import { resolveCanonicalProductImage } from "../../src/lib/productCanonical";
import {
  buildConfiguredShopeeClient,
  providerErrorFromAcquisitionStatus,
  ShopeeProviderRuntimeError,
  validateOfficialProductLink,
} from "./shopeeProviderRuntime";

export type ShopeePublicationPreflightResult =
  | { ok: true; code: "SHOPEE_PUBLICATION_PREFLIGHT_OK" }
  | { ok: false; code: string; transient: boolean };

export type ShopeePublicationPreflightOptions = {
  /**
   * A decisão humana final pode substituir somente gates editoriais/visuais.
   * Identidade, disponibilidade, afiliado, preço e presença da imagem aprovada
   * no anúncio continuam sendo revalidados no instante do clique em PUBLICAR.
   */
  humanManualApproval?: boolean;
};

let testPreflightOverride: ((candidate: ProductCandidate) => Promise<ShopeePublicationPreflightResult>) | null = null;

export function setTestShopeePublicationPreflight(
  override: ((candidate: ProductCandidate) => Promise<ShopeePublicationPreflightResult>) | null,
): void {
  testPreflightOverride = override;
}

function numbersMateriallyDiffer(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return true;
  return Math.abs(a - b) > 0.009;
}

function firstHttpsImage(images: readonly string[] | undefined): string | null {
  return images?.find(image => /^https:\/\//i.test(String(image || "").trim()))?.trim() || null;
}

/**
 * A Shopee serve o mesmo asset por aliases de CDN diferentes. Exemplo real de
 * produção: `cf.shopee.com.br/file/<asset>` no card e
 * `down-br.img.susercontent.com/file/<asset>` no re-scrape do clique.
 * O identificador estável é o token após `/file/`, não o hostname da CDN.
 */
function shopeeImageAssetKey(rawUrl: string): string | null {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    if (parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase();
    const knownShopeeImageHost = host === "cf.shopee.com.br" || host.endsWith(".img.susercontent.com");
    if (!knownShopeeImageHost) return null;
    const match = parsed.pathname.match(/^\/file\/([^/?#]+)$/i);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function sameShopeeImageAsset(left: string, right: string): boolean {
  const normalizedLeft = String(left || "").trim();
  const normalizedRight = String(right || "").trim();
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  const leftKey = shopeeImageAssetKey(normalizedLeft);
  const rightKey = shopeeImageAssetKey(normalizedRight);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function currentImageEvidence(current: {
  imagens?: string[];
  imagensOriginais?: string[];
  imagensGaleria?: string[];
  imagemPrincipal?: string;
  imageCuration?: ProductCandidate["imageCuration"];
}): string[] {
  return [
    ...(current.imagens || []),
    ...(current.imagensOriginais || []),
    ...(current.imagensGaleria || []),
    ...(current.imagemPrincipal ? [current.imagemPrincipal] : []),
    ...(current.imageCuration?.rawImageUrls || []),
    ...(current.imageCuration?.galleryImageUrls || []),
    ...(current.imageCuration?.primaryImageUrl ? [current.imageCuration.primaryImageUrl] : []),
  ]
    .map(image => String(image || "").trim())
    .filter(image => /^https:\/\//i.test(image));
}

function hasApprovedImageEvidence(savedImage: string, evidence: readonly string[]): boolean {
  return evidence.some(image => sameShopeeImageAsset(savedImage, image));
}

async function fetchRawListingImageEvidence(productUrl: string): Promise<string[]> {
  try {
    const scraped = await fetchProductDataFromUrl(productUrl);
    return (scraped.images || [])
      .map(image => String(image || "").trim())
      .filter(image => /^https:\/\//i.test(image));
  } catch {
    return [];
  }
}

export async function revalidateShopeeCandidateBeforePublication(
  candidate: ProductCandidate,
  env: NodeJS.ProcessEnv = process.env,
  options: ShopeePublicationPreflightOptions = {},
): Promise<ShopeePublicationPreflightResult> {
  if (testPreflightOverride) return testPreflightOverride(candidate);
  if (candidate.marketplace !== "Shopee") return { ok: true, code: "SHOPEE_PUBLICATION_PREFLIGHT_OK" };

  const normalizedUrl = String(candidate.normalizedUrl || "").trim();
  const expected = extractShopeeIdentity(normalizedUrl);
  if (!expected.shopId || !expected.itemId || !validateOfficialProductLink(normalizedUrl, expected.shopId, expected.itemId)) {
    return { ok: false, code: "SHOPEE_PREFLIGHT_IDENTITY_INVALID", transient: false };
  }

  const owned = await curatorRepo.findProductSourceIdentity("Shopee", expected.shopId, expected.itemId);
  if (owned?.productId) return { ok: false, code: "SHOPEE_PREFLIGHT_DUPLICATE_IDENTITY", transient: false };

  let client;
  try {
    client = buildConfiguredShopeeClient(env);
  } catch (error) {
    if (error instanceof ShopeeProviderRuntimeError) return { ok: false, code: error.code, transient: error.transient };
    return { ok: false, code: "SHOPEE_PROVIDER_NOT_CONFIGURED", transient: false };
  }

  const lookup = await client.lookupProduct({ shopId: expected.shopId, itemId: expected.itemId });
  if (lookup.status === "not_found") return { ok: false, code: "SHOPEE_PREFLIGHT_PRODUCT_NOT_FOUND", transient: false };
  if (lookup.status === "error") {
    const kind = lookup.error?.kind || "SHOPEE_UNKNOWN_ERROR";
    const mapped = kind === "SHOPEE_AUTH_ERROR" || kind === "SHOPEE_FORBIDDEN"
      ? "SHOPEE_PROVIDER_AUTH_FAILED"
      : kind === "SHOPEE_RATE_LIMITED"
        ? "SHOPEE_PROVIDER_RATE_LIMITED"
        : kind === "SHOPEE_TIMEOUT"
          ? "SHOPEE_PROVIDER_TIMEOUT"
          : kind === "SHOPEE_INVALID_RESPONSE" || kind === "SHOPEE_GRAPHQL_ERROR"
            ? "SHOPEE_PROVIDER_RESPONSE_INVALID"
            : "SHOPEE_PROVIDER_UNAVAILABLE";
    return { ok: false, code: mapped, transient: ["SHOPEE_PROVIDER_RATE_LIMITED", "SHOPEE_PROVIDER_TIMEOUT", "SHOPEE_PROVIDER_UNAVAILABLE"].includes(mapped) };
  }
  if (
    lookup.status !== "found"
    || lookup.shopId !== expected.shopId
    || lookup.itemId !== expected.itemId
    || !lookup.productLink
    || !validateOfficialProductLink(lookup.productLink, expected.shopId, expected.itemId)
  ) {
    return { ok: false, code: "SHOPEE_PREFLIGHT_LOOKUP_IDENTITY_CHANGED", transient: false };
  }

  const acquisition = await client.acquireAffiliateLink({ shopId: expected.shopId, itemId: expected.itemId });
  if (acquisition.status !== "link_acquired") {
    const providerFailure = providerErrorFromAcquisitionStatus(acquisition.status, acquisition.error?.kind);
    if (providerFailure) return { ok: false, code: providerFailure.code, transient: providerFailure.transient };
    return { ok: false, code: `SHOPEE_PREFLIGHT_AFFILIATE_${acquisition.status.toUpperCase()}`, transient: false };
  }
  if (
    !acquisition.productLink
    || !acquisition.affiliateUrl
    || acquisition.shopId !== expected.shopId
    || acquisition.itemId !== expected.itemId
    || !validateOfficialProductLink(acquisition.productLink, expected.shopId, expected.itemId)
  ) {
    return { ok: false, code: "SHOPEE_PREFLIGHT_AFFILIATE_EVIDENCE_CHANGED", transient: false };
  }

  const extracted = await extractProductForReview(acquisition.productLink);
  if (!extracted.success || !extracted.data) return { ok: false, code: "SHOPEE_PREFLIGHT_CURRENT_STATE_UNAVAILABLE", transient: true };
  const current = extracted.data;
  const currentIdentity = extractShopeeIdentity(current.normalizedUrl);
  if (currentIdentity.shopId !== expected.shopId || currentIdentity.itemId !== expected.itemId) {
    return { ok: false, code: "SHOPEE_PREFLIGHT_SCRAPER_IDENTITY_CHANGED", transient: false };
  }

  const currentCategory = String(current.categoria || "").trim();
  if (!currentCategory || currentCategory !== candidate.categoria) {
    return { ok: false, code: "SHOPEE_PREFLIGHT_CATEGORY_CHANGED", transient: false };
  }

  const observedPrice = Number(current.preco);
  const officialPrice = Number(acquisition.price);
  const currentPrice = Number.isFinite(observedPrice) && observedPrice > 0 ? observedPrice : officialPrice;
  if (numbersMateriallyDiffer(Number(candidate.preco), currentPrice)) {
    return { ok: false, code: "SHOPEE_PREFLIGHT_PRICE_CHANGED", transient: false };
  }

  const currentImage = resolveCanonicalProductImage({
    imagens: current.imagens || [],
    imageCuration: current.imageCuration,
    imageEditorialStatus: current.imageEditorialStatus,
  });
  const currentPrimaryImage = currentImage.primaryImageUrl || firstHttpsImage(current.imagens);
  if (!currentPrimaryImage || !/^https:\/\//i.test(currentPrimaryImage)) {
    return { ok: false, code: "SHOPEE_PREFLIGHT_IMAGE_MISSING", transient: false };
  }
  if (
    !options.humanManualApproval
    && (
      current.imageEditorialStatus !== "clean"
      || currentImage.status !== "ready"
    )
  ) {
    return { ok: false, code: "SHOPEE_PREFLIGHT_IMAGE_NOT_CLEAN", transient: false };
  }

  const savedImage = resolveCanonicalProductImage(candidate).primaryImageUrl || firstHttpsImage(candidate.imagens);
  if (!savedImage) {
    return { ok: false, code: "SHOPEE_PREFLIGHT_IMAGE_CHANGED", transient: false };
  }

  const projectedEvidence = currentImageEvidence(current);
  let approvedImageStillPresent = hasApprovedImageEvidence(savedImage, projectedEvidence);

  // O reviewer visual pode remover do conjunto pós-curadoria uma imagem que
  // continua presente no anúncio. Nesse caso, a decisão humana não deve receber
  // um falso IMAGE_CHANGED: consultamos uma segunda vez o scraper canônico e
  // usamos somente as imagens oficiais brutas da MESMA identidade Shopee.
  // Se o asset realmente sumiu, o hard gate continua falhando.
  if (!approvedImageStillPresent) {
    const rawListingEvidence = await fetchRawListingImageEvidence(acquisition.productLink);
    approvedImageStillPresent = hasApprovedImageEvidence(savedImage, rawListingEvidence);
  }

  if (!approvedImageStillPresent) {
    return { ok: false, code: "SHOPEE_PREFLIGHT_IMAGE_CHANGED", transient: false };
  }

  return { ok: true, code: "SHOPEE_PUBLICATION_PREFLIGHT_OK" };
}

export const shopeePublicationPreflightInternals = {
  shopeeImageAssetKey,
  sameShopeeImageAsset,
  currentImageEvidence,
  hasApprovedImageEvidence,
};
