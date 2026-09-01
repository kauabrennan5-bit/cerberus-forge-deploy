import sharp, { type Metadata } from "sharp";
import { resolvePublicProductCategory } from "../../src/lib/productCategory";
import type { ProductImageAssessment, ProductImageCuration } from "../../src/lib/productImageCuration";
import { reviewProductImages } from "./productImageReview";

export type ShopeeCandidateVisualState = "HARD_REJECT" | "NEEDS_HUMAN_REVIEW" | "QUALIFIED";

export type ShopeeImageProbe = {
  ok: boolean;
  httpStatus: number | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  format: string | null;
  byteLength: number | null;
  reason: string | null;
};

export type ShopeeImageQualification = {
  state: ShopeeCandidateVisualState;
  reason: string;
  probe: ShopeeImageProbe;
  assessment: ProductImageAssessment | null;
  curationReason: ProductImageCuration["reason"] | null;
  visualScore: number;
};

export type ShopeeRankableCandidate = {
  shopId: string;
  itemId: string;
  name: string;
  price: number;
  productLink: string;
  imageUrl: string;
  round: number;
  queryVariant: string;
  category: string;
  relevanceScore: number;
  imageQualification?: ShopeeImageQualification;
};

type QualifyImageOptions = {
  fetchImpl?: typeof fetch;
  reviewer?: (images: readonly string[], title: string) => Promise<ProductImageCuration>;
  minDimension?: number;
  timeoutMs?: number;
};

const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_DEFAULT_MIN_DIMENSION = 256;
const IMAGE_DEFAULT_TIMEOUT_MS = 10_000;
const HARD_VISUAL_DECISIONS = new Set<ProductImageAssessment["decision"]>([
  "technical",
  "promotional",
  "logo",
  "collage",
  "screenshot",
  "off_brand",
  "incomplete",
  "novelty",
]);

const STOPWORDS = new Set([
  "a", "as", "com", "da", "das", "de", "do", "dos", "e", "em", "o", "os", "para", "por", "uma", "um",
]);

function normalizeText(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulTokens(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter(token => token.length >= 3 && !STOPWORDS.has(token));
}

function isOfficialShopeeImageHost(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "cf.shopee.com.br"
      || host.endsWith(".shopee.com.br")
      || host === "down-br.img.susercontent.com"
      || host.endsWith(".susercontent.com");
  } catch {
    return false;
  }
}

function looksLikePlaceholderUrl(value: string): boolean {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    return /(?:placeholder|no[-_]?image|no[-_]?photo|default[-_]?image|image[-_]?default|loading)/.test(pathname);
  } catch {
    return true;
  }
}

function formatToMime(format: string | undefined): string | null {
  if (format === "jpg" || format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  if (format === "webp") return "image/webp";
  if (format === "avif") return "image/avif";
  return null;
}

async function getImageResponse(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Response | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          Accept: "image/avif,image/webp,image/jpeg,image/png,*/*;q=0.5",
          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.7",
          "User-Agent": "Mozilla/5.0 (compatible; CerberusFinds/1.0; +https://cerberusfinds.com)",
        },
        signal: controller.signal,
      });
      if (response.ok) return response;
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) continue;
      return response;
    } catch {
      if (attempt === 1) return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

export async function probeOfficialShopeeImage(
  imageUrl: string,
  options: Pick<QualifyImageOptions, "fetchImpl" | "minDimension" | "timeoutMs"> = {},
): Promise<ShopeeImageProbe> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const minDimension = options.minDimension ?? IMAGE_DEFAULT_MIN_DIMENSION;
  const timeoutMs = options.timeoutMs ?? IMAGE_DEFAULT_TIMEOUT_MS;
  if (!imageUrl || !isOfficialShopeeImageHost(imageUrl)) {
    return { ok: false, httpStatus: null, mimeType: null, width: null, height: null, format: null, byteLength: null, reason: "IMAGE_HOST_INVALID" };
  }
  if (looksLikePlaceholderUrl(imageUrl)) {
    return { ok: false, httpStatus: null, mimeType: null, width: null, height: null, format: null, byteLength: null, reason: "IMAGE_PLACEHOLDER" };
  }

  const response = await getImageResponse(imageUrl, fetchImpl, timeoutMs);
  if (!response) {
    return { ok: false, httpStatus: null, mimeType: null, width: null, height: null, format: null, byteLength: null, reason: "IMAGE_INACCESSIBLE" };
  }
  const responseUrl = typeof response.url === "string" && response.url ? response.url : imageUrl;
  if (!isOfficialShopeeImageHost(responseUrl)) {
    return { ok: false, httpStatus: response.status, mimeType: null, width: null, height: null, format: null, byteLength: null, reason: "IMAGE_REDIRECT_HOST_INVALID" };
  }
  if (!response.ok) {
    return { ok: false, httpStatus: response.status, mimeType: null, width: null, height: null, format: null, byteLength: null, reason: "IMAGE_HTTP_ERROR" };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    return { ok: false, httpStatus: response.status, mimeType: null, width: null, height: null, format: null, byteLength: null, reason: "IMAGE_BODY_UNREADABLE" };
  }
  if (bytes.length === 0 || bytes.length > IMAGE_MAX_BYTES) {
    return { ok: false, httpStatus: response.status, mimeType: null, width: null, height: null, format: null, byteLength: bytes.length, reason: bytes.length === 0 ? "IMAGE_EMPTY" : "IMAGE_TOO_LARGE" };
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, { failOn: "error" }).metadata();
  } catch {
    return { ok: false, httpStatus: response.status, mimeType: null, width: null, height: null, format: null, byteLength: bytes.length, reason: "IMAGE_BYTES_INVALID" };
  }
  const derivedMime = formatToMime(metadata.format);
  const headerMime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || null;
  const mimeType = headerMime && /^image\/(?:avif|webp|jpeg|png)$/.test(headerMime) ? headerMime : derivedMime;
  if (!mimeType) {
    return { ok: false, httpStatus: response.status, mimeType: headerMime, width: metadata.width ?? null, height: metadata.height ?? null, format: metadata.format ?? null, byteLength: bytes.length, reason: "IMAGE_MIME_UNSUPPORTED" };
  }
  const width = metadata.width ?? null;
  const height = metadata.height ?? null;
  if (!width || !height) {
    return { ok: false, httpStatus: response.status, mimeType, width, height, format: metadata.format ?? null, byteLength: bytes.length, reason: "IMAGE_DIMENSIONS_UNKNOWN" };
  }
  if (Math.min(width, height) < minDimension) {
    return { ok: false, httpStatus: response.status, mimeType, width, height, format: metadata.format ?? null, byteLength: bytes.length, reason: "IMAGE_TOO_SMALL" };
  }
  return { ok: true, httpStatus: response.status, mimeType, width, height, format: metadata.format ?? null, byteLength: bytes.length, reason: null };
}

