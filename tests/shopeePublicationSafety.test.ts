import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProductPipeline, type LifecycleRecord } from "../server/services/productPipeline";
import { getPendingReview, isReviewMutationAllowed, setTestGetPendingReview } from "../server/repositories/telegramRepository";
import {
  ProductRotationSearchError,
  type RotationSearchDiagnostics,
} from "../server/services/productRotation";
import { telegramProductRotationInternals } from "../server/services/telegramProductRotation";

function approvedRecord(): LifecycleRecord {
  return {
    id: "lifecycle-test",
    state: "APPROVED",
    candidate: {
      state: "APPROVED",
      normalizedUrl: "https://shopee.com.br/Luminaria-i.1530442944.23794344926",
      link: "https://s.shopee.com.br/affiliate-test",
      marketplace: "Shopee",
      produto: "Luminária de Mesa Bauhaus",
      rawTitle: "Luminária de Mesa observada",
      displayTitle: "Luminária de Mesa Bauhaus",
      categoria: "Iluminação",
      preco: 79.9,
      imagens: ["https://img.example.com/lamp.webp"],
      imageEditorialStatus: "clean",
      descricao: "Luminária compacta com acabamento verificável e proporções adequadas para interiores.",
    } as any,
    validation: { outcome: "PASS", errors: [], warnings: [] },
    curation: {
      score: 95,
      category: "Iluminação",
      confidence: "HIGH",
      reasons: ["evidência suficiente"],
      risks: [],
      recommendation: "PUBLISH",
    },
    audit: [],
  };
}

function diagnostics(overrides: Partial<RotationSearchDiagnostics> = {}): RotationSearchDiagnostics {
  return {
    correlationId: "rotation-test",
    provider: "ShopeeApiClient",
    queriesAttempted: 1,
    providerQueriesExecuted: 1,
    candidatesReceived: 12,
    candidatesInPool: 5,
    candidatesExamined: 5,
    rejectionCounts: {
      IDENTITY_MISSING: 7,
      SOURCE_IDENTITY_ALREADY_OWNED: 3,
      IMAGE_HTTPS_MISSING: 2,
    },
    ...overrides,
  };
}

afterEach(() => {
  setTestGetPendingReview(null);
});

describe("publication preflight", () => {
  it("não cria produto canônico quando o preflight Shopee bloqueia após aprovação humana", async () => {
    let created = 0;
    let synced = 0;
    const pipeline = new ProductPipeline({
      getProducts: async () => [],
      preflightPublication: async () => ({ ok: false, code: "SHOPEE_PREFLIGHT_PRICE_CHANGED" }),
      createCanonicalProduct: async () => {
        created += 1;
        throw new Error("não deveria criar produto");
      },
      syncAndValidatePublication: async () => {
        synced += 1;
        return { success: true };
      },
      pauseCanonicalProduct: async () => undefined,
    });

    const result = await pipeline.publish(approvedRecord());

    assert.equal(result.state, "APPROVED");
    assert.equal(result.error, "VALIDATION_ERROR");
    assert.equal(created, 0);
    assert.equal(synced, 0);
    assert.equal(result.audit.some(event => String(event.reason).includes("PUBLICATION_PREFLIGHT_BLOCKED:SHOPEE_PREFLIGHT_PRICE_CHANGED")), true);
  });

  it("só chama persistência depois de um preflight aprovado", async () => {
    let preflight = 0;
    let created = 0;
    const pipeline = new ProductPipeline({
      getProducts: async () => [],
      preflightPublication: async () => {
        preflight += 1;
        return { ok: true, code: "SHOPEE_PUBLICATION_PREFLIGHT_OK" };
      },
      createCanonicalProduct: async () => {
        created += 1;
        return { id: "prod-test", produto: "Luminária", preco: 79.9 } as any;
      },
      syncAndValidatePublication: async () => ({ success: true }),
      pauseCanonicalProduct: async () => undefined,
    });

    const result = await pipeline.publish(approvedRecord());

    assert.equal(preflight, 1);
    assert.equal(created, 1);
    assert.equal(result.state, "PUBLISHED");
  });
});

