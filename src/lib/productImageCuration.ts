export type ProductImageEditorialStatus = "clean" | "overlay_suspected" | "unreviewed" | "review_required";

export type ProductImageAssessment = {
  url: string;
  decision: "clean" | "technical" | "promotional" | "logo" | "collage" | "screenshot" | "off_brand" | "incomplete" | "novelty" | "unknown";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
};

export type ProductImageCurationReason =
  | "no_images"
  | "no_commercial_image"
  | `no_commercial_image:${string}`
  | "image_review_unavailable"
  | "image_review_budget_exhausted"
  | "image_fetch_unavailable"
  | "image_review_model_unavailable";

export type ProductImageCuration = {
  status: "ready" | "review_required";
  rawImageUrls: string[];
  primaryImageUrl?: string;
  galleryImageUrls: string[];
  assessments: ProductImageAssessment[];
  reason?: ProductImageCurationReason;
};

const REJECTED_DECISIONS = new Set<ProductImageAssessment["decision"]>([
  "technical",
  "promotional",
  "logo",
  "collage",
  "screenshot",
  "off_brand",
  "incomplete",
  "novelty",
]);

const DECISION_ORDER: readonly ProductImageAssessment["decision"][] = [
  "clean",
  "off_brand",
  "incomplete",
  "novelty",
  "technical",
  "promotional",
  "logo",
  "collage",
  "screenshot",
  "unknown",
];
const CONFIDENCE_ORDER: readonly ProductImageAssessment["confidence"][] = ["HIGH", "MEDIUM", "LOW"];

/**
 * Diagnóstico deliberadamente limitado a enums internos + contagens. Nunca
 * persiste `reason` textual do modelo ou qualquer conteúdo do anúncio.
 */
export function summarizeProductImageAssessments(assessments: readonly ProductImageAssessment[]): string {
  const counts = new Map<string, number>();
  for (const assessment of assessments) {
    const key = `${assessment.decision}_${assessment.confidence.toLowerCase()}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const parts: string[] = [];
  for (const decision of DECISION_ORDER) {
    for (const confidence of CONFIDENCE_ORDER) {
      const key = `${decision}_${confidence.toLowerCase()}`;
      const count = counts.get(key) || 0;
      if (count > 0) parts.push(`${key}=${count}`);
    }
  }
  return parts.join(",");
}

function isPublicHttpsImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
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

function normalizeHttpsImages(images: readonly string[]): string[] {
  return images
    .filter((image): image is string => typeof image === "string")
    .map(image => image.trim())
    .filter(Boolean)
    .filter(isPublicHttpsImageUrl)
    .filter((image, index, list) => list.indexOf(image) === index);
}

export function curateProductImages(
  rawImages: readonly string[],
  assessments: readonly ProductImageAssessment[] = [],
): ProductImageCuration {
  const rawImageUrls = normalizeHttpsImages(rawImages);
  if (rawImageUrls.length === 0) {
    return {
      status: "review_required",
      rawImageUrls,
      galleryImageUrls: [],
      assessments: [],
      reason: "no_images",
    };
  }

  const assessmentByUrl = new Map(
    assessments
      .filter(assessment => rawImageUrls.includes(assessment.url))
      .map(assessment => [assessment.url, assessment] as const),
  );
  const normalizedAssessments = rawImageUrls.map(url => assessmentByUrl.get(url)).filter((assessment): assessment is ProductImageAssessment => Boolean(assessment));
  const cleanCandidates = rawImageUrls.filter(url => {
    const assessment = assessmentByUrl.get(url);
    return assessment?.decision === "clean" && assessment.confidence !== "LOW";
  });

  if (cleanCandidates.length === 0) {
    const diagnostic = summarizeProductImageAssessments(normalizedAssessments);
    return {
      status: "review_required",
      rawImageUrls,
      galleryImageUrls: [],
      assessments: normalizedAssessments,
      reason: assessments.length === 0
        ? "image_review_unavailable"
        : diagnostic ? `no_commercial_image:${diagnostic}` : "no_commercial_image",
    };
  }

  const primaryImageUrl = cleanCandidates[0];
  const galleryImageUrls = cleanCandidates.slice(1);
  return {
    status: "ready",
    rawImageUrls,
    primaryImageUrl,
    galleryImageUrls,
    assessments: normalizedAssessments,
  };
}

export function isCommercialImageAssessment(assessment: ProductImageAssessment | undefined): boolean {
  return Boolean(assessment && assessment.decision === "clean" && assessment.confidence !== "LOW");
}

export function isRejectedImageAssessment(assessment: ProductImageAssessment | undefined): boolean {
  return Boolean(assessment && REJECTED_DECISIONS.has(assessment.decision));
}

/** Rejeições que descrevem o produto, não um defeito editorial da fotografia. */
export function isNonRepairableProductImageRejection(assessment: ProductImageAssessment | undefined): boolean {
  return Boolean(
    assessment
    && assessment.confidence !== "LOW"
    && ["off_brand", "incomplete", "novelty"].includes(assessment.decision),
  );
}

export function orderCanonicalImageSet(curation: ProductImageCuration): string[] {
  return curation.status === "ready" && curation.primaryImageUrl
    ? [curation.primaryImageUrl, ...curation.galleryImageUrls]
    : [];
}
