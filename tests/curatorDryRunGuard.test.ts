import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { assertCuratorMutationAllowed, curatorGuardedSupabaseFetch, isCuratorDryRun, withCuratorDryRun } from "../server/lib/curatorDryRunGuard";

test("SDK writes and RPCs are blocked before transport, even if SDK catches the error", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("[]", { headers: { "Content-Type": "application/json" } }); };
  try {
    const client = createClient("https://dry-run-test.supabase.co", "test-key", {
      global: { fetch: curatorGuardedSupabaseFetch }, auth: { persistSession: false, autoRefreshToken: false },
    });
    await withCuratorDryRun(async () => { await client.from("products").select("id"); });
    assert.equal(calls, 1);
    for (const write of [
      () => client.from("products").insert({ id: "x" }),
      () => client.from("products").update({ ativo: false }).eq("id", "x"),
      () => client.from("products").upsert({ id: "x" }),
      () => client.from("telegram_pending_reviews").delete().eq("id", "x"),
      () => client.rpc("publish_product"),
      () => client.rpc("publish_product", {}, { get: true }),
    ]) {
      await assert.rejects(withCuratorDryRun(async () => { await write(); }), /DRY_RUN/);
    }
    assert.equal(calls, 1, "no mutation request reached transport");
  } finally { globalThis.fetch = original; }
});

test("caught mutation attempts poison the proof and context stays isolated", async () => {
  await Promise.all([
    assert.rejects(withCuratorDryRun(async () => {
      await Promise.resolve();
      try { assertCuratorMutationAllowed("catalog_sync"); } catch { /* adapter swallowed it */ }
    }), /BLOCKED_MUTATION_ATTEMPT/),
    (async () => { await Promise.resolve(); assert.equal(isCuratorDryRun(), false); assertCuratorMutationAllowed("normal_operation"); })(),
  ]);
  assert.equal(isCuratorDryRun(), false);
});

test("nested dry-run cannot erase a caught mutation attempt", async () => {
  await assert.rejects(withCuratorDryRun(async () => {
    try { await withCuratorDryRun(async () => assertCuratorMutationAllowed("telegram_message")); } catch { /* caught */ }
  }), /BLOCKED_MUTATION_ATTEMPT/);
});

test("Telegram transport and catalog sync reject dry-run before starting work", async () => {
  const { telegramApiFetch } = await import("../server/services/telegramApiClient");
  const { syncCatalogAndDeploy } = await import("../server/services/catalogSync");
  await assert.rejects(withCuratorDryRun(() => telegramApiFetch("sendMessage", {})), /MUTATION_BLOCKED:telegram_api/);
  await assert.rejects(withCuratorDryRun(() => syncCatalogAndDeploy("test")), /MUTATION_BLOCKED:catalog_sync/);
});