export function classifyReviewedShopeeImage(input: {
  probe: ShopeeImageProbe;
  curation: ProductImageCuration;
}): ShopeeImageQualification {
  const { probe, curation } = input;
  if (!probe.ok) {
    return { state: "HARD_REJECT", reason: probe.reason || "IMAGE_INVALID", probe, assessment: null, curationReason: curation.reason ?? null, visualScore: 0 };
  }

  const assessment = curation.assessments[0] ?? null;
  if (curation.status === "ready" && curation.primaryImageUrl && assessment?.decision === "clean" && assessment.confidence !== "LOW") {
    return { state: "QUALIFIED", reason: `IMAGE_CLEAN_${assessment.confidence}`, probe, assessment, curationReason: curation.reason ?? null, visualScore: assessment.confidence === "HIGH" ? 100 : 90 };
  }
  if (!assessment) {
    return { state: "NEEDS_HUMAN_REVIEW", reason: String(curation.reason || "IMAGE_REVIEW_INCONCLUSIVE"), probe, assessment: null, curationReason: curation.reason ?? null, visualScore: 45 };
  }
  if (assessment.decision === "clean") {
    return { state: "NEEDS_HUMAN_REVIEW", reason: `IMAGE_CLEAN_${assessment.confidence}`, probe, assessment, curationReason: curation.reason ?? null, visualScore: 65 };
  }
  if (assessment.decision === "unknown") {
    return { state: "NEEDS_HUMAN_REVIEW", reason: `IMAGE_UNKNOWN_${assessment.confidence}`, probe, assessment, curationReason: curation.reason ?? null, visualScore: 50 };
  }
  if (assessment.confidence === "HIGH" && HARD_VISUAL_DECISIONS.has(assessment.decision)) {
    return { state: "HARD_REJECT", reason: `IMAGE_${assessment.decision.toUpperCase()}_HIGH`, probe, assessment, curationReason: curation.reason ?? null, visualScore: 0 };
  }
  return { state: "NEEDS_HUMAN_REVIEW", reason: `IMAGE_${assessment.decision.toUpperCase()}_${assessment.confidence}`, probe, assessment, curationReason: curation.reason ?? null, visualScore: assessment.confidence === "MEDIUM" ? 55 : 45 };
}

