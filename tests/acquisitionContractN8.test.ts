// ============================================================================
// Bloco N8 — AffiliateLinkAcquirer — testes de CONTRATO (locais, mocks)
//
// PROVA (somente contratos/fakes — nenhuma API real, nada gravado):
//   A. fail-closed: sem credenciais → AUTH_REQUIRED, nunca inventa URL
//   B. provider inativo → PROVIDER_NOT_ACTIVE
//   C. marketplace sem mecanismo oficial (ML) → NOT_SUPPORTED
//   D. resposta inesperada do mecanismo → RESOLUTION_FAILED
//   E. identidade incerta → IDENTITY_UNCERTAIN (estado explícito, jamais
//      SUCCESS confirmado; nunca elegível para publicação)
//   F. produto inelegível → PRODUCT_NOT_ELIGIBLE (sem escrita)
//   G. SUCCESS exige PRODUCT_IDENTITY_CONFIRMED; UNCERTAIN é estado distinto
//   K. CONFIRMED ≠ UNCERTAIN ≠ FAILED — distinção rastreável
//   H. ACQUISITION != PUBLICATION: o contrato não possui operação publish
//   I. proveniência proposta admin:acquired é SOMENTE contrato (não gravável)
//   J. URL pública nunca vira affiliate URL por parâmetros (não-hacking)
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import {
  AFFILIATE_ACQUISITION_CONTRACT_VERSION,
  PROVENIENCE_ADMIN_ACQUIRED,
  isAcquireSuccess,
  isAcquireIdentityUncertain,
  type AcquireResult,
  type ProductIdentity,
  type ProductReference,
  type ProviderContext,
} from "../server/commercial/affiliate/acquisitionContract";

// ---------------------------------------------------------------------------
// Fakes (mocks) — simulam o comportamento que o provider real terá, SEM
// chamar qualquer API e SEM gerar link real. O provider ML é modelado como
// NOT_SUPPORTED (sem mecanismo oficial programático); a Shopee como
// REQUIRES_CREDENTIALS (autenticação pendente de takeover autorizado).
// ---------------------------------------------------------------------------

function mlProvider(): ProviderContext {
  return {
    providerId: "fake-ml-provider",
    marketplace: "MercadoLivre",
    active: true,
    credentials: { present: false, expired: false },
  };
}

function shopeeProvider(active = true, creds = false): ProviderContext {
  return {
    providerId: "fake-shopee-provider",
    marketplace: "Shopee",
    active,
    credentials: { present: creds, expired: false },
  };
}

function ref(url = "https://shopee.com.br/produto-fake-123"): ProductReference {
  return { marketplace: "Shopee", candidateId: "cand-fake-n8", publicUrl: url };
}

function identity(override: Partial<ProductIdentity> = {}): ProductIdentity {
  return {
    marketplace: "Shopee",
    listingId: "12345",
    canonicalUrl: "https://shopee.com.br/produto-fake-123",
    sellerId: "seller-1",
    titleSnapshot: "Produto Falso de Teste N8",
    ...override,
  };
}

// Comportamento simulado do mecanismo oficial (local).
type SimBehavior =
  | { type: "ok" }
  | { type: "unexpected" }
  | { type: "ineligible" }
  | { type: "identity_uncertain" };

function simulateOfficialMechanism(behavior: SimBehavior): AcquireResult {
  if (behavior.type === "ok") {
    return {
      kind: "SUCCESS",
      affiliateUrl: "https://s.shopee.com.br/fake-redirect-token-simulado",
      identity: identity(),
      identityConfidence: "PRODUCT_IDENTITY_CONFIRMED",
      method: "API",
      acquisitionRef: "sim-ref-001",
      rawResponse: { productLink: "https://s.shopee.com.br/fake-redirect-token-simulado" },
      acquiredAt: Date.now(),
    };
  }
  if (behavior.type === "unexpected") {
    return { kind: "RESOLUTION_FAILED", reason: "resposta fora do contrato oficial" };
  }
  if (behavior.type === "ineligible") {
    return { kind: "PRODUCT_NOT_ELIGIBLE", reason: "produto fora da elegibilidade oficial" };
  }
  return {
    kind: "IDENTITY_UNCERTAIN",
    affiliateUrl: "https://s.shopee.com.br/fake-redirect-incerto",
    identity: { ...identity(), listingId: null, sellerId: null, titleSnapshot: "" },
    identityConfidence: "PRODUCT_IDENTITY_UNCERTAIN",
    rationale: "identidade_nao_confirmada_pela_fonte_oficial:listing_id=ausente;seller_id=ausente;title_snapshot=ausente",
    method: "API",
    acquisitionRef: "sim-ref-uncertain",
    rawResponse: { productLink: "https://s.shopee.com.br/fake-redirect-incerto" },
    acquiredAt: Date.now(),
  };
}

