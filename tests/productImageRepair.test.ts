import test from "node:test";
import assert from "node:assert/strict";
import { productImageRepairInternals } from "../server/services/productImageRepair";

test("repair escolhe primeiro uma imagem com defeito editorial corrigível", () => {
  const raw = ["https://img.example.com/unknown.jpg", "https://img.example.com/promo.jpg"];
  const chosen = productImageRepairInternals.chooseRepairSource(raw, [
    { url: raw[0], decision: "unknown", confidence: "LOW", reason: "incerto" },
    { url: raw[1], decision: "promotional", confidence: "HIGH", reason: "overlay" },
  ] as any);
  assert.equal(chosen, raw[1]);
});

test("repair rejeita fonte privada/local", () => {
  assert.equal(productImageRepairInternals.chooseRepairSource(["http://localhost/a.png"], []), null);
});
