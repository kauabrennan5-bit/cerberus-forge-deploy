import type { AutonomousCuratorCategoryProfile } from "./autonomousCuratorProfiles";
import {
  runAutonomousCuratorContinuousV2,
  type ContinuousCuratorCategoryResultV2,
} from "./autonomousCuratorContinuousV2";

const DAY_MS = 24 * 60 * 60 * 1000;
const QUEUE_CREATED_BY = "autonomous_curator_queue";
const QUEUE_NOTE_PREFIX = "AUTONOMOUS_CURATOR_QUEUE_V1:";

type QueueMetadata = {
  score: number;
  profileVersion: string;
  queuedAt: string;
  query: string;
  shopId: string;
  itemId: string;
  sourceProductUrl: string;
};

export type ContinuousCuratorCategoryResult = Omit<ContinuousCuratorCategoryResultV2, "searchedPages">;

export type ContinuousCuratorResult = {
  cycleId: string;
  runId: string;
  runDate: string;
  status: "completed" | "partial" | "failed" | "disabled";
  publishedThisCycle: number;
  fulfilledCategories: number;
  queuedProducts: number;
  categories: ContinuousCuratorCategoryResult[];
};

type ContinuousOptions = Parameters<typeof runAutonomousCuratorContinuousV2>[0];

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

function queueTarget(env: NodeJS.ProcessEnv): number {
  return positiveInt(env.AUTONOMOUS_CURATOR_QUEUE_TARGET_PER_CATEGORY, 7, 30);
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function rotatedQueries(profile: AutonomousCuratorCategoryProfile, cycleKey: string): string[] {
  if (profile.queries.length <= 1) return [...profile.queries];
  const start = hashSeed(`${cycleKey}:${profile.category}`) % profile.queries.length;
  return [...profile.queries.slice(start), ...profile.queries.slice(0, start)];
}

function queueNote(meta: QueueMetadata): string {
  return `${QUEUE_NOTE_PREFIX}${JSON.stringify(meta)}`;
}

function parseQueueNote(value: unknown): QueueMetadata | null {
  const text = String(value || "");
  if (!text.startsWith(QUEUE_NOTE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(text.slice(QUEUE_NOTE_PREFIX.length)) as Partial<QueueMetadata>;
    if (!Number.isFinite(Number(parsed.score)) || !parsed.shopId || !parsed.itemId || !parsed.sourceProductUrl || !parsed.queuedAt || !parsed.query) return null;
    return {
      score: Number(parsed.score),
      profileVersion: String(parsed.profileVersion || "unknown"),
      queuedAt: String(parsed.queuedAt),
      query: String(parsed.query),
      shopId: String(parsed.shopId),
      itemId: String(parsed.itemId),
      sourceProductUrl: String(parsed.sourceProductUrl),
    };
  } catch {
    return null;
  }
}

function dueForPublication(lastPublishedAt: string | null, now: Date): boolean {
  if (!lastPublishedAt) return true;
  const timestamp = Date.parse(lastPublishedAt);
  return !Number.isFinite(timestamp) || now.getTime() - timestamp >= DAY_MS;
}

function revalidationPermanentFailure(reason: string): boolean {
  const transient = [
    "TIMEOUT", "RATE_LIMIT", "NETWORK", "TRANSIENT", "UNAVAILABLE", "MODEL_UNAVAILABLE",
    "IMAGE_FETCH_UNAVAILABLE", "AUTH_ERROR", "FORBIDDEN", "SHOPEE_SEARCH",
  ];
  return !transient.some(marker => reason.toUpperCase().includes(marker));
}

/**
 * Compatibility entrypoint for legacy callers.
 *
 * Publication code deliberately does not exist in this module. Every call is
 * delegated to the review-only V2 coordinator and the compatibility response
 * defensively reports zero autonomous publications.
 */
export async function runAutonomousCuratorContinuous(options: ContinuousOptions = {}): Promise<ContinuousCuratorResult> {
  const result = await runAutonomousCuratorContinuousV2(options);
  return {
    cycleId: result.cycleId,
    runId: result.runId,
    runDate: result.runDate,
    status: result.status,
    publishedThisCycle: 0,
    fulfilledCategories: result.fulfilledCategories,
    queuedProducts: result.queuedProducts,
    categories: result.categories.map(({ searchedPages: _searchedPages, ...category }) => ({
      ...category,
      published: false,
    })),
  };
}

export const autonomousCuratorContinuousInternals = {
  DAY_MS,
  QUEUE_CREATED_BY,
  QUEUE_NOTE_PREFIX,
  dueForPublication,
  queueNote,
  parseQueueNote,
  rotatedQueries,
  queueTarget,
  revalidationPermanentFailure,
};