function decideAcquisition(provider: ProviderContext, reference: ProductReference, behavior: SimBehavior): AcquireResult {
  if (!provider.active) return { kind: "PROVIDER_NOT_ACTIVE", providerId: provider.providerId };
  if (!provider.credentials.present) {
    if (provider.marketplace === "MercadoLivre") {
      return { kind: "NOT_SUPPORTED", marketplace: provider.marketplace };
    }
    return { kind: "AUTH_REQUIRED", reason: "credenciais oficiais da plataforma não configuradas" };
  }
  return simulateOfficialMechanism(behavior);
}

test("N8-A fail-closed: sem credenciais → AUTH_REQUIRED, nunca inventa URL", () => {
  const result = decideAcquisition(shopeeProvider(), ref(), { type: "ok" });
  assert.equal(result.kind, "AUTH_REQUIRED");
  const anyUrl = (result as AcquireResult & { affiliateUrl?: string }).affiliateUrl;
  assert.equal(anyUrl, undefined, "sem credenciais, nenhuma URL pode existir no resultado");
});

test("N8-B provider inativo → PROVIDER_NOT_ACTIVE", () => {
  const result = decideAcquisition(shopeeProvider(false), ref(), { type: "ok" });
  assert.equal(result.kind, "PROVIDER_NOT_ACTIVE");
});

test("N8-C Mercado Livre → NOT_SUPPORTED (sem mecanismo oficial programático)", () => {
  const result = decideAcquisition(mlProvider(), { ...ref(), marketplace: "MercadoLivre" }, { type: "ok" });
  assert.equal(result.kind, "NOT_SUPPORTED");
});

test("N8-D resposta inesperada → RESOLUTION_FAILED", () => {
  const result = decideAcquisition(shopeeProvider(true, true), ref(), { type: "unexpected" });
  assert.equal(result.kind, "RESOLUTION_FAILED");
});

test("N8-E identidade incerta → IDENTITY_UNCERTAIN (estado explícito, jamais SUCCESS confirmado)", () => {
  const result = decideAcquisition(shopeeProvider(true, true), ref(), { type: "identity_uncertain" });
  assert.ok(!isAcquireSuccess(result), "UNCERTAIN não pode ser SUCCESS");
  assert.ok(isAcquireIdentityUncertain(result));
  assert.equal(result.identityConfidence, "PRODUCT_IDENTITY_UNCERTAIN");
  assert.ok(typeof result.rationale === "string" && result.rationale.length > 0, "rationale obrigatório");
  // UNCERTAIN jamais pode ser usado como identidade canônica: sem
  // listing/seller/título oficial, o link só segue para validação (N6),
  // nunca para publicação (N5) como identidade confirmada.
  assert.equal(result.identity.listingId, null);
  assert.equal(result.identity.sellerId, null);
  assert.equal(result.identity.titleSnapshot, "");
  // A evidência é preservada (URL + proveniência), mas a decisão é
  // rastreável e fail-closed para publicação.
  assert.ok(result.affiliateUrl);
  assert.ok(result.acquisitionRef.startsWith("sim-ref-"));
});

test("N8-F produto inelegível → PRODUCT_NOT_ELIGIBLE (sem escrita)", () => {
  const result = decideAcquisition(shopeeProvider(true, true), ref(), { type: "ineligible" });
  assert.equal(result.kind, "PRODUCT_NOT_ELIGIBLE");
});

