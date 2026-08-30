import test from "node:test";
import assert from "node:assert/strict";
import { AUTONOMOUS_CURATOR_PROFILES, AUTONOMOUS_CURATOR_PROFILE_VERSION } from "../server/services/autonomousCuratorProfiles";
import { inferPublicProductCategory } from "../src/lib/productCategory";
import { cheapProfileScore } from "../server/services/autonomousCuratorScoring";

test("curator 1.3 keeps broad and unique discovery coverage per category", () => {
  assert.equal(AUTONOMOUS_CURATOR_PROFILE_VERSION, "1.3");
  assert.equal(AUTONOMOUS_CURATOR_PROFILES.length, 10);

  for (const profile of AUTONOMOUS_CURATOR_PROFILES) {
    assert.ok(profile.queries.length >= 8, `${profile.category} precisa de pelo menos 8 consultas de descoberta`);
    assert.equal(new Set(profile.queries).size, profile.queries.length, `${profile.category} possui consultas duplicadas`);
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

test("seasonal and off-style products are rejected by the cheap profile gate", () => {
  const kitchen = AUTONOMOUS_CURATOR_PROFILES.find(profile => profile.category === "Cozinha & Mesa")!;
  const decor = AUTONOMOUS_CURATOR_PROFILES.find(profile => profile.category === "Decoração")!;
  const accessories = AUTONOMOUS_CURATOR_PROFILES.find(profile => profile.category === "Calçados & Acessórios")!;

  assert.equal(cheapProfileScore(kitchen, "Porta Guardanapos de Natal em Metal"), -1000);
  assert.equal(cheapProfileScore(decor, "Relógio Decorativo Moto Vintage Steampunk"), -1000);
  assert.equal(cheapProfileScore(accessories, "Cinto Country Masculino de Couro"), -1000);
});
