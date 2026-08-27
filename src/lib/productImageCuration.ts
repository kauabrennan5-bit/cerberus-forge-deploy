export type ProductImageEditorialStatus = "clean" | "overlay_suspected" | "unreviewed" | "review_required";

export type ProductImageAssessment = {
  url: string;
  decision: "clean" | "technical" | "promotional" | "logo" | "collage" | "screenshot" | "unknown";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
};

export type ProductImageCuration = {
  status: "ready" | "review_required";
  rawImageUrls: string[];
  primaryImageUrl?: string;
  galleryImageUrls: string[];
  assessments: ProductImageAssessment[];
  reason?: "no_images" | "no_commercial_image" | "image_review_unavailable";
};

const REJECTED_DECISIONS = new Set<ProductImageAssessment["decision"]>([
  "technical",
  "promotional",
  "logo",
  "collage",
  "screenshot",
]);

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
    return {
      status: "review_required",
      rawImageUrls,
      galleryImageUrls: [],
      assessments: normalizedAssessments,
      reason: assessments.length === 0 ? "image_review_unavailable" : "no_commercial_image",
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

export function orderCanonicalImageSet(curation: ProductImageCuration): string[] {
  return curation.status === "ready" && curation.primaryImageUrl
    ? [curation.primaryImageUrl, ...curation.galleryImageUrls]
    : [];
}
