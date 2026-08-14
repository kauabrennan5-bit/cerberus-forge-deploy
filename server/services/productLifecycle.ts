import { generateSlug } from "../../src/data/initialProducts";

import { detectMarketplace } from "./marketplace";

export type ProductLifecycleState =
  | "DISCOVERED" | "COLLECTING" | "COLLECTED" | "VALIDATING" | "ANALYZING" | "CURATING"
  | "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "PUBLISHED" | "PAUSED" | "ARCHIVED" | "ERROR";
export type ProductPipelineError = "VALIDATION_ERROR" | "DUPLICATE_ERROR" | "CURATION_ERROR" | "APPROVAL_REQUIRED" | "PERSISTENCE_ERROR" | "SYNC_ERROR" | "PUBLICATION_ERROR" | "EXTERNAL_SERVICE_ERROR";
export type ValidationOutcome = "PASS" | "WARNING" | "FAIL";
export type CurationRecommendation = "PUBLISH" | "REVIEW" | "REJECT";

export interface ProductLifecycleEvent {
  type: "PRODUCT_DISCOVERED" | "PRODUCT_VALIDATED" | "PRODUCT_REJECTED" | "PRODUCT_APPROVAL_REQUESTED" | "PRODUCT_APPROVED" | "PRODUCT_PUBLISHED" | "PRODUCT_PAUSED" | "PRODUCT_ARCHIVED" | "PRODUCT_PUBLICATION_FAILED";
  timestamp: string;
  state: ProductLifecycleState;
  reason: string;
}

export interface ProductCandidate {
  normalizedUrl: string;
  externalId?: string;
  marketplace: string;
  produto: string;
  descricao: string;
  categoria: string;
  preco: number | null;
  precoAntigo?: number | null;
  imagens: string[];
  slug: string;
  ref?: string;
  id?: string;
  state: ProductLifecycleState;
  discoveredAt: string;
}

export interface DuplicateFinding {
  kind: "EXACT_URL" | "EXTERNAL_ID" | "SLUG" | "SIMILAR_TITLE";
  productId?: string;
  details: string;
  potential: boolean;
}

export interface ProductValidation {
  outcome: ValidationOutcome;
  errors: string[];
  warnings: string[];
  duplicate?: DuplicateFinding;
}

export interface ProductCuration {
  score: number;
  category: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reasons: string[];
  risks: string[];
  recommendation: CurationRecommendation;
}

const TRANSITIONS: Record<ProductLifecycleState, ProductLifecycleState[]> = {
  DISCOVERED: ["COLLECTING", "ERROR", "REJECTED"],
  COLLECTING: ["COLLECTED", "ERROR", "REJECTED"],
  COLLECTED: ["VALIDATING", "ERROR", "REJECTED"],
  VALIDATING: ["ANALYZING", "PENDING_APPROVAL", "REJECTED", "ERROR"],
  ANALYZING: ["CURATING", "PENDING_APPROVAL", "REJECTED", "ERROR"],
  CURATING: ["PENDING_APPROVAL", "REJECTED", "ERROR"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED", "ERROR"],
  APPROVED: ["PUBLISHED", "PAUSED", "ERROR"],
  REJECTED: [],
  PUBLISHED: ["PAUSED", "ARCHIVED", "ERROR"],
  PAUSED: ["APPROVED", "ARCHIVED"],
  ARCHIVED: [],
  ERROR: ["VALIDATING", "PENDING_APPROVAL", "REJECTED"],
};

export function transitionProductState(from: ProductLifecycleState, to: ProductLifecycleState): void {
  if (!TRANSITIONS[from].includes(to)) throw new Error(`INVALID_PRODUCT_TRANSITION:${from}->${to}`);
}

export function normalizeCandidate(input: Partial<ProductCandidate> & { normalizedUrl?: string; link?: string }): ProductCandidate {
  const rawUrl = (input.normalizedUrl || input.link || "").trim();
  let normalizedUrl = rawUrl;
  try {
    const url = new URL(rawUrl);
    url.hostname = url.hostname.toLowerCase();
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid", "ttclid"].forEach(key => url.searchParams.delete(key));
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
    normalizedUrl = url.toString();
  } catch {
    // A validação posterior bloqueia URL inválida; normalização nunca inventa endereço.
  }

  const produto = (input.produto || "").replace(/\s+/g, " ").trim();
  const marketplace = (input.marketplace || detectMarketplace(normalizedUrl)).trim();
  return {
    normalizedUrl,
    externalId: input.externalId || extractExternalId(normalizedUrl),
    marketplace,
    produto,
    descricao: (input.descricao || "").trim(),
    categoria: (input.categoria || "").trim(),
    preco: typeof input.preco === "number" && Number.isFinite(input.preco) ? input.preco : null,
    precoAntigo: typeof input.precoAntigo === "number" ? input.precoAntigo : null,
    imagens: Array.isArray(input.imagens) ? input.imagens.filter(image => typeof image === "string" && /^https?:\/\//i.test(image)) : [],
    slug: input.slug || generateSlug(produto),
    ref: input.ref,
    id: input.id,
    state: input.state || "DISCOVERED",
    discoveredAt: input.discoveredAt || new Date().toISOString(),
  };
}

export const marketplaceFromUrl = detectMarketplace;

export function extractExternalId(url: string): string | undefined {
  const ml = url.match(/(ML[A-Z])[-]?(\d+)/i);
  if (ml) return `${ml[1].toUpperCase()}${ml[2]}`;
  const shopee = url.match(/(?:i\.|product\/)(\d+)[\/.](\d+)/i);
  if (shopee) return `shopee-${shopee[1]}-${shopee[2]}`;
  return undefined;
}

function titleTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter(token => token.length >= 4));
}

