import type { Product } from "../../src/types";
import type { ProductImageCuration } from "../../src/lib/productImageCuration";
import type { AutonomousCuratorCategoryProfile } from "./autonomousCuratorProfiles";

export type AutonomousCuratorScoreBreakdown = {
  pipelineQuality: number;
  styleFit: number;
  novelty: number;
  imageQuality: number;
  valueFit: number;
  categoryFit: number;
  completeness: number;
  strongStyleHits: number;
  signatureHits: number;
  maximumCatalogSimilarity: number;
  finalScore: number;
};

export type AutonomousCuratorScoreInput = {
  profile: AutonomousCuratorCategoryProfile;
  rawTitle: string;
  displayTitle: string;
  description: string;
  category: string;
  price: number;
  imageCuration: ProductImageCuration;
  pipelineScore: number;
  existingProducts: readonly Product[];
};

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): Set<string> {
  return new Set(normalize(value).split(" ").filter(token => token.length >= 3));
}

function includesTerm(normalizedText: string, term: string): boolean {
  const normalizedTerm = normalize(term);
  if (!normalizedTerm) return false;
  return ` ${normalizedText} `.includes(` ${normalizedTerm} `) || normalizedText.includes(normalizedTerm);
}

function aestheticSignals(profile: AutonomousCuratorCategoryProfile, text: string): { strong: number; signature: number } {
  const normalizedText = normalize(text);
  const strong = new Set(profile.strongStyleTerms.filter(term => includesTerm(normalizedText, term))).size;
  const signature = new Set(profile.signatureTerms.filter(term => includesTerm(normalizedText, term))).size;
  return { strong, signature };
}

