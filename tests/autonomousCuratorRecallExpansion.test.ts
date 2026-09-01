import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTONOMOUS_CURATOR_PROFILES,
  AUTONOMOUS_CURATOR_PROFILE_VERSION,
  profileForCategory,
} from "../server/services/autonomousCuratorProfiles";

const recoveryCategories = [
  "Móveis",
  "Organização",
  "Calçados & Acessórios",
  "Beleza & Bem-estar",
  "Infantil",
] as const;

test("profile 1.8 expands recall for categories that can fall behind the cumulative daily floor", () => {
  assert.equal(AUTONOMOUS_CURATOR_PROFILE_VERSION, "1.8");
  for (const category of recoveryCategories) {
    const profile = profileForCategory(category);
    assert.ok(profile.queries.length >= 12, `${category} must expose at least twelve discovery queries`);
    assert.equal(new Set(profile.queries).size, profile.queries.length, `${category} queries must remain unique`);
  }
});

test("sparse-category recovery uses concrete Cerberus archetypes without changing final gates", () => {
  const expected = new Map([
    ["Móveis", ["mesa lateral cromada", "banqueta tubular"]],
    ["Organização", ["porta revistas cromado", "gaveteiro modular"]],
    ["Calçados & Acessórios", ["oculos acetato", "mocassim camurca"]],
    ["Beleza & Bem-estar", ["espelho mesa cromado", "porta perfume vintage"]],
    ["Infantil", ["brinquedo madeira", "montessori", "brinquedo encaixe madeira"]],
  ] as const);

  for (const [category, archetypes] of expected) {
    const profile = profileForCategory(category);
    for (const archetype of archetypes) {
      assert.ok(profile.strongStyleTerms.includes(archetype), `${category} is missing recovery archetype ${archetype}`);
    }
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

test("recovery expansion does not alter category price gates", () => {
  assert.deepEqual(
    recoveryCategories.map(category => {
      const profile = profileForCategory(category);
      return [category, profile.maxAutoPrice, profile.maxReviewPrice];
    }),
    [
      ["Móveis", 900, 1500],
      ["Organização", 220, 350],
      ["Calçados & Acessórios", 300, 450],
      ["Beleza & Bem-estar", 300, 500],
      ["Infantil", 300, 500],
    ],
  );
});