export function detectDuplicate(candidate: ProductCandidate, existingProducts: Array<{ id?: string; link?: string; slug?: string; produto?: string }>): DuplicateFinding | undefined {
  for (const product of existingProducts) {
    if (product.link && normalizeCandidate({ normalizedUrl: product.link }).normalizedUrl === candidate.normalizedUrl) {
      return { kind: "EXACT_URL", productId: product.id, details: "URL canônica já cadastrada.", potential: false };
    }
    const existingExternalId = product.link ? extractExternalId(product.link) : undefined;
    if (candidate.externalId && existingExternalId === candidate.externalId) {
      return { kind: "EXTERNAL_ID", productId: product.id, details: "ID externo do marketplace já cadastrado.", potential: false };
    }
    if (product.slug && product.slug === candidate.slug) {
      return { kind: "SLUG", productId: product.id, details: "Slug coincide com produto existente.", potential: true };
    }
    const candidateTokens = titleTokens(candidate.produto);
    const existingTokens = titleTokens(product.produto || "");
    const common = [...candidateTokens].filter(token => existingTokens.has(token)).length;
    if (candidateTokens.size >= 3 && common / candidateTokens.size >= 0.8) {
      return { kind: "SIMILAR_TITLE", productId: product.id, details: "Título altamente semelhante a produto existente.", potential: true };
    }
  }
  return undefined;
}

export function validateCandidate(candidate: ProductCandidate, existingProducts: Array<{ id?: string; link?: string; slug?: string; produto?: string }>): ProductValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  try { new URL(candidate.normalizedUrl); } catch { errors.push("URL inválida."); }
  if (!candidate.produto || candidate.produto.length < 3 || /produto sem título|produto cerberus/i.test(candidate.produto)) errors.push("Nome do produto ausente ou genérico.");
  if (!candidate.preco || candidate.preco <= 0) errors.push("Preço válido é obrigatório.");
  if (candidate.imagens.length === 0) errors.push("Ao menos uma imagem HTTP(S) é obrigatória.");
  if (!["Shopee", "Mercado Livre"].includes(candidate.marketplace)) errors.push("Marketplace não reconhecido.");
  if (!candidate.categoria) warnings.push("Categoria não confirmada.");
  if (!candidate.descricao) warnings.push("Descrição não confirmada.");
  const duplicate = detectDuplicate(candidate, existingProducts);
  if (duplicate && !duplicate.potential) errors.push(duplicate.details);
  if (duplicate?.potential) warnings.push(duplicate.details);
  return { outcome: errors.length ? "FAIL" : warnings.length ? "WARNING" : "PASS", errors, warnings, duplicate };
}

export function curateCandidate(candidate: ProductCandidate, validation: ProductValidation): ProductCuration {
  const reasons: string[] = [];
  const risks: string[] = [...validation.warnings, ...validation.errors];
  let score = 0;
  if (candidate.preco && candidate.preco > 0) { score += 25; reasons.push("Preço disponível."); }
  if (candidate.imagens.length > 0) { score += 25; reasons.push("Imagem disponível."); }
  if (candidate.produto.length >= 6) { score += 20; reasons.push("Título utilizável."); }
  if (candidate.categoria) { score += 15; reasons.push("Categoria sugerida."); }
  if (candidate.descricao) { score += 15; reasons.push("Descrição disponível."); }
  const confidence = score >= 85 ? "HIGH" : score >= 60 ? "MEDIUM" : "LOW";
  const recommendation: CurationRecommendation = validation.outcome === "FAIL" ? "REJECT" : validation.outcome === "WARNING" || confidence !== "HIGH" ? "REVIEW" : "PUBLISH";
  return { score, category: candidate.categoria || "Não classificada", confidence, reasons, risks, recommendation };
}

export function event(type: ProductLifecycleEvent["type"], state: ProductLifecycleState, reason: string): ProductLifecycleEvent {
  return { type, state, reason, timestamp: new Date().toISOString() };
}
