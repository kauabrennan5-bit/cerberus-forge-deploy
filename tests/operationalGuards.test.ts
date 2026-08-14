import assert from "node:assert/strict";
import test from "node:test";
import { ExternalCallBudget, InMemoryRateLimiter } from "../server/services/operationalGuards";

test("rate limiter permite o limite e retorna retry-after após exceder", () => {
  let now = 1_000;
  const limiter = new InMemoryRateLimiter(2, 1_000, 10, () => now);

  assert.equal(limiter.check("ip-a").allowed, true);
  assert.equal(limiter.check("ip-a").allowed, true);
  const blocked = limiter.check("ip-a");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfterSeconds, 1);

  now += 1_001;
  assert.equal(limiter.check("ip-a").allowed, true);
});

test("rate limiter isola buckets por chave", () => {
  const limiter = new InMemoryRateLimiter(1, 1_000, 10, () => 1_000);
  assert.equal(limiter.check("ip-a").allowed, true);
  assert.equal(limiter.check("ip-b").allowed, true);
  assert.equal(limiter.check("ip-a").allowed, false);
});

test("external call budget bloqueia acima do limite e reseta por janela", () => {
  let now = 1_000;
  const budget = new ExternalCallBudget({ gemini: 2 }, 1_000, () => now);
  assert.equal(budget.reserve("gemini").allowed, true);
  assert.equal(budget.reserve("gemini").allowed, true);
  assert.equal(budget.reserve("gemini").allowed, false);
  now += 1_001;
  assert.equal(budget.reserve("gemini").allowed, true);
});
