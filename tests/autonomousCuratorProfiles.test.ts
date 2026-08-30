import test from "node:test";
import assert from "node:assert/strict";
import { AUTONOMOUS_CURATOR_PROFILES, AUTONOMOUS_CURATOR_PROFILE_VERSION } from "../server/services/autonomousCuratorProfiles";
import { inferPublicProductCategory } from "../src/lib/productCategory";

test("curator 1.4 keeps precise and unique discovery coverage per category", () => {
  assert.equal(AUTONOMOUS_CURATOR_PROFILE_VERSION, "1.4");
  assert.equal(AUTONOMOUS_CURATOR_PROFILES.length, 10);

  for (const profile of AUTONOMOUS_CURATOR_PROFILES) {
    assert.ok(profile.queries.length >= 8, `${profile.category} precisa de pelo menos 8 consultas de descoberta`);
    assert.equal(new Set(profile.queries).size, profile.queries.length, `${profile.category} possui consultas duplicadas`);
    assert.ok(profile.strongStyleTerms.length >= 8, `${profile.category} precisa de vocabulário estético forte`);
    assert.ok(profile.signatureTerms.length >= 8, `${profile.category} precisa de sinais de forma/material`);
    assert.ok(profile.maxAutoPrice > 0 && profile.maxReviewPrice >= profile.maxAutoPrice, `${profile.category} precisa de limites de valor coerentes`);
    for (const query of profile.queries) {
      assert.ok(query.trim().length >= 8, `${profile.category} possui consulta curta demais`);
    }
  }
});

test("discovery queries never contain deterministic evidence for another category", () => {
  for (const profile of AUTONOMOUS_CURATOR_PROFILES) {
    for (const query of profile.queries) {
      const inferred = inferPublicProductCategory({ title: query });
      assert.ok(
        inferred === "" || inferred === profile.category,
        `${profile.category}: '${query}' infere ${inferred} antes do enriquecimento`,
      );
    }
  }
});
