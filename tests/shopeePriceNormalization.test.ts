/**
 * D-SHOPEE-1 — normalização fail-closed do price string da Affiliate API
 * (Fase 17/14, PHASE14_SCHEMA_PROBE_20260820).
 *
 * A API oficial retorna `price` como string(non-empty) sem especificação
 * oficial de moeda/escala (BLOCKED — CONTRACT UNSPECIFIED). A conversão
 * aceita SOMENTE formas decimal-puras; qualquer ambiguidade → null
 * (dimensão PRICE permanece UNKNOWN).
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { parseShopeePriceString } from "../server/commercial/affiliate/shopeeApiClient";

test("aceita número já existente (regressão — price number continua válido)", () => {
  assert.equal(parseShopeePriceString(129.9), 129.9);
  assert.equal(parseShopeePriceString(0), 0);
  assert.equal(parseShopeePriceString(9900), 9900);
});

test("rejeita número não finito (NaN/Infinity)", () => {
  assert.equal(parseShopeePriceString(Number.NaN), null);
  assert.equal(parseShopeePriceString(Number.POSITIVE_INFINITY), null);
  assert.equal(parseShopeePriceString(Number.NEGATIVE_INFINITY), null);
});

test("aceita string decimal pura válida", () => {
  assert.equal(parseShopeePriceString("129.90"), 129.9);
  assert.equal(parseShopeePriceString("0.5"), 0.5);
  assert.equal(parseShopeePriceString(".5"), 0.5);
  assert.equal(parseShopeePriceString("3"), 3);
  assert.equal(parseShopeePriceString("0"), 0);
  assert.equal(parseShopeePriceString("   42.0   "), 42);
});

test("string inválida NÃO é promovida — formato pt-BR com milhar/vírgula", () => {
  assert.equal(parseShopeePriceString("1.200,00"), null);
  assert.equal(parseShopeePriceString("1,200.00"), null);
  assert.equal(parseShopeePriceString("1200,00"), null);
});

test("string inválida NÃO é promovida — moeda/símbolo/texto embutido", () => {
  assert.equal(parseShopeePriceString("R$ 10"), null);
  assert.equal(parseShopeePriceString("$10"), null);
  assert.equal(parseShopeePriceString("10 BRL"), null);
  assert.equal(parseShopeePriceString("preço 10"), null);
  assert.equal(parseShopeePriceString("grátis"), null);
});

test("string inválida NÃO é promovida — formas numéricas ambíguas", () => {
  assert.equal(parseShopeePriceString("1e3"), null);
  assert.equal(parseShopeePriceString("1E3"), null);
  assert.equal(parseShopeePriceString("-5"), null);
  assert.equal(parseShopeePriceString("+5"), null);
  assert.equal(parseShopeePriceString("--3"), null);
  assert.equal(parseShopeePriceString("12."), null);
});

test("string vazia e só espaços → null (fail-closed)", () => {
  assert.equal(parseShopeePriceString(""), null);
  assert.equal(parseShopeePriceString("   "), null);
});

test("ausência ou tipo não suportado → null (fail-closed)", () => {
  assert.equal(parseShopeePriceString(null), null);
  assert.equal(parseShopeePriceString(undefined), null);
  assert.equal(parseShopeePriceString(true), null);
  assert.equal(parseShopeePriceString({}), null);
  assert.equal(parseShopeePriceString([]), null);
});

test("ambíguos nunca viram número — valores extremos que JS toleraria", () => {
  assert.equal(parseShopeePriceString("Infinity"), null);
  assert.equal(parseShopeePriceString("NaN"), null);
  assert.equal(parseShopeePriceString("0x10"), null);
});

test("resultado sempre finito quando aceito", () => {
  const cases = ["0", "1", "99999999.999", ".001"];
  for (const c of cases) {
    const r = parseShopeePriceString(c);
    assert.ok(r !== null && Number.isFinite(r), `case ${c}`);
  }
});

// O parser interno (extractOfferNodes) é privado; sua propagação é
// exercitada pela integração shopeeAffiliateIntegration.test.ts, que
// continua passando com price number (regressão). A normalização do
// price string é validada por todos os testes de parseShopeePriceString
// acima — o único ponto de conversão é price: parseShopeePriceString(...).
