import test from "node:test";
import assert from "node:assert/strict";
import { sanitizePublicCuratorNote } from "../src/lib/publicCuratorNote";

test("metadado interno do Autonomous Curator nunca vira nota publica", () => {
  const value = 'AUTONOMOUS_CURATOR_QUEUE_V1:{"score":95,"query":"arandela bauhaus"}';
  assert.equal(sanitizePublicCuratorNote(value), undefined);
});

test("prefixo interno e bloqueado independentemente de caixa", () => {
  assert.equal(
    sanitizePublicCuratorNote('autonomous_curator_queue_v2:{"score":90}'),
    undefined,
  );
});

test("nota editorial humana continua publica", () => {
  assert.equal(
    sanitizePublicCuratorNote("  Seleção forte pela geometria e pelo contraste de materiais.  "),
    "Seleção forte pela geometria e pelo contraste de materiais.",
  );
});

test("nota vazia nao e renderizada", () => {
  assert.equal(sanitizePublicCuratorNote("   "), undefined);
});
