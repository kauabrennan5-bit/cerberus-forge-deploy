import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { profileForCategory } from "../server/services/autonomousCuratorProfiles";
import { autonomousCuratorContinuousInternals } from "../server/services/autonomousCuratorContinuous";

const {
  DAY_MS,
  QUEUE_CREATED_BY,
  QUEUE_NOTE_PREFIX,
  dueForPublication,
  queueNote,
  parseQueueNote,
  rotatedQueries,
  queueTarget,
  revalidationPermanentFailure,
} = autonomousCuratorContinuousInternals;

test("publication window becomes due only after a full 24 hours", () => {
  const now = new Date("2026-08-30T12:00:00.000Z");
  assert.equal(dueForPublication(null, now), true);
  assert.equal(dueForPublication(new Date(now.getTime() - DAY_MS + 1).toISOString(), now), false);
  assert.equal(dueForPublication(new Date(now.getTime() - DAY_MS).toISOString(), now), true);
  assert.equal(dueForPublication(new Date(now.getTime() - DAY_MS - 1).toISOString(), now), true);
});

test("paused queue metadata round-trips without losing source identity", () => {
  const metadata = {
    score: 97,
    profileVersion: "1.3",
    queuedAt: "2026-08-30T12:00:00.000Z",
    query: "luminaria cromada anos 70",
    shopId: "746010353",
    itemId: "58250661334",
    sourceProductUrl: "https://shopee.com.br/product/746010353/58250661334",
  };
  const encoded = queueNote(metadata);
  assert.ok(encoded.startsWith(QUEUE_NOTE_PREFIX));
  assert.deepEqual(parseQueueNote(encoded), metadata);
  assert.equal(parseQueueNote("anything else"), null);
  assert.equal(QUEUE_CREATED_BY, "autonomous_curator_queue");
});

test("hourly cycles rotate discovery while preserving every profile query", () => {
  const profile = profileForCategory("Iluminação");
  const expected = [...profile.queries].sort();
  const orders = new Set<string>();
  for (let hour = 0; hour < 24; hour += 1) {
    const order = rotatedQueries(profile, `2026-08-30T${String(hour).padStart(2, "0")}:17`);
    assert.deepEqual([...order].sort(), expected);
    assert.equal(new Set(order).size, profile.queries.length);
    orders.add(order.join("|"));
  }
  assert.ok(orders.size > 1, "ciclos horários precisam explorar ordens diferentes de consulta");
});

test("future queue target is bounded and defaults to seven products per category", () => {
  assert.equal(queueTarget({}), 7);
  assert.equal(queueTarget({ AUTONOMOUS_CURATOR_QUEUE_TARGET_PER_CATEGORY: "12" }), 12);
  assert.equal(queueTarget({ AUTONOMOUS_CURATOR_QUEUE_TARGET_PER_CATEGORY: "999" }), 30);
  assert.equal(queueTarget({ AUTONOMOUS_CURATOR_QUEUE_TARGET_PER_CATEGORY: "0" }), 7);
});

test("transient revalidation failures do not permanently discard a queued find", () => {
  assert.equal(revalidationPermanentFailure("AUTONOMOUS_CURATOR_EXTRACTOR_TIMEOUT"), false);
  assert.equal(revalidationPermanentFailure("AFFILIATE_rate_limited"), false);
  assert.equal(revalidationPermanentFailure("IMAGE_REVIEW_NOT_CLEAN_AFTER_REPAIR:image_review_model_unavailable"), false);
  assert.equal(revalidationPermanentFailure("PROFILE_BLOCKED_TERM:eiffel"), true);
  assert.equal(revalidationPermanentFailure("BELOW_AUTO_PUBLISH_THRESHOLD:81"), true);
});

test("queued product can revalidate its own bound Shopee identity but not another product identity", async () => {
  const source = await readFile(new URL("../server/services/autonomousCuratorContinuous.ts", import.meta.url), "utf8");
  assert.match(source, /allowedProductId\?: string \| null/);
  assert.match(source, /sourceIdentity\.productId !== input\.allowedProductId/);
  assert.match(source, /allowedProductId: input\.product\.id/);
});

test("production workflow runs scheduled quarter-hour cycles while deployment pushes remain read-only", async () => {
  const workflow = await readFile(new URL("../.github/workflows/autonomous-curator.yml", import.meta.url), "utf8");
  assert.match(workflow, /cron: "2,17,32,47 \* \* \* \*"/);
  assert.match(workflow, /github\.event_name == 'schedule' && 'continuous'/);
  assert.match(workflow, /github\.event_name == 'push' && 'status'/);
  assert.doesNotMatch(workflow, /github\.event_name == 'push' && 'continuous'/);
  assert.doesNotMatch(workflow, /github\.event_name == 'push' && 'dry_run'/);
  assert.match(workflow, /cerberus-autonomous-curator-status/);
  assert.match(workflow, /cerberus-autonomous-curator-production/);
  assert.match(workflow, /Wait for exact Render SHA after deployment/);
  assert.match(workflow, /api\/internal\/autonomous-curator\/status/);
  assert.match(workflow, /api\/internal\/autonomous-curator\/continuous/);
  assert.match(workflow, /continuous_cycle_id/);
});
