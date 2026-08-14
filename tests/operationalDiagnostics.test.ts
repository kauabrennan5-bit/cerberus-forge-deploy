import test from "node:test";
import assert from "node:assert/strict";
import {
  createOperationId,
  createOperationalDiagnostic,
  formatDiagnosticForAdmin,
  sanitizeOperationalText,
} from "../server/services/operationalDiagnostics";

test("operation IDs possuem prefixo operacional e não reutilizam a mesma sequência", () => {
  const first = createOperationId("PUB");
  const second = createOperationId("PUB");
  assert.match(first, /^PUB-\d{14}-\d{4}$/);
  assert.notEqual(first, second);
});

test("sanitização remove padrões de token e access_token dos diagnósticos", () => {
  const value = "falha de diagnóstico com access_token=[REDACTED]";
  const sanitized = sanitizeOperationalText(value);
  assert.equal(sanitized.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), false);
  assert.equal(sanitized.includes("secret-value"), false);
  assert.match(sanitized, /REDACTED/);
});

test("diagnóstico estruturado preserva etapa, dependência e impacto sem causa sensível", () => {
  const diagnostic = createOperationalDiagnostic({
    operationId: "PUB-20260814120000-0001",
    operation: "PRODUCT_PUBLICATION",
    stage: "GITHUB_AUTH",
    dependency: "GitHub",
    code: "GITHUB_AUTH_ERROR",
    message: "Autenticação recusada.",
    likelyCause: "Token inválido ou sem permissão Contents.",
    impact: "O catálogo público não pode ser declarado publicado.",
    recoverability: "ADMIN_APPROVAL",
    retryable: false,
    cause: "Bad credentials github_pat_sensitive",
  });
  assert.equal(diagnostic.stage, "GITHUB_AUTH");
  assert.equal(diagnostic.dependency, "GitHub");
  assert.equal(diagnostic.cause?.includes("github_pat_sensitive"), false);
  assert.match(formatDiagnosticForAdmin(diagnostic), /GITHUB_AUTH_ERROR/);
});
