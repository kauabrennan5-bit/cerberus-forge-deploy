import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTONOMOUS_CURATOR_PROFILES,
  AUTONOMOUS_CURATOR_PROFILE_VERSION,
  profileForCategory,
} from "../server/services/autonomousCuratorProfiles";

const expandedCategories = [
  "Decoração",
  "Móveis",
  "Calçados & Acessórios",
  "Tecnologia",
  "Infantil",
] as const;

test("profile 1.5 expands recall only where production still has empty categories", () => {
  assert.equal(AUTONOMOUS_CURATOR_PROFILE_VERSION, "1.5");
  for (const category of expandedCategories) {
    const profile = profileForCategory(category);
    assert.ok(profile.queries.length >= 12, `${category} must expose at least twelve discovery queries`);
    assert.equal(new Set(profile.queries).size, profile.queries.length, `${category} queries must remain unique`);
  }
});

test("all official Shopee discovery keywords stay bounded and non-empty", () => {
  for (const profile of AUTONOMOUS_CURATOR_PROFILES) {
    for (const query of profile.queries) {
      assert.ok(query.trim().length > 0, `${profile.category} has an empty query`);
      assert.ok(query.length <= 60, `${profile.category} query exceeds Shopee keyword limit: ${query}`);
    }
  }
});

test("recall expansion does not alter category price gates", () => {
  assert.deepEqual(
    expandedCategories.map(category => {
      const profile = profileForCategory(category);
      return [category, profile.maxAutoPrice, profile.maxReviewPrice];
    }),
    [
      ["Decoração", 350, 600],
      ["Móveis", 900, 1500],
      ["Calçados & Acessórios", 300, 450],
      ["Tecnologia", 700, 1200],
      ["Infantil", 300, 500],
    ],
  );
});