export function tokenJaccard(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export function hasBlockedProfileTerm(profile: AutonomousCuratorCategoryProfile, text: string): string | null {
  const haystack = ` ${normalize(text)} `;
  for (const term of profile.blockedTerms) {
    const needle = normalize(term);
    if (needle && (haystack.includes(` ${needle} `) || haystack.includes(` ${needle}`))) return term;
  }
  return null;
}

export function cheapProfileScore(profile: AutonomousCuratorCategoryProfile, title: string): number {
  const normalizedTitle = normalize(title);
  if (!normalizedTitle) return -1000;
  if (hasBlockedProfileTerm(profile, title)) return -1000;
  const signals = aestheticSignals(profile, title);
  const queryVocabulary = new Set(profile.queries.flatMap(query => [...tokens(query)]));
  const titleTokens = tokens(title);
  let queryHits = 0;
  for (const token of titleTokens) if (queryVocabulary.has(token)) queryHits += 1;

  // This remains the cheap lexical lane. Semantic Discovery V2 can rescue
  // otherwise invisible marketplace titles before expensive enrichment; this
  // function intentionally keeps its old sentinel for callers without OpenAI.
  if (signals.strong === 0 && signals.signature === 0 && queryHits < 2) return -1000;

  const aestheticScore = signals.strong * 60 + signals.signature * 14;
  const vocabularyScore = Math.min(10, queryHits) * 4;
  const recallFloor = signals.strong > 0 || signals.signature > 0 ? 8 : 0;
  return aestheticScore + vocabularyScore + recallFloor;
}

function styleFit(profile: AutonomousCuratorCategoryProfile, text: string): { score: number; strong: number; signature: number } {
  const signals = aestheticSignals(profile, text);
  let score = 0;
  if (signals.strong >= 2) score = 100;
  else if (signals.strong === 1 && signals.signature >= 2) score = 98;
  else if (signals.strong === 1 && signals.signature === 1) score = 94;
  else if (signals.strong === 1) score = 86;
  else if (signals.signature >= 5) score = 82;
  else if (signals.signature === 4) score = 75;
  else if (signals.signature === 3) score = 68;
  else if (signals.signature === 2) score = 55;
  else if (signals.signature === 1) score = 30;
  return { score, strong: signals.strong, signature: signals.signature };
}

function imageQuality(curation: ProductImageCuration): number {
  if (curation.status !== "ready" || !curation.primaryImageUrl) return 0;
  const clean = curation.assessments.filter(item => item.decision === "clean" && item.confidence !== "LOW");
  if (clean.length === 0) return 0;
  const confidence = clean.map(item => item.confidence === "HIGH" ? 100 : 82);
  const average = confidence.reduce((sum, score) => sum + score, 0) / confidence.length;
  const coverageBonus = Math.min(8, Math.max(0, clean.length - 1) * 2);
  return Math.min(100, Math.round(average + coverageBonus));
}

function visualStyleEvidence(curation: ProductImageCuration): number {
  if (curation.status !== "ready" || !curation.primaryImageUrl) return 0;
  const clean = curation.assessments.filter(item => item.decision === "clean" && item.confidence !== "LOW");
  if (clean.length === 0) return 0;
  const high = clean.filter(item => item.confidence === "HIGH").length;
  const medium = clean.filter(item => item.confidence === "MEDIUM").length;

  // `clean` is not merely a photographic label: the authoritative visual
  // reviewer only emits it when the object itself is convincingly Cerberus.
  // This lets image evidence rescue terse/SEO marketplace copy without ever
  // lowering the existing style threshold of 72 or bypassing blocked terms.
  if (high >= 2) return 86;
  if (high === 1 && clean.length >= 2) return 82;
  if (high === 1) return 78;
  if (medium >= 2) return 75;
  return 72;
}

function valueFit(profile: AutonomousCuratorCategoryProfile, price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  if (price <= profile.maxAutoPrice) return 100;
  if (price <= profile.maxReviewPrice) return 65;
  return 0;
}

export function maximumCatalogSimilarity(displayTitle: string, category: string, existingProducts: readonly Product[]): number {
  let max = 0;
  for (const product of existingProducts) {
    const existingTitle = product.displayTitle || product.produto || "";
    let similarity = tokenJaccard(displayTitle, existingTitle);
    if (product.categoria === category) similarity = Math.min(1, similarity + 0.08);
    if (similarity > max) max = similarity;
  }
  return max;
}

export function scoreAutonomousCandidate(input: AutonomousCuratorScoreInput): AutonomousCuratorScoreBreakdown {
  const blocked = hasBlockedProfileTerm(input.profile, `${input.rawTitle} ${input.displayTitle} ${input.description}`);
  if (blocked) {
    return {
      pipelineQuality: 0,
      styleFit: 0,
      novelty: 0,
      imageQuality: 0,
      valueFit: 0,
      categoryFit: 0,
      completeness: 0,
      strongStyleHits: 0,
      signatureHits: 0,
      maximumCatalogSimilarity: 1,
      finalScore: 0,
    };
  }

  const similarity = maximumCatalogSimilarity(input.displayTitle, input.category, input.existingProducts);
  const novelty = Math.max(0, Math.min(100, Math.round((1 - similarity) * 100)));
  const textualStyle = styleFit(input.profile, `${input.rawTitle} ${input.displayTitle} ${input.description}`);
  const styleScore = Math.max(textualStyle.score, visualStyleEvidence(input.imageCuration));
  const image = imageQuality(input.imageCuration);
  const value = valueFit(input.profile, input.price);
  const categoryFit = input.category === input.profile.category ? 100 : 0;
  const complete = input.displayTitle.trim().length >= 4
    && input.description.trim().length >= 24
    && Number.isFinite(input.price) && input.price > 0
    && input.imageCuration.status === "ready" && Boolean(input.imageCuration.primaryImageUrl)
    ? 100 : 0;
  const pipeline = Math.max(0, Math.min(100, Math.round(input.pipelineScore)));

  let finalScore = Math.round(
    pipeline * 0.15
    + styleScore * 0.35
    + novelty * 0.15
    + image * 0.15
    + value * 0.10
    + categoryFit * 0.05
    + complete * 0.05,
  );

  // Gates Cerberus remain absolute. The threshold does not move; the only
  // change is that reviewed visual evidence can now satisfy the same style gate
  // when marketplace copy fails to name the design language explicitly.
  if (styleScore < 72 || value === 0 || categoryFit === 0 || complete === 0 || image === 0) {
    finalScore = Math.min(finalScore, 71);
  }

  return {
    pipelineQuality: pipeline,
    styleFit: styleScore,
    novelty,
    imageQuality: image,
    valueFit: value,
    categoryFit,
    completeness: complete,
    strongStyleHits: textualStyle.strong,
    signatureHits: textualStyle.signature,
    maximumCatalogSimilarity: Number(similarity.toFixed(4)),
    finalScore,
  };
}

export const autonomousCuratorScoringInternals = {
  visualStyleEvidence,
};