export async function qualifyOfficialShopeeImage(
  imageUrl: string,
  title: string,
  options: QualifyImageOptions = {},
): Promise<ShopeeImageQualification> {
  const probe = await probeOfficialShopeeImage(imageUrl, options);
  if (!probe.ok) {
    return {
      state: "HARD_REJECT",
      reason: probe.reason || "IMAGE_INVALID",
      probe,
      assessment: null,
      curationReason: null,
      visualScore: 0,
    };
  }
  const reviewer = options.reviewer ?? ((images, productTitle) => reviewProductImages(images, productTitle, { allowRepair: false, maxImages: 1 }));
  let curation: ProductImageCuration;
  try {
    curation = await reviewer([imageUrl], title);
  } catch {
    curation = {
      status: "review_required",
      rawImageUrls: [imageUrl],
      galleryImageUrls: [],
      assessments: [],
      reason: "image_review_unavailable",
    };
  }
  return classifyReviewedShopeeImage({ probe, curation });
}

export function controlledShopeeQueryVariants(query: string): string[] {
  const original = String(query || "").replace(/\s+/g, " ").trim();
  if (!original) return [];
  const normalized = normalizeText(original);
  const expectedCategory = resolvePublicProductCategory("", { title: original });
  if (expectedCategory !== "Iluminação" || !/(?:luminaria|abajur|lampada|lustre|arandela|iluminacao)/.test(normalized)) return [original];
  const variants = [
    original,
    "luminária de mesa",
    "luminária pendente",
    "abajur",
    "luminária decorativa",
    "iluminação decorativa",
  ];
  return variants.filter((value, index) => variants.findIndex(candidate => normalizeText(candidate) === normalizeText(value)) === index);
}

export function evaluateShopeeCandidateRelevance(query: string, officialTitle: string): {
  compatible: boolean;
  category: string;
  score: number;
  reason: string;
} {
  const queryCategory = resolvePublicProductCategory("", { title: query });
  const candidateCategory = resolvePublicProductCategory("", { title: officialTitle });
  if (queryCategory && candidateCategory && queryCategory !== candidateCategory) {
    return { compatible: false, category: candidateCategory, score: 0, reason: "CATEGORY_MISMATCH" };
  }

  const queryTokens = meaningfulTokens(query);
  const titleNormalized = normalizeText(officialTitle);
  const matched = queryTokens.filter(token => titleNormalized.includes(token));
  const tokenCoverage = queryTokens.length > 0 ? matched.length / queryTokens.length : 0;
  const categoryMatch = Boolean(queryCategory && candidateCategory && queryCategory === candidateCategory);
  const lightingIntentMatch = queryCategory !== "Iluminação" || /(?:luminaria|abajur|pendente|lampada|lustre|arandela|iluminacao)/.test(titleNormalized);
  if (!lightingIntentMatch) return { compatible: false, category: candidateCategory || queryCategory || "", score: 0, reason: "INTENT_MISMATCH" };
  if (!categoryMatch && tokenCoverage === 0) return { compatible: false, category: candidateCategory || queryCategory || "", score: 0, reason: "LOW_RELEVANCE" };

  const phraseMatch = titleNormalized.includes(normalizeText(query)) ? 1 : 0;
  const score = Math.round((categoryMatch ? 55 : 20) + tokenCoverage * 35 + phraseMatch * 10);
  return { compatible: true, category: candidateCategory || queryCategory || "", score: Math.min(100, score), reason: "RELEVANT" };
}

export function rankShopeeCandidates<T extends ShopeeRankableCandidate>(candidates: readonly T[]): T[] {
  const stateWeight: Record<ShopeeCandidateVisualState, number> = {
    QUALIFIED: 220,
    NEEDS_HUMAN_REVIEW: 100,
    HARD_REJECT: -10_000,
  };
  return [...candidates].sort((left, right) => {
    const leftState = left.imageQualification?.state ?? "HARD_REJECT";
    const rightState = right.imageQualification?.state ?? "HARD_REJECT";
    const leftScore = left.relevanceScore * 10 + stateWeight[leftState] + (left.imageQualification?.visualScore ?? 0);
    const rightScore = right.relevanceScore * 10 + stateWeight[rightState] + (right.imageQualification?.visualScore ?? 0);
    if (rightScore !== leftScore) return rightScore - leftScore;
    const leftIdentity = `${left.shopId}:${left.itemId}`;
    const rightIdentity = `${right.shopId}:${right.itemId}`;
    return leftIdentity.localeCompare(rightIdentity);
  });
}

export function safeShopeeImageDiagnostic(input: {
  candidateIndex: number;
  imagePresent: boolean;
  qualification: ShopeeImageQualification;
}): Record<string, unknown> {
  const { qualification } = input;
  return {
    candidateIndex: input.candidateIndex,
    imagePresent: input.imagePresent,
    httpStatus: qualification.probe.httpStatus,
    mimeType: qualification.probe.mimeType || "unknown",
    dimensions: qualification.probe.width && qualification.probe.height
      ? `${qualification.probe.width}x${qualification.probe.height}`
      : "unknown",
    contentTypeDetected: qualification.assessment?.decision || qualification.probe.format || "unknown",
    classification: qualification.state,
    reason: qualification.reason,
    definitive: qualification.state === "HARD_REJECT",
  };
}
