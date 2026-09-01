import test from "node:test";
import assert from "node:assert/strict";
import { AUTONOMOUS_CURATOR_PROFILES, AUTONOMOUS_CURATOR_PROFILE_VERSION, profileForCategory } from "../server/services/autonomousCuratorProfiles";
import { inferPublicProductCategory } from "../src/lib/productCategory";

test("curator 1.8 combines broad marketplace recall with precise category coverage", () => {
  assert.equal(AUTONOMOUS_CURATOR_PROFILE_VERSION, "1.8");
  assert.equal(AUTONOMOUS_CURATOR_PROFILES.length, 10);

  for (const profile of AUTONOMOUS_CURATOR_PROFILES) {
    assert.ok(profile.queries.length >= 12, `${profile.category} precisa de pelo menos 12 consultas de descoberta`);
    assert.equal(new Set(profile.queries).size, profile.queries.length, `${profile.category} possui consultas duplicadas`);
    assert.ok(profile.strongStyleTerms.length >= 8, `${profile.category} precisa de vocabulário estético forte`);
    assert.ok(profile.signatureTerms.length >= 8, `${profile.category} precisa de sinais de forma/material`);
    assert.ok(profile.maxAutoPrice > 0 && profile.maxReviewPrice >= profile.maxAutoPrice, `${profile.category} precisa de limites de valor coerentes`);
    for (const query of profile.queries) {
      assert.ok(query.trim().length >= 8, `${profile.category} possui consulta curta demais`);
    }
  }
});

test("Infantil 1.8 recognizes legitimate wooden and Montessori archetypes without removing safety blocks", () => {
  const infant = profileForCategory("Infantil");
  for (const query of ["brinquedo madeira", "brinquedo montessori", "brinquedo encaixe madeira", "arco iris madeira"]) {
    assert.ok(infant.queries.includes(query), `Infantil precisa buscar ${query}`);
  }
  for (const term of ["brinquedo madeira", "blocos madeira", "montessori", "waldorf", "brinquedo encaixe madeira"]) {
    assert.ok(infant.strongStyleTerms.includes(term), `Infantil precisa reconhecer ${term}`);
  }
  for (const blocked of ["arma brinquedo", "pistola", "laser forte", "personagem"]) {
    assert.ok(infant.blockedTerms.includes(blocked), `Infantil deve continuar bloqueando ${blocked}`);
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