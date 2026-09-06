import type { Product } from "../../src/types";
import type { PendingReview } from "./telegramTypes";

export type AutonomousCuratorHumanTasteExample = {
  decision: "approved" | "rejected";
  category: string;
  title: string;
  description: string;
  price: number | null;
  createdAt: number;
  source: string;
  sourceUrl: string | null;
};

export type AutonomousCuratorHumanTasteModel = {
  version: "1.0";
  loadedAt: number;
  approved: AutonomousCuratorHumanTasteExample[];
  rejected: AutonomousCuratorHumanTasteExample[];
};

export type AutonomousCuratorHumanTasteScore = {
  fit: number;
  confidence: number;
  approvedSimilarity: number;
  rejectedSimilarity: number;
  lexicalSignal: number;
  adjustment: number;
  approvedExamples: number;
  rejectedExamples: number;
  categoryApprovedExamples: number;
  categoryRejectedExamples: number;
};

const EMPTY_MODEL: AutonomousCuratorHumanTasteModel = {
  version: "1.0",
  loadedAt: 0,
  approved: [],
  rejected: [],
};

let cachedModel: AutonomousCuratorHumanTasteModel = EMPTY_MODEL;

const STOP_WORDS = new Set([
  "a", "as", "ao", "aos", "com", "como", "da", "das", "de", "do", "dos", "e", "em", "na", "nas", "no", "nos",
  "o", "os", "ou", "para", "por", "sem", "um", "uma", "uns", "umas", "the", "and", "for", "with", "from", "style", "estilo",
  "produto", "product", "novo", "nova", "original", "decoracao", "decoração",
]);

function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function featureTokens(value: unknown): string[] {
  return normalize(value)
    .split(" ")
    .filter(token => token.length >= 3 && !STOP_WORDS.has(token) && !/^\d+$/.test(token));
}

function weightedFeatures(title: string, description: string): Map<string, number> {
  const features = new Map<string, number>();
  for (const token of featureTokens(title)) features.set(token, (features.get(token) || 0) + 2);
  for (const token of featureTokens(description).slice(0, 60)) features.set(token, (features.get(token) || 0) + 0.45);
  return features;
}

function weightedJaccard(
  leftTitle: string,
  leftDescription: string,
  rightTitle: string,
  rightDescription: string,
): number {
  const left = weightedFeatures(leftTitle, leftDescription);
  const right = weightedFeatures(rightTitle, rightDescription);
  if (left.size === 0 || right.size === 0) return 0;
  const keys = new Set([...left.keys(), ...right.keys()]);
  let intersection = 0;
  let union = 0;
  for (const key of keys) {
    const a = left.get(key) || 0;
    const b = right.get(key) || 0;
    intersection += Math.min(a, b);
    union += Math.max(a, b);
  }
  return union > 0 ? intersection / union : 0;
}

