import type { Product } from "../../src/types";
import type { ProductImageCuration } from "../../src/lib/productImageCuration";
import type { AutonomousCuratorCategoryProfile } from "./autonomousCuratorProfiles";

export type AutonomousCuratorScoreBreakdown = {
  pipelineQuality: number;
  styleFit: number;
  novelty: number;
  imageQuality: number;
  categoryFit: number;
  completeness: number;
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
    if (needle && haystack.includes(` ${needle} `)) return term;
  }
  return null;
}

export function cheapProfileScore(profile: AutonomousCuratorCategoryProfile, title: string): number {
  const normalizedTitle = normalize(title);
  if (!normalizedTitle) return 0;
  if (hasBlockedProfileTerm(profile, title)) return -1000;
  const hits = profile.preferredTerms.filter(term => normalizedTitle.includes(normalize(term))).length;
  const queryVocabulary = new Set(profile.queries.flatMap(query => [...tokens(query)]));
  const titleTokens = tokens(title);
  let queryHits = 0;
  for (const token of titleTokens) if (queryVocabulary.has(token)) queryHits += 1;
  return hits * 20 + queryHits * 5;
}

function styleFit(profile: AutonomousCuratorCategoryProfile, text: string): number {
  const normalizedText = normalize(text);
  const uniqueHits = new Set(profile.preferredTerms.filter(term => normalizedText.includes(normalize(term))));
  // Sem evidência explícita do vocabulário estético/material da categoria, o
  // produto pode ir para revisão, mas não deve alcançar auto-publicação apenas
  // porque os demais gates são perfeitos. Um hit real já torna o fit forte.
  return Math.min(100, 35 + uniqueHits.size * 25);
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
      categoryFit: 0,
      completeness: 0,
      maximumCatalogSimilarity: 1,
      finalScore: 0,
    };
  }

  const similarity = maximumCatalogSimilarity(input.displayTitle, input.category, input.existingProducts);
  const novelty = Math.max(0, Math.min(100, Math.round((1 - similarity) * 100)));
  const style = styleFit(input.profile, `${input.rawTitle} ${input.displayTitle} ${input.description}`);
  const image = imageQuality(input.imageCuration);
  const categoryFit = input.category === input.profile.category ? 100 : 0;
  const complete = input.displayTitle.trim().length >= 4
    && input.description.trim().length >= 24
    && Number.isFinite(input.price) && input.price > 0
    && input.imageCuration.status === "ready" && Boolean(input.imageCuration.primaryImageUrl)
    ? 100 : 0;
  const pipeline = Math.max(0, Math.min(100, Math.round(input.pipelineScore)));
  const finalScore = Math.round(
    pipeline * 0.25
    + style * 0.20
    + novelty * 0.20
    + image * 0.20
    + categoryFit * 0.10
    + complete * 0.05,
  );

  return {
    pipelineQuality: pipeline,
    styleFit: style,
    novelty,
    imageQuality: image,
    categoryFit,
    completeness: complete,
    maximumCatalogSimilarity: Number(similarity.toFixed(4)),
    finalScore,
  };
}
