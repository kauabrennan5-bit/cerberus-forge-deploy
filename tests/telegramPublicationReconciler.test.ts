import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { reconcileStaleTelegramPublications } from "../server/services/telegramPublicationReconciler";

const migrationUrl = new URL("../supabase/migrations/20260908002035_human_approval_publication_boundary.sql", import.meta.url);
const telegramBotCoreUrl = new URL("../server/services/telegramBotCore.ts", import.meta.url);

test("reconciler delegates bounded TTL work and summarizes existing-product recovery", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const result = await reconcileStaleTelegramPublications({ ttlMinutes: 20, limit: 25 }, {
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: [{ review_id: "review-1", outcome: "published", published_product_id: "product-1" }], error: null };
    },
  });
  assert.deepEqual(calls, [{
    name: "reconcile_stale_telegram_publications",
    args: { p_ttl: "20 minutes", p_limit: 25 },
  }]);
  assert.deepEqual(result, {
    status: "ok",
    inspected: 1,
    published: 1,
    released: 0,
    active: 0,
    rows: [{ review_id: "review-1", outcome: "published", published_product_id: "product-1" }],
  });
});

test("repeated and concurrent reconciler calls remain idempotent at the RPC boundary", async () => {
  let claimed = false;
  const rpc = async () => {
    if (claimed) return { data: [], error: null };
    claimed = true;
    await Promise.resolve();
    return { data: [{ review_id: "review-1", outcome: "released_to_error", published_product_id: null }], error: null };
  };
  const [first, second] = await Promise.all([
    reconcileStaleTelegramPublications({}, { rpc }),
    reconcileStaleTelegramPublications({}, { rpc }),
  ]);
  assert.equal(first.released + second.released, 1);
  assert.equal(first.inspected + second.inspected, 1);
});

test("SQL reconciles stale claims, leaves recent/finalized rows alone and serializes races", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /where r\.status = 'publishing'\s+and r\.updated_at < now\(\) - p_ttl/);
  assert.match(sql, /for update skip locked/);
  assert.match(sql, /where id = v_review\.id and status = 'publishing'/);
  assert.match(sql, /ppa\.review_id = v_review\.id/);
  assert.match(sql, /ppa\.operation_id = v_review\.data #>> '\{lifecycle,operationId\}'/);
  assert.match(sql, /psi\.shop_id = v_review\.data #>> '\{existingProduct,shopId\}'/);
  assert.match(sql, /ppa\.consumed_at is not null/);
  assert.match(sql, /p\.ativo is true\s+and p\.status = 'published'/);
  assert.ok((sql.match(/p\.ativo is true/g) || []).length >= 4, "toda estratégia de lookup confirma produto ativo");
  assert.ok((sql.match(/p\.status = 'published'/g) || []).length >= 4, "toda estratégia de lookup confirma publicação");
  assert.match(sql, /outcome := 'published'/);
  assert.match(sql, /outcome := 'active_execution'/);
  assert.match(sql, /outcome := 'released_to_error'/);
  assert.match(sql, /pe\.status in \('PENDING','VALIDATING','AUTHORIZED','EXECUTING'\)/);
  assert.match(sql, /set review_id = null,\s*reserved_run_id = null,\s*reserved_until = null/);
  assert.match(sql, /'type', 'PRODUCT_PUBLISHED'[\s\S]*'reason', 'Publicação confirmada pelo reconciliador idempotente\.'/);
  assert.match(sql, /grant execute on function public\.reconcile_stale_telegram_publications\(interval, integer\) to service_role/);
  assert.match(sql, /PRODUCT_PUBLICATION_AUTHORIZATION_IMMUTABLE_AFTER_CONSUMPTION/);
  assert.match(sql, /before update or delete on public\.product_publication_authorizations/);
  assert.doesNotMatch(sql, /where r\.id in \(/i);
});

test("an empty repeat performs no mutation and reports zero work", async () => {
  const result = await reconcileStaleTelegramPublications({}, { rpc: async () => ({ data: [], error: null }) });
  assert.equal(result.status, "ok");
  assert.equal(result.inspected, 0);
});

test("a callback that loses the publication CAS cannot release the winner's claim", async () => {
  const source = await readFile(telegramBotCoreUrl, "utf8");
  assert.match(source, /let publicationClaimAcquired = false;/);
  assert.match(
    source,
    /await telegramRepo\.savePendingReview\(review\);\s*publicationClaimAcquired = true;/,
  );
  assert.match(
    source,
    /if \(publicationClaimAcquired\) \{\s*review\.status = "error";/,
  );
  assert.match(source, /TELEGRAM_REVIEW_PUBLICATION_ALREADY_CLAIMED/);
});