function numericPrice(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function timestamp(value: unknown, fallback = Date.now()): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function dedupeExamples(examples: AutonomousCuratorHumanTasteExample[]): AutonomousCuratorHumanTasteExample[] {
  const seen = new Set<string>();
  const output: AutonomousCuratorHumanTasteExample[] = [];
  for (const example of examples) {
    const key = example.sourceUrl
      ? `url:${normalize(example.sourceUrl)}`
      : `text:${normalize(example.category)}:${normalize(example.title)}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(example);
  }
  return output;
}

export function buildAutonomousCuratorHumanTasteModel(
  products: readonly Product[],
  reviews: readonly PendingReview[],
  now = Date.now(),
): AutonomousCuratorHumanTasteModel {
  const approved: AutonomousCuratorHumanTasteExample[] = [];
  for (const product of products) {
    const row = product as Product & { status?: string; createdAt?: string | number; created_at?: string | number };
    if (row.ativo === false) continue;
    if (row.status && row.status !== "published") continue;
    const title = String(row.displayTitle || row.produto || "").trim();
    const category = String(row.categoria || "").trim();
    if (!title || !category) continue;
    approved.push({
      decision: "approved",
      category,
      title,
      description: String(row.descricao || "").trim(),
      price: numericPrice(row.preco),
      createdAt: timestamp(row.createdAt ?? row.created_at, now),
      source: "catalog",
      sourceUrl: typeof row.link === "string" && row.link.trim() ? row.link.trim() : null,
    });
  }

  const rejected: AutonomousCuratorHumanTasteExample[] = [];
  for (const review of reviews) {
    if (review.status !== "rejected" && review.status !== "cancelled") continue;
    const title = String(review.displayTitle || review.produto || review.rawTitle || "").trim();
    const category = String(review.categoria || "").trim();
    if (!title || !category) continue;
    rejected.push({
      decision: "rejected",
      category,
      title,
      description: String(review.descricao || "").trim(),
      price: numericPrice(review.preco),
      createdAt: timestamp(review.createdAt, now),
      source: String(review.existingProduct?.source || "telegram"),
      sourceUrl: typeof review.normalizedUrl === "string" && review.normalizedUrl.trim() ? review.normalizedUrl.trim() : null,
    });
  }

  return {
    version: "1.0",
    loadedAt: now,
    approved: dedupeExamples(approved),
    rejected: dedupeExamples(rejected),
  };
}

export function setAutonomousCuratorHumanTasteModel(model: AutonomousCuratorHumanTasteModel | null): void {
  cachedModel = model || EMPTY_MODEL;
}

export function getAutonomousCuratorHumanTasteModel(): AutonomousCuratorHumanTasteModel {
  return cachedModel;
}

export function getAutonomousCuratorHumanTasteSummary(model: AutonomousCuratorHumanTasteModel = cachedModel) {
  const categories = new Set([...model.approved, ...model.rejected].map(example => example.category));
  return {
    version: model.version,
    loadedAt: model.loadedAt,
    approvedExamples: model.approved.length,
    rejectedExamples: model.rejected.length,
    categoriesLearned: categories.size,
  };
}

function recencyWeight(createdAt: number, now: number): number {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return 0.65;
  const ageDays = Math.max(0, (now - createdAt) / 86_400_000);
  return Math.max(0.4, Math.exp(-ageDays / 90));
}

function strongestSimilarity(
  title: string,
  description: string,
  category: string,
  examples: readonly AutonomousCuratorHumanTasteExample[],
  now: number,
): number {
  const sameCategory = examples.filter(example => example.category === category);
  const pool = sameCategory.length > 0 ? sameCategory : examples;
  const categoryFactor = sameCategory.length > 0 ? 1 : 0.58;
  let strongest = 0;
  for (const example of pool) {
    const similarity = weightedJaccard(title, description, example.title, example.description)
      * recencyWeight(example.createdAt, now)
      * categoryFactor;
    if (similarity > strongest) strongest = similarity;
  }
  return Math.min(1, strongest);
}

function tokenDocumentFrequency(examples: readonly AutonomousCuratorHumanTasteExample[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const example of examples) {
    const tokens = new Set(featureTokens(`${example.title} ${example.description}`));
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);
  }
  return frequencies;
}

function lexicalPreferenceSignal(
  title: string,
  description: string,
  category: string,
  approved: readonly AutonomousCuratorHumanTasteExample[],
  rejected: readonly AutonomousCuratorHumanTasteExample[],
): number {
  const categoryApproved = approved.filter(example => example.category === category);
  const categoryRejected = rejected.filter(example => example.category === category);
  const useCategory = categoryApproved.length + categoryRejected.length >= 4;
  const positivePool = useCategory ? categoryApproved : approved;
  const negativePool = useCategory ? categoryRejected : rejected;
  if (positivePool.length + negativePool.length === 0) return 0;

  const positive = tokenDocumentFrequency(positivePool);
  const negative = tokenDocumentFrequency(negativePool);
  const candidateTokens = [...new Set(featureTokens(`${title} ${description}`))].slice(0, 40);
  if (candidateTokens.length === 0) return 0;

  let sum = 0;
  let used = 0;
  for (const token of candidateTokens) {
    const pos = positive.get(token) || 0;
    const neg = negative.get(token) || 0;
    if (pos === 0 && neg === 0) continue;
    const logOdds = Math.log((pos + 1) / (neg + 1));
    sum += Math.max(-1.5, Math.min(1.5, logOdds)) / 1.5;
    used += 1;
  }
  return used > 0 ? Math.max(-1, Math.min(1, sum / used)) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function scoreAutonomousCuratorHumanTaste(input: {
  title: string;
  description?: string;
  category: string;
  price?: number | null;
  now?: number;
  model?: AutonomousCuratorHumanTasteModel;
}): AutonomousCuratorHumanTasteScore {
  const model = input.model || cachedModel;
  const now = input.now || Date.now();
  const approvedExamples = model.approved.length;
  const rejectedExamples = model.rejected.length;
  const categoryApprovedExamples = model.approved.filter(example => example.category === input.category).length;
  const categoryRejectedExamples = model.rejected.filter(example => example.category === input.category).length;
  if (approvedExamples + rejectedExamples === 0) {
    return {
      fit: 50,
      confidence: 0,
      approvedSimilarity: 0,
      rejectedSimilarity: 0,
      lexicalSignal: 0,
      adjustment: 0,
      approvedExamples,
      rejectedExamples,
      categoryApprovedExamples,
      categoryRejectedExamples,
    };
  }

  const description = input.description || "";
  const approvedSimilarity = strongestSimilarity(input.title, description, input.category, model.approved, now);
  const rejectedSimilarity = strongestSimilarity(input.title, description, input.category, model.rejected, now);
  const lexicalSignal = lexicalPreferenceSignal(input.title, description, input.category, model.approved, model.rejected);
  const fit = Math.round(clamp(50 + approvedSimilarity * 34 - rejectedSimilarity * 46 + lexicalSignal * 18, 0, 100));

  const sameCategoryExamples = categoryApprovedExamples + categoryRejectedExamples;
  const categoryConfidence = Math.min(1, sameCategoryExamples / 6);
  const globalConfidence = Math.min(1, (approvedExamples + rejectedExamples) / 18);
  const confidence = Number(clamp(categoryConfidence * 0.72 + globalConfidence * 0.28, 0, 1).toFixed(3));

  let adjustment = Math.round(((fit - 50) / 50) * 18 * confidence);
  if (rejectedSimilarity >= 0.56 && rejectedSimilarity > approvedSimilarity + 0.08) {
    adjustment = Math.min(adjustment, -Math.max(8, Math.round(18 * confidence)));
  }
  if (approvedSimilarity >= 0.46 && approvedSimilarity > rejectedSimilarity + 0.10) {
    adjustment = Math.max(adjustment, Math.max(6, Math.round(14 * confidence)));
  }
  adjustment = clamp(adjustment, -24, 18);

  return {
    fit,
    confidence,
    approvedSimilarity: Number(approvedSimilarity.toFixed(4)),
    rejectedSimilarity: Number(rejectedSimilarity.toFixed(4)),
    lexicalSignal: Number(lexicalSignal.toFixed(4)),
    adjustment,
    approvedExamples,
    rejectedExamples,
    categoryApprovedExamples,
    categoryRejectedExamples,
  };
}

export const autonomousCuratorHumanTasteInternals = {
  normalize,
  featureTokens,
  weightedJaccard,
  lexicalPreferenceSignal,
  recencyWeight,
};
