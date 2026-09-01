import test from "node:test";
import assert from "node:assert/strict";
import { AUTONOMOUS_CURATOR_PROFILES, AUTONOMOUS_CURATOR_PROFILE_VERSION, profileForCategory } from "../server/services/autonomousCuratorProfiles";
import { inferPublicProductCategory } from "../src/lib/productCategory";

test("curator 1.9 combines broad marketplace recall with precise category coverage", () => {
  assert.equal(AUTONOMOUS_CURATOR_PROFILE_VERSION, "1.9");
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

test("Infantil 1.9 mirrors manual Shopee recall without removing safety blocks", () => {
  const infant = profileForCategory("Infantil");
  for (const query of ["infantil", "brinquedo infantil", "calcado infantil", "babuch infantil", "brinquedo madeira", "brinquedo montessori"]) {
    assert.ok(infant.queries.includes(query), `Infantil precisa buscar ${query}`);
  }
  for (const term of ["brinquedo madeira", "montessori", "babuch infantil", "calcado infantil", "country infantil"]) {
    assert.ok(infant.strongStyleTerms.includes(term), `Infantil precisa reconhecer ${term}`);
  }
  for (const themed of ["tematico", "temática", "tematica", "caminhao", "caminhão"]) {
    assert.ok(!infant.blockedTerms.includes(themed), `Infantil não deve bloquear tema lúdico por si só: ${themed}`);
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