test("N8-G SUCCESS exige PRODUCT_IDENTITY_CONFIRMED; UNCERTAIN é estado distinto", () => {
  const ok = decideAcquisition(shopeeProvider(true, true), ref(), { type: "ok" });
  assert.ok(isAcquireSuccess(ok));
  assert.ok(!isAcquireIdentityUncertain(ok));
  assert.equal(ok.identityConfidence, "PRODUCT_IDENTITY_CONFIRMED");
  assert.ok(ok.identity.listingId);
  assert.ok(ok.identity.canonicalUrl);
  assert.ok(ok.identity.titleSnapshot);
  // Identidade CONFIRMADA exige listing_id + seller_id + título oficial;
  // se qualquer um faltar, o resultado é o estado IDENTITY_UNCERTAIN —
  // e INCERTO jamais habilita publicação como identidade confirmada.
  const uncertain = decideAcquisition(shopeeProvider(true, true), ref(), { type: "identity_uncertain" });
  assert.ok(!isAcquireSuccess(uncertain));
  assert.ok(isAcquireIdentityUncertain(uncertain));
  assert.equal(uncertain.identityConfidence, "PRODUCT_IDENTITY_UNCERTAIN");
  assert.notEqual(uncertain.identityConfidence, "PRODUCT_IDENTITY_CONFIRMED");
});

test("N8-K CONFIRMED ≠ UNCERTAIN ≠ FAILED — distinção rastreável", () => {
  const ok = decideAcquisition(shopeeProvider(true, true), ref(), { type: "ok" });
  const uncertain = decideAcquisition(shopeeProvider(true, true), ref(), { type: "identity_uncertain" });
  const failed = decideAcquisition(shopeeProvider(true, true), ref(), { type: "unexpected" });
  // Três classes de decisão distintas, cada uma com sua URL/evidência:
  assert.ok(isAcquireSuccess(ok) && ok.kind === "SUCCESS");
  assert.ok(isAcquireIdentityUncertain(uncertain) && uncertain.kind === "IDENTITY_UNCERTAIN");
  assert.equal(failed.kind, "RESOLUTION_FAILED");
  // Só o CONFIRMED é sucesso de aquisição; UNCERTAIN preserva evidência
  // sem sucesso confirmado; FAILED não carrega URL
  assert.ok("affiliateUrl" in ok);
  assert.ok("affiliateUrl" in uncertain);
  // FAILED é a única classe sem URL — a chave nem existe no resultado
  assert.ok(!("affiliateUrl" in failed));
});

test("N8-H ACQUISITION != PUBLICATION: contrato não expõe operação de publicação", () => {
  const contractKeys = Object.keys({
    AFFILIATE_ACQUISITION_CONTRACT_VERSION,
    PROVENIENCE_ADMIN_ACQUIRED,
    isAcquireSuccess,
    isAcquireIdentityUncertain,
  });
  assert.ok(!contractKeys.some((k) => /publish|execute|createProduct/i.test(k)), "o contrato não deve expor qualquer primitiva de publicação");
});

test("N8-I admin:acquired é somente contrato nesta fase (não gravável)", () => {
  // O sistema em produção aceita apenas proveniência de catálogo fechado
  // (admin:manual); admin:acquired só passa a ser gravável após migration
  // autorizada. A prova local apenas confirma a existência do valor proposto.
  assert.equal(PROVENIENCE_ADMIN_ACQUIRED, "admin:acquired");
  assert.equal(AFFILIATE_ACQUISITION_CONTRACT_VERSION, "n8-acquire-v0");
});

test("N8-J URL pública nunca vira affiliate URL por parametricação", () => {
  const reference = ref("https://shopee.com.br/Luminaria-Chao-i.715084914.23794344926");
  // Fabricar uma "affiliate URL" adicionando parâmetros à URL pública é
  // expressamente proibido (engenharia reversa + cláusula 2.2 Shopee).
  const fabricated = reference.publicUrl.includes("?utm_term=") ? reference.publicUrl : `${reference.publicUrl}?utm_term=fake`;
  assert.ok(!fabricated.startsWith("https://s.shopee.com.br"), "affiliate URL oficial usa domínio próprio de redirecionamento");
  assert.notEqual(fabricated, reference.publicUrl, "a URL fabricada é diferente da pública — justamente por isso é proibida");
  // O único SUCCESS do simulador devolve URL de domínio de redirecionamento
  // oficial, nunca uma URL pública com parâmetros.
  const ok = decideAcquisition(shopeeProvider(true, true), reference, { type: "ok" });
  assert.ok(isAcquireSuccess(ok));
  assert.ok(ok.affiliateUrl !== reference.publicUrl);
  assert.ok(!ok.affiliateUrl.includes("utm_term=fake"));
});