describe("callback antigo", () => {
  it("review expirada permanece auditável, mas não pode ser reativada por mutação", async () => {
    const expired = {
      id: "expired-review",
      chatId: 123456,
      senderId: 123456,
      firstName: "Test",
      username: "test",
      createdAt: Date.now() - 2 * 60 * 60 * 1000,
      expiresAt: Date.now() - 1000,
      produto: "Luminária",
      categoria: "Iluminação",
      preco: 79.9,
      imagens: ["https://img.example.com/lamp.webp"],
      normalizedUrl: "https://shopee.com.br/Luminaria-i.1530442944.23794344926",
      status: "expired" as const,
    };
    setTestGetPendingReview(async () => expired as any);

    const review = await getPendingReview("expired-review");
    assert.equal(review?.status, "expired");
    assert.equal(isReviewMutationAllowed({ ...expired, status: "publishing" } as any), false);
    assert.equal(isReviewMutationAllowed(expired as any), true);
  });
});

describe("falhas da rotação", () => {
  it("provider não configurado nunca é apresentado como NO_QUALIFIED_REPLACEMENT_FOUND", () => {
    const rendered = telegramProductRotationInternals.rotationSearchFailureMessage(
      new ProductRotationSearchError("SHOPEE_PROVIDER_NOT_CONFIGURED", diagnostics({ providerQueriesExecuted: 0, candidatesReceived: 0 })),
    );

    assert.match(rendered.text, /ROTAÇÃO BLOQUEADA — PROVIDER SHOPEE NÃO CONFIGURADO/);
    assert.match(rendered.text, /SHOPEE_PROVIDER_NOT_CONFIGURED/);
    assert.equal(rendered.text.includes("ROTAÇÃO SEM CANDIDATO APROVADO"), false);
    assert.equal(rendered.retryable, false);
  });

  it("timeout/indisponibilidade são apresentados como falha temporária e preservam a peça atual", () => {
    const rendered = telegramProductRotationInternals.rotationSearchFailureMessage(
      new ProductRotationSearchError("SHOPEE_PROVIDER_TIMEOUT", diagnostics({ candidatesReceived: 4 })),
    );

    assert.match(rendered.text, /PROVIDER SHOPEE INDISPONÍVEL/);
    assert.match(rendered.text, /SHOPEE_PROVIDER_TIMEOUT/);
    assert.match(rendered.text, /peça atual continua publicada/i);
    assert.equal(rendered.retryable, true);
  });

  it("NO_QUALIFIED só é descrito como ausência após busca executada e traz contagens/rejeições", () => {
    const rendered = telegramProductRotationInternals.rotationSearchFailureMessage(
      new ProductRotationSearchError("NO_QUALIFIED_REPLACEMENT_FOUND", diagnostics()),
    );

    assert.match(rendered.text, /ROTAÇÃO SEM CANDIDATO APROVADO/);
    assert.match(rendered.text, /busca executada: sim/);
    assert.match(rendered.text, /candidatos recebidos: 12/);
    assert.match(rendered.text, /7× IDENTITY_MISSING/);
    assert.match(rendered.text, /3× SOURCE_IDENTITY_ALREADY_OWNED/);
    assert.match(rendered.text, /2× IMAGE_HTTPS_MISSING/);
    assert.match(rendered.text, /peça atual continua publicada/i);
  });

  it("falha ao persistir candidato é distinguida de ausência de candidato", () => {
    const rendered = telegramProductRotationInternals.rotationSearchFailureMessage(
      new ProductRotationSearchError("ROTATION_CANDIDATE_PERSIST_FAILED", diagnostics()),
    );

    assert.match(rendered.text, /CANDIDATO NÃO PERSISTIDO/);
    assert.equal(rendered.text.includes("ROTAÇÃO SEM CANDIDATO APROVADO"), false);
  });
});
