import { randomUUID } from "node:crypto";
import type { Product } from "../../src/types";
import type { PublicProductCategory } from "../../src/lib/productCategory";
import { resolveCanonicalProductImage } from "../../src/lib/productCanonical";
import { generateSlug } from "../../src/data/initialProducts";
import { extractShopeeIdentity } from "../commercial/marketplace/shopeeIdentity";
import type { ShopeeApiClient } from "../commercial/affiliate/shopeeApiClient";
import { requireSupabase } from "../repositories/productsRepository";
import * as productsRepository from "../repositories/productsRepository";
import * as curatorRepo from "../repositories/autonomousCuratorRepository";
import { extractProductForReview } from "./productAutomation";
import { createProductionProductPipeline, type LifecycleRecord } from "./productPipeline";
import { syncCatalogAndDeploy } from "./catalogSync";
import {
  DISPLAY_TITLE_REVIEW_VERSION,
  IMAGE_REVIEW_VERSION,
  imageCurationFingerprint,
} from "./productEditorialReview";
import {
  AUTONOMOUS_CURATOR_PROFILES,
  AUTONOMOUS_CURATOR_PROFILE_VERSION,
  type AutonomousCuratorCategoryProfile,
} from "./autonomousCuratorProfiles";
import {
  cheapProfileScore,
  hasBlockedProfileTerm,
  scoreAutonomousCandidate,
  type AutonomousCuratorScoreBreakdown,
} from "./autonomousCuratorScoring";
import {
  buildConfiguredShopeeClient,
  mapShopeeErrorKindToProviderCode,
  newShopeeCorrelationId,
  providerErrorFromAcquisitionStatus,
  safeShopeeLog,
  searchShopeeOffersWithRetry,
  ShopeeProviderRuntimeError,
  type ShopeeProviderErrorCode,
  validateOfficialProductLink,
} from "./shopeeProviderRuntime";

const AUTO_QUEUE_CREATED_BY = "autonomous_curator_queue";
const ROTATION_CANDIDATE_CREATED_BY = "telegram_rotation_candidate";
const QUEUE_NOTE_PREFIX = "AUTONOMOUS_CURATOR_QUEUE_V1:";
const ROTATION_VERSION = "2";
const ROTATION_SEARCH_MAX_PAGES = 3;
const ROTATION_SEARCH_PAGE_LIMIT = 10;

export type ProductRotationStatus =
  | "searching"
  | "candidate_ready"
  | "applying"
  | "replaced"
  | "cancelled"
  | "failed";

export type ProductRotationRequest = {
  id: string;
  sourceProductId: string;
  category: PublicProductCategory;
  status: ProductRotationStatus;
  requestedBy: string;
  telegramChatId: string;
  candidateProductId: string | null;
  replacementProductId: string | null;
  rejectedCandidateIds: string[];
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

type QueueMetadata = {
  score: number;
  profileVersion: string;
  queuedAt: string;
  publishedAt?: string | null;
  query: string;
  shopId: string;
  itemId: string;
  sourceProductUrl: string;
  imageUrl?: string | null;
};

type EvaluatedCandidate = {
  profile: AutonomousCuratorCategoryProfile;
  query: string;
  shopId: string;
  itemId: string;
  sourceProductUrl: string;
  affiliateUrl: string;
  sourceImageUrl: string | null;
  rawTitle: string;
  displayTitle: string;
  description: string;
  category: PublicProductCategory;
  price: number;
  images: string[];
  imageCuration: NonNullable<Product["imageCuration"]>;
  score: number;
  breakdown: AutonomousCuratorScoreBreakdown;
  lifecycle: LifecycleRecord;
};

export type RotationSearchDiagnostics = {
  correlationId: string;
  provider: "ShopeeApiClient";
  queriesAttempted: number;
  providerQueriesExecuted: number;
  candidatesReceived: number;
  candidatesInPool: number;
  candidatesExamined: number;
  rejectionCounts: Record<string, number>;
};

export class ProductRotationSearchError extends Error {
  constructor(
    readonly code: "NO_QUALIFIED_REPLACEMENT_FOUND" | "ROTATION_CANDIDATE_PERSIST_FAILED" | ShopeeProviderErrorCode,
    readonly diagnostics: RotationSearchDiagnostics,
  ) {
    super(code);
    this.name = "ProductRotationSearchError";
  }
}

export type RotationProposal = {
  request: ProductRotationRequest;
  source: Product;
  candidate: Product;
  score: number;
};

function mapRequest(row: any): ProductRotationRequest {
  return {
    id: String(row.id),
    sourceProductId: String(row.source_product_id),
    category: String(row.category) as PublicProductCategory,
    status: row.status as ProductRotationStatus,
    requestedBy: String(row.requested_by),
    telegramChatId: String(row.telegram_chat_id),
    candidateProductId: row.candidate_product_id ? String(row.candidate_product_id) : null,
    replacementProductId: row.replacement_product_id ? String(row.replacement_product_id) : null,
    rejectedCandidateIds: Array.isArray(row.rejected_candidate_ids) ? row.rejected_candidate_ids.map(String) : [],
    reason: row.reason ? String(row.reason) : null,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}

function queueNote(meta: QueueMetadata): string {
  return `${QUEUE_NOTE_PREFIX}${JSON.stringify(meta)}`;
}

function parseQueueNote(value: unknown): QueueMetadata | null {
  const text = String(value || "");
  if (!text.startsWith(QUEUE_NOTE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(text.slice(QUEUE_NOTE_PREFIX.length)) as Partial<QueueMetadata>;
    if (!parsed.shopId || !parsed.itemId || !parsed.sourceProductUrl || !parsed.query) return null;
    return {
      score: Number(parsed.score || 0),
      profileVersion: String(parsed.profileVersion || AUTONOMOUS_CURATOR_PROFILE_VERSION),
      queuedAt: String(parsed.queuedAt || new Date(0).toISOString()),
      publishedAt: parsed.publishedAt ? String(parsed.publishedAt) : null,
      query: String(parsed.query),
      shopId: String(parsed.shopId),
      itemId: String(parsed.itemId),
      sourceProductUrl: String(parsed.sourceProductUrl),
      imageUrl: typeof parsed.imageUrl === "string" ? parsed.imageUrl : null,
    };
  } catch {
    return null;
  }
}

function profileFor(category: string): AutonomousCuratorCategoryProfile | null {
  return AUTONOMOUS_CURATOR_PROFILES.find(profile => profile.category === category) || null;
}

function sourceIdentityMatches(url: string, shopId: string, itemId: string): boolean {
  const identity = extractShopeeIdentity(url);
  return identity.shopId === shopId && identity.itemId === itemId;
}

function similarityUniverse(products: readonly Product[], excludedCandidateId?: string): Product[] {
  return products.filter(product =>
    product.id !== excludedCandidateId && (
      (product.status === "published" && product.ativo !== false)
      || (product.createdBy === AUTO_QUEUE_CREATED_BY && product.status === "paused" && product.ativo === false)
    ),
  );
}

function buildShopeeClient(env: NodeJS.ProcessEnv): ShopeeApiClient {
  return buildConfiguredShopeeClient(env);
}

function safeReason(value: unknown): string {
  return (value instanceof Error ? value.message : String(value || "UNKNOWN"))
    .replace(/[\r\n]+/g, " ")
    .slice(0, 180);
}

function newDiagnostics(): RotationSearchDiagnostics {
  return {
    correlationId: newShopeeCorrelationId("rotation"),
    provider: "ShopeeApiClient",
    queriesAttempted: 0,
    providerQueriesExecuted: 0,
    candidatesReceived: 0,
    candidatesInPool: 0,
    candidatesExamined: 0,
    rejectionCounts: {},
  };
}

function bump(diag: RotationSearchDiagnostics, reason: string): void {
  diag.rejectionCounts[reason] = (diag.rejectionCounts[reason] || 0) + 1;
}

function providerErrorFromLookup(errorKind: string | null | undefined): ShopeeProviderRuntimeError {
  const code = mapShopeeErrorKindToProviderCode(errorKind);
  return new ShopeeProviderRuntimeError(
    code,
    errorKind || "lookup_error",
    code === "SHOPEE_PROVIDER_RATE_LIMITED" || code === "SHOPEE_PROVIDER_TIMEOUT" || code === "SHOPEE_PROVIDER_UNAVAILABLE",
  );
}

async function getRequest(id: string): Promise<ProductRotationRequest | null> {
  const { data, error } = await requireSupabase()
    .from("product_rotation_requests")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? mapRequest(data) : null;
}

async function patchRequest(id: string, patch: Record<string, unknown>): Promise<ProductRotationRequest> {
  const { data, error } = await requireSupabase()
    .from("product_rotation_requests")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return mapRequest(data);
}

export async function getProductRotationRequest(id: string): Promise<ProductRotationRequest | null> {
  return getRequest(id);
}

export async function startProductRotation(input: {
  sourceProductId: string;
  requestedBy: string | number;
  telegramChatId: string | number;
}): Promise<ProductRotationRequest> {
  const source = await productsRepository.getProductByIdOrSlug(input.sourceProductId);
  if (!source || source.status !== "published" || source.ativo === false) throw new Error("ROTATION_SOURCE_NOT_ACTIVE_PUBLISHED");
  const profile = profileFor(source.categoria);
  if (!profile) throw new Error("ROTATION_CATEGORY_NOT_SUPPORTED");

  const { data: existing, error: existingError } = await requireSupabase()
    .from("product_rotation_requests")
    .select("*")
    .eq("source_product_id", source.id)
    .in("status", ["searching", "candidate_ready", "applying"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return mapRequest(existing);

  const { data, error } = await requireSupabase().from("product_rotation_requests").insert({
    source_product_id: source.id,
    category: profile.category,
    status: "searching",
    requested_by: String(input.requestedBy),
    telegram_chat_id: String(input.telegramChatId),
    metadata: {
      rotation_version: ROTATION_VERSION,
      source_snapshot: {
        id: source.id,
        ref: source.ref || null,
        title: source.displayTitle || source.produto,
        category: source.categoria,
        price: source.preco,
        link: source.link,
      },
    },
  }).select("*").single();
  if (error) throw error;
  return mapRequest(data);
}

async function evaluateIdentity(input: {
  profile: AutonomousCuratorCategoryProfile;
  query: string;
  shopId: string;
  itemId: string;
  discoveryName: string;
  discoveryPrice: number | null;
  sourceImageUrl: string | null;
  products: Product[];
  client: ShopeeApiClient;
  env: NodeJS.ProcessEnv;
  allowedProductId?: string | null;
}): Promise<{ candidate: EvaluatedCandidate | null; reason: string }> {
  const existingIdentity = await curatorRepo.findProductSourceIdentity("Shopee", input.shopId, input.itemId);
  if (existingIdentity?.productId && existingIdentity.productId !== input.allowedProductId) return { candidate: null, reason: "SOURCE_IDENTITY_ALREADY_OWNED" };

  const lookup = await input.client.lookupProduct({ shopId: input.shopId, itemId: input.itemId });
  if (lookup.status === "not_found") return { candidate: null, reason: "SHOPEE_PRODUCT_NOT_FOUND" };
  if (lookup.status === "error") throw providerErrorFromLookup(lookup.error?.kind);
  if (lookup.status !== "found" || lookup.shopId !== input.shopId || lookup.itemId !== input.itemId) {
    return { candidate: null, reason: `SHOPEE_LOOKUP_${lookup.status}` };
  }
  if (!lookup.productLink || !validateOfficialProductLink(lookup.productLink, input.shopId, input.itemId)) {
    return { candidate: null, reason: "SHOPEE_LOOKUP_PRODUCT_LINK_INVALID" };
  }

  const acquisition = await input.client.acquireAffiliateLink({ shopId: input.shopId, itemId: input.itemId });
  if (acquisition.status !== "link_acquired") {
    const providerFailure = providerErrorFromAcquisitionStatus(acquisition.status, acquisition.error?.kind);
    if (providerFailure) throw providerFailure;
    return { candidate: null, reason: `AFFILIATE_${acquisition.status}` };
  }
  if (!acquisition.affiliateUrl || !acquisition.productLink || !acquisition.shopId || !acquisition.itemId) {
    return { candidate: null, reason: "AFFILIATE_EVIDENCE_INCOMPLETE" };
  }
  if (
    acquisition.shopId !== input.shopId
    || acquisition.itemId !== input.itemId
    || !validateOfficialProductLink(acquisition.productLink, input.shopId, input.itemId)
  ) {
    return { candidate: null, reason: "AFFILIATE_IDENTITY_MISMATCH" };
  }

  const evidenceProduct: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: String(acquisition.name || input.discoveryName || "").replace(/\s+/g, " ").trim().slice(0, 300),
  };
  if (input.sourceImageUrl && /^https:\/\//i.test(input.sourceImageUrl)) evidenceProduct.image = [input.sourceImageUrl];
  const evidence = `<script type="application/ld+json">${JSON.stringify(evidenceProduct).replace(/</g, "\\u003c")}</script>`;
  const extracted = await extractProductForReview(acquisition.productLink, evidence);
  if (!extracted.success || !extracted.data) return { candidate: null, reason: `EXTRACTION_${extracted.error || "failed"}` };
  const data = extracted.data;
  if (!sourceIdentityMatches(data.normalizedUrl, input.shopId, input.itemId)) return { candidate: null, reason: "SCRAPER_IDENTITY_MISMATCH" };

  const rawTitle = String(data.rawTitle || data.produto || acquisition.name || input.discoveryName || "").trim();
  const displayTitle = String(data.displayTitle || "").trim();
  const description = String(data.descricao || "").trim();
  const category = data.categoria as PublicProductCategory;
  const scrapedPrice = Number(data.preco);
  const acquisitionPrice = Number(acquisition.price);
  const discoveryPrice = Number(input.discoveryPrice);
  const price = Number.isFinite(scrapedPrice) && scrapedPrice > 0
    ? scrapedPrice
    : Number.isFinite(acquisitionPrice) && acquisitionPrice > 0
      ? acquisitionPrice
      : discoveryPrice;
  const imageCuration = data.imageCuration;
  const image = resolveCanonicalProductImage({ imagens: data.imagens, imageCuration, imageEditorialStatus: data.imageEditorialStatus });

  const blocked = hasBlockedProfileTerm(input.profile, `${rawTitle} ${displayTitle} ${description}`);
  if (blocked) return { candidate: null, reason: `PROFILE_BLOCKED_TERM:${blocked}` };
  if (!displayTitle || displayTitle === rawTitle || description.length < 24) return { candidate: null, reason: "EDITORIAL_COPY_INCOMPLETE" };
  if (category !== input.profile.category) return { candidate: null, reason: `CATEGORY_MISMATCH:${category || "unknown"}` };
  if (!Number.isFinite(price) || price <= 0) return { candidate: null, reason: "PRICE_UNVERIFIED" };
  if (data.imageEditorialStatus !== "clean" || !imageCuration || imageCuration.status !== "ready" || image.status !== "ready" || !image.primaryImageUrl || !/^https:\/\//i.test(image.primaryImageUrl)) {
    return { candidate: null, reason: "IMAGE_REVIEW_NOT_CLEAN" };
  }

  // Never derive a Shopee URL from ids. The exact official productLink returned
  // by the provider is the canonical source URL carried into persistence.
  const sourceProductUrl = acquisition.productLink;
  const lifecycle = await createProductionProductPipeline().evaluate({
    normalizedUrl: sourceProductUrl,
    link: acquisition.affiliateUrl,
    marketplace: "Shopee",
    produto: displayTitle,
    rawTitle,
    displayTitle,
    categoria: category,
    preco: price,
    imagens: image.publicHttpsImageUrls,
    imagensOriginais: imageCuration.rawImageUrls,
    imageCuration,
    imagemPrincipal: image.primaryImageUrl,
    imagensGaleria: image.galleryImageUrls,
    imageEditorialStatus: "clean",
    descricao: description,
  });
  if (lifecycle.validation.outcome !== "PASS" || lifecycle.state === "ERROR" || lifecycle.state === "REJECTED" || lifecycle.curation.recommendation !== "PUBLISH") {
    return { candidate: null, reason: `PIPELINE_NOT_PUBLISHABLE:${lifecycle.validation.errors.join("|") || lifecycle.curation.recommendation}` };
  }

  const breakdown = scoreAutonomousCandidate({
    profile: input.profile,
    rawTitle,
    displayTitle,
    description,
    category,
    price,
    imageCuration,
    pipelineScore: lifecycle.curation.score,
    existingProducts: similarityUniverse(input.products, input.allowedProductId || undefined),
  });
  const config = await curatorRepo.getAutonomousCuratorConfig();
  if (breakdown.maximumCatalogSimilarity >= 0.82) return { candidate: null, reason: `CATALOG_SIMILARITY:${breakdown.maximumCatalogSimilarity}` };
  if (breakdown.finalScore < config.autoPublishThreshold) return { candidate: null, reason: `BELOW_PUBLICATION_THRESHOLD:${breakdown.finalScore}` };

  return {
    candidate: {
      profile: input.profile,
      query: input.query,
      shopId: input.shopId,
      itemId: input.itemId,
      sourceProductUrl,
      affiliateUrl: acquisition.affiliateUrl,
      sourceImageUrl: input.sourceImageUrl,
      rawTitle,
      displayTitle,
      description,
      category,
      price,
      images: image.publicHttpsImageUrls,
      imageCuration,
      score: breakdown.finalScore,
      breakdown,
      lifecycle,
    },
    reason: "QUALIFIED",
  };
}

async function claimIdentity(candidate: EvaluatedCandidate, productId: string): Promise<boolean> {
  const { error } = await requireSupabase().from("product_source_identities").insert({
    marketplace: "Shopee",
    shop_id: candidate.shopId,
    item_id: candidate.itemId,
    source_product_url: candidate.sourceProductUrl,
    product_id: productId,
    review_id: null,
    source: ROTATION_CANDIDATE_CREATED_BY,
    reserved_run_id: null,
    reserved_until: null,
  });
  if (!error) return true;
  if ((error as { code?: string }).code === "23505") return false;
  throw error;
}

async function persistCandidate(candidate: EvaluatedCandidate, now: Date, env: NodeJS.ProcessEnv): Promise<Product | null> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const productId = `prod-${now.getTime()}-${suffix}`;
  if (!(await claimIdentity(candidate, productId))) return null;
  const meta: QueueMetadata = {
    score: candidate.score,
    profileVersion: AUTONOMOUS_CURATOR_PROFILE_VERSION,
    queuedAt: now.toISOString(),
    publishedAt: null,
    query: candidate.query,
    shopId: candidate.shopId,
    itemId: candidate.itemId,
    sourceProductUrl: candidate.sourceProductUrl,
    imageUrl: candidate.sourceImageUrl,
  };
  const slug = `${generateSlug(candidate.displayTitle)}-${suffix.slice(0, 6)}`;
  const imageModel = env.GEMINI_PRODUCT_IMAGE_REVIEW_MODEL || env.GEMINI_PRODUCT_CURATOR_MODEL || "gemini-3.5-flash-lite";
  const titleModel = env.GEMINI_AUTONOMOUS_CURATOR_COPY_MODEL || env.GEMINI_PRODUCT_CURATOR_MODEL || "gemini-3.5-flash-lite";
  const { error } = await requireSupabase().from("products").insert({
    id: productId,
    ref: `ROTA-${suffix.toUpperCase()}`,
    produto: candidate.displayTitle,
    categoria: candidate.category,
    preco: candidate.price,
    imagens: candidate.images,
    link: candidate.affiliateUrl,
    ativo: false,
    destaque: false,
    status: "paused",
    created_by: ROTATION_CANDIDATE_CREATED_BY,
    slug,
    descricao: candidate.description,
    pagina_ponte_url: "",
    oferta_promocional: null,
    raw_title: candidate.rawTitle,
    display_title: candidate.displayTitle,
    curator_note: queueNote(meta),
    image_editorial_status: "clean",
    image_curation: candidate.imageCuration,
    image_reviewed_at: now.toISOString(),
    image_review_model: imageModel,
    image_review_version: IMAGE_REVIEW_VERSION,
    image_review_fingerprint: imageCurationFingerprint(candidate.imageCuration),
    display_title_status: "reviewed",
    display_title_reviewed_at: now.toISOString(),
    display_title_review_model: titleModel,
    display_title_review_version: DISPLAY_TITLE_REVIEW_VERSION,
  });
  if (error) {
    await requireSupabase().from("product_source_identities").delete().eq("product_id", productId);
    throw error;
  }
  await curatorRepo.saveProductImageEditorialReview({
    productId,
    curation: candidate.imageCuration,
    model: imageModel,
    reviewVersion: "1.2",
  });
  return await productsRepository.getProductByIdOrSlug(productId);
}

async function refreshCandidateProduct(product: Product, candidate: EvaluatedCandidate, published: boolean, env: NodeJS.ProcessEnv): Promise<void> {
  const previous = parseQueueNote(product.curatorNote);
  const now = new Date();
  const meta: QueueMetadata = {
    score: candidate.score,
    profileVersion: AUTONOMOUS_CURATOR_PROFILE_VERSION,
    queuedAt: previous?.queuedAt || product.createdAt || now.toISOString(),
    publishedAt: published ? now.toISOString() : null,
    query: candidate.query,
    shopId: candidate.shopId,
    itemId: candidate.itemId,
    sourceProductUrl: candidate.sourceProductUrl,
    imageUrl: candidate.sourceImageUrl,
  };
  const { error } = await requireSupabase().from("products").update({
    produto: candidate.displayTitle,
    categoria: candidate.category,
    preco: candidate.price,
    imagens: candidate.images,
    link: candidate.affiliateUrl,
    descricao: candidate.description,
    raw_title: candidate.rawTitle,
    display_title: candidate.displayTitle,
    curator_note: queueNote(meta),
    image_editorial_status: "clean",
    image_curation: candidate.imageCuration,
    image_reviewed_at: now.toISOString(),
    image_review_model: env.GEMINI_PRODUCT_IMAGE_REVIEW_MODEL || env.GEMINI_PRODUCT_CURATOR_MODEL || "gemini-3.5-flash-lite",
    image_review_version: IMAGE_REVIEW_VERSION,
    image_review_fingerprint: imageCurationFingerprint(candidate.imageCuration),
    display_title_status: "reviewed",
    display_title_reviewed_at: now.toISOString(),
    display_title_review_model: env.GEMINI_AUTONOMOUS_CURATOR_COPY_MODEL || env.GEMINI_PRODUCT_CURATOR_MODEL || "gemini-3.5-flash-lite",
    display_title_review_version: DISPLAY_TITLE_REVIEW_VERSION,
    created_by: published ? AUTO_QUEUE_CREATED_BY : ROTATION_CANDIDATE_CREATED_BY,
    ativo: published,
    status: published ? "published" : "paused",
  }).eq("id", product.id);
  if (error) throw error;
}

async function evaluateStoredProduct(product: Product, source: Product, profile: AutonomousCuratorCategoryProfile, client: ShopeeApiClient, env: NodeJS.ProcessEnv): Promise<{ candidate: EvaluatedCandidate | null; reason: string }> {
  const { data: identity, error } = await requireSupabase()
    .from("product_source_identities")
    .select("shop_id,item_id,source_product_url")
    .eq("product_id", product.id)
    .maybeSingle();
  if (error) throw error;
  if (!identity?.shop_id || !identity?.item_id || !identity?.source_product_url) return { candidate: null, reason: "SOURCE_IDENTITY_MISSING" };
  if (!validateOfficialProductLink(String(identity.source_product_url), String(identity.shop_id), String(identity.item_id))) {
    return { candidate: null, reason: "SOURCE_PRODUCT_URL_NOT_OFFICIAL" };
  }
  const meta = parseQueueNote(product.curatorNote);
  const products = await productsRepository.getProducts();
  return evaluateIdentity({
    profile,
    query: meta?.query || profile.queries[0] || source.produto,
    shopId: String(identity.shop_id),
    itemId: String(identity.item_id),
    discoveryName: product.rawTitle || product.produto,
    discoveryPrice: product.preco,
    sourceImageUrl: meta?.imageUrl || product.imagens?.[0] || null,
    products,
    client,
    env,
    allowedProductId: product.id,
  });
}

async function availableQueuedCandidates(category: PublicProductCategory, rejected: ReadonlySet<string>): Promise<Product[]> {
  const products = await productsRepository.getProducts();
  return products
    .filter(product =>
      product.categoria === category
      && product.status === "paused"
      && product.ativo === false
      && product.createdBy === AUTO_QUEUE_CREATED_BY
      && !rejected.has(product.id)
      && parseQueueNote(product.curatorNote),
    )
    .sort((a, b) => (parseQueueNote(b.curatorNote)?.score || 0) - (parseQueueNote(a.curatorNote)?.score || 0));
}

async function discoverLiveCandidate(input: {
  profile: AutonomousCuratorCategoryProfile;
  source: Product;
  rejected: ReadonlySet<string>;
  client: ShopeeApiClient;
  env: NodeJS.ProcessEnv;
  diagnostics: RotationSearchDiagnostics;
}): Promise<EvaluatedCandidate | null> {
  const config = await curatorRepo.getAutonomousCuratorConfig();
  const products = await productsRepository.getProducts();
  const seen = new Set<string>();
  const pool: Array<{ query: string; shopId: string; itemId: string; name: string; price: number; imageUrl: string; productLink: string; cheap: number }> = [];
  const poolTarget = Math.max(12, Math.min(30, Number(config.maxSearchCandidates) || 20));

  for (const query of input.profile.queries.slice(0, 8)) {
    if (pool.length >= poolTarget) break;
    input.diagnostics.queriesAttempted += 1;
    for (let page = 1; page <= ROTATION_SEARCH_MAX_PAGES && pool.length < poolTarget; page += 1) {
      input.diagnostics.providerQueriesExecuted += 1;
      const search = await searchShopeeOffersWithRetry({
        client: input.client,
        query,
        limit: ROTATION_SEARCH_PAGE_LIMIT,
        page,
      });
      input.diagnostics.candidatesReceived += search.items.length;
      if (search.items.length === 0) break;
      for (const item of search.items) {
        if (!item.shopId || !item.itemId) { bump(input.diagnostics, "IDENTITY_MISSING"); continue; }
        if (!item.name?.trim()) { bump(input.diagnostics, "TITLE_MISSING"); continue; }
        if (item.price === null || !Number.isFinite(item.price) || item.price <= 0) { bump(input.diagnostics, "PRICE_UNVERIFIED"); continue; }
        if (!validateOfficialProductLink(item.productLink, item.shopId, item.itemId)) { bump(input.diagnostics, "OFFICIAL_PRODUCT_LINK_INVALID"); continue; }
        if (!item.imageUrl || !/^https:\/\//i.test(item.imageUrl)) { bump(input.diagnostics, "IMAGE_HTTPS_MISSING"); continue; }
        const key = `${item.shopId}:${item.itemId}`;
        if (seen.has(key)) { bump(input.diagnostics, "DUPLICATE_IN_SEARCH_POOL"); continue; }
        seen.add(key);
        if (hasBlockedProfileTerm(input.profile, item.name)) { bump(input.diagnostics, "PROFILE_BLOCKED_TERM"); continue; }
        const identity = await curatorRepo.findProductSourceIdentity("Shopee", String(item.shopId), String(item.itemId));
        if (identity?.productId) { bump(input.diagnostics, "SOURCE_IDENTITY_ALREADY_OWNED"); continue; }
        const cheap = cheapProfileScore(input.profile, item.name);
        if (cheap <= -1000) { bump(input.diagnostics, "PROFILE_REJECTED"); continue; }
        pool.push({
          query,
          shopId: String(item.shopId),
          itemId: String(item.itemId),
          name: item.name,
          price: Number(item.price),
          imageUrl: item.imageUrl,
          productLink: item.productLink,
          cheap,
        });
        if (pool.length >= poolTarget) break;
      }
      if (search.items.length < ROTATION_SEARCH_PAGE_LIMIT) break;
    }
  }

  input.diagnostics.candidatesInPool = pool.length;
  pool.sort((a, b) => b.cheap - a.cheap || a.itemId.localeCompare(b.itemId));
  const enrichBudget = Math.max(6, Math.min(12, (Number(config.maxEnrichPerCategory) || 4) * 2));
  for (const item of pool.slice(0, enrichBudget)) {
    input.diagnostics.candidatesExamined += 1;
    const evaluated = await evaluateIdentity({
      profile: input.profile,
      query: item.query,
      shopId: item.shopId,
      itemId: item.itemId,
      discoveryName: item.name,
      discoveryPrice: item.price,
      sourceImageUrl: item.imageUrl,
      products,
      client: input.client,
      env: input.env,
    });
    if (evaluated.candidate) return evaluated.candidate;
    bump(input.diagnostics, evaluated.reason);
  }
  return null;
}

async function markProviderFailure(request: ProductRotationRequest, error: ShopeeProviderRuntimeError, diagnostics: RotationSearchDiagnostics): Promise<never> {
  await patchRequest(request.id, {
    status: "failed",
    reason: error.code,
    metadata: {
      ...request.metadata,
      last_search_diagnostics: diagnostics,
      failure_type: error.code === "SHOPEE_PROVIDER_NOT_CONFIGURED" ? "provider_not_configured" : "provider_failure",
    },
  }).catch(() => undefined);
  safeShopeeLog("rotation_provider_failure", {
    correlationId: diagnostics.correlationId,
    errorCode: error.code,
    queries: diagnostics.providerQueriesExecuted,
    candidatesReceived: diagnostics.candidatesReceived,
  });
  throw new ProductRotationSearchError(error.code, diagnostics);
}

export async function proposeNextProductRotationCandidate(requestId: string, env: NodeJS.ProcessEnv = process.env): Promise<RotationProposal> {
  let request = await getRequest(requestId);
  if (!request) throw new Error("ROTATION_REQUEST_NOT_FOUND");
  if (!["searching", "candidate_ready", "failed"].includes(request.status)) throw new Error(`ROTATION_NOT_SEARCHABLE:${request.status}`);
  const source = await productsRepository.getProductByIdOrSlug(request.sourceProductId);
  if (!source || source.status !== "published" || source.ativo === false) throw new Error("ROTATION_SOURCE_NO_LONGER_ACTIVE");
  const profile = profileFor(source.categoria);
  if (!profile || profile.category !== request.category) throw new Error("ROTATION_CATEGORY_CHANGED");
  const diagnostics = newDiagnostics();

  let client: ShopeeApiClient;
  try {
    client = buildShopeeClient(env);
  } catch (error) {
    const providerError = error instanceof ShopeeProviderRuntimeError
      ? error
      : new ShopeeProviderRuntimeError("SHOPEE_PROVIDER_NOT_CONFIGURED", "client_build_failed", false);
    return markProviderFailure(request, providerError, diagnostics);
  }

  const rejected = new Set(request.rejectedCandidateIds);
  try {
    if (request.candidateProductId && !rejected.has(request.candidateProductId)) {
      const currentCandidate = await productsRepository.getProductByIdOrSlug(request.candidateProductId);
      if (currentCandidate && currentCandidate.status === "paused" && currentCandidate.ativo === false) {
        diagnostics.candidatesExamined += 1;
        const evaluated = await evaluateStoredProduct(currentCandidate, source, profile, client, env);
        if (evaluated.candidate) {
          await refreshCandidateProduct(currentCandidate, evaluated.candidate, false, env);
          request = await patchRequest(request.id, { status: "candidate_ready", reason: null });
          const refreshed = await productsRepository.getProductByIdOrSlug(currentCandidate.id);
          if (!refreshed) throw new Error("ROTATION_CANDIDATE_REFRESH_MISSING");
          return { request, source, candidate: refreshed, score: evaluated.candidate.score };
        }
        bump(diagnostics, evaluated.reason);
      }
    }

    for (const queued of await availableQueuedCandidates(profile.category, rejected)) {
      if (queued.id === source.id) continue;
      diagnostics.candidatesExamined += 1;
      const origin = queued.createdBy || AUTO_QUEUE_CREATED_BY;
      const evaluated = await evaluateStoredProduct(queued, source, profile, client, env);
      if (!evaluated.candidate) { bump(diagnostics, evaluated.reason); continue; }
      await refreshCandidateProduct(queued, evaluated.candidate, false, env);
      request = await patchRequest(request.id, {
        status: "candidate_ready",
        candidate_product_id: queued.id,
        reason: null,
        metadata: { ...request.metadata, candidate_origin: origin, candidate_score: evaluated.candidate.score, last_search_diagnostics: diagnostics },
      });
      const refreshed = await productsRepository.getProductByIdOrSlug(queued.id);
      if (!refreshed) throw new Error("ROTATION_CANDIDATE_CLAIM_MISSING");
      return { request, source, candidate: refreshed, score: evaluated.candidate.score };
    }

    const discovered = await discoverLiveCandidate({ profile, source, rejected, client, env, diagnostics });
    if (discovered) {
      try {
        const persisted = await persistCandidate(discovered, new Date(), env);
        if (persisted) {
          request = await patchRequest(request.id, {
            status: "candidate_ready",
            candidate_product_id: persisted.id,
            reason: null,
            metadata: {
              ...request.metadata,
              candidate_origin: ROTATION_CANDIDATE_CREATED_BY,
              candidate_score: discovered.score,
              last_search_diagnostics: diagnostics,
            },
          });
          safeShopeeLog("rotation_candidate_ready", {
            correlationId: diagnostics.correlationId,
            candidatesReceived: diagnostics.candidatesReceived,
            candidatesExamined: diagnostics.candidatesExamined,
          });
          return { request, source, candidate: persisted, score: discovered.score };
        }
        bump(diagnostics, "IDENTITY_CLAIM_CONFLICT");
      } catch (error) {
        await patchRequest(request.id, {
          status: "failed",
          reason: "ROTATION_CANDIDATE_PERSIST_FAILED",
          metadata: { ...request.metadata, last_search_diagnostics: diagnostics, failure_type: "candidate_persistence" },
        }).catch(() => undefined);
        throw new ProductRotationSearchError("ROTATION_CANDIDATE_PERSIST_FAILED", diagnostics);
      }
    }
  } catch (error) {
    if (error instanceof ShopeeProviderRuntimeError) return markProviderFailure(request, error, diagnostics);
    if (error instanceof ProductRotationSearchError) throw error;
    throw error;
  }

  await patchRequest(request.id, {
    status: "failed",
    reason: "NO_QUALIFIED_REPLACEMENT_FOUND",
    metadata: {
      ...request.metadata,
      last_search_diagnostics: diagnostics,
      failure_type: "qualified_candidates_exhausted",
    },
  });
  safeShopeeLog("rotation_no_qualified_candidate", {
    correlationId: diagnostics.correlationId,
    providerQueriesExecuted: diagnostics.providerQueriesExecuted,
    candidatesReceived: diagnostics.candidatesReceived,
    candidatesInPool: diagnostics.candidatesInPool,
    candidatesExamined: diagnostics.candidatesExamined,
  });
  throw new ProductRotationSearchError("NO_QUALIFIED_REPLACEMENT_FOUND", diagnostics);
}

export async function rejectRotationCandidateAndSearchAgain(requestId: string): Promise<ProductRotationRequest> {
  const request = await getRequest(requestId);
  if (!request) throw new Error("ROTATION_REQUEST_NOT_FOUND");
  if (request.status !== "candidate_ready" || !request.candidateProductId) throw new Error("ROTATION_CANDIDATE_NOT_READY");
  const candidateId = request.candidateProductId;
  const { error } = await requireSupabase().from("products").update({ ativo: false, status: "archived" }).eq("id", candidateId);
  if (error) throw error;
  return patchRequest(request.id, {
    status: "searching",
    candidate_product_id: null,
    rejected_candidate_ids: [...new Set([...request.rejectedCandidateIds, candidateId])],
    reason: "CANDIDATE_REJECTED_BY_USER",
    metadata: { ...request.metadata, last_rejected_candidate_id: candidateId },
  });
}

export async function cancelProductRotation(requestId: string): Promise<ProductRotationRequest> {
  const request = await getRequest(requestId);
  if (!request) throw new Error("ROTATION_REQUEST_NOT_FOUND");
  if (["replaced", "cancelled"].includes(request.status)) return request;
  if (request.candidateProductId) {
    const candidate = await productsRepository.getProductByIdOrSlug(request.candidateProductId);
    if (candidate && candidate.status === "paused" && candidate.ativo === false) {
      const origin = String(request.metadata.candidate_origin || "");
      const restoreCreatedBy = origin === AUTO_QUEUE_CREATED_BY ? AUTO_QUEUE_CREATED_BY : ROTATION_CANDIDATE_CREATED_BY;
      const restoreStatus = origin === AUTO_QUEUE_CREATED_BY ? "paused" : "archived";
      const { error } = await requireSupabase().from("products").update({
        created_by: restoreCreatedBy,
        ativo: false,
        status: restoreStatus,
      }).eq("id", candidate.id);
      if (error) throw error;
    }
  }
  return patchRequest(request.id, {
    status: "cancelled",
    reason: "CANCELLED_BY_USER",
    completed_at: new Date().toISOString(),
  });
}

export async function approveProductRotation(requestId: string, env: NodeJS.ProcessEnv = process.env): Promise<{ request: ProductRotationRequest; source: Product; replacement: Product }> {
  let request = await getRequest(requestId);
  if (!request) throw new Error("ROTATION_REQUEST_NOT_FOUND");
  if (request.status === "replaced" && request.replacementProductId) {
    const source = await productsRepository.getProductByIdOrSlug(request.sourceProductId);
    const replacement = await productsRepository.getProductByIdOrSlug(request.replacementProductId);
    if (!source || !replacement) throw new Error("ROTATION_COMPLETED_PRODUCTS_MISSING");
    return { request, source, replacement };
  }
  if (request.status !== "candidate_ready" || !request.candidateProductId) throw new Error(`ROTATION_CANDIDATE_NOT_READY:${request.status}`);

  const source = await productsRepository.getProductByIdOrSlug(request.sourceProductId);
  const candidateProduct = await productsRepository.getProductByIdOrSlug(request.candidateProductId);
  if (!source || source.status !== "published" || source.ativo === false) throw new Error("ROTATION_SOURCE_NO_LONGER_ACTIVE");
  if (!candidateProduct || candidateProduct.status !== "paused" || candidateProduct.ativo !== false) throw new Error("ROTATION_CANDIDATE_STATE_CHANGED");
  if (candidateProduct.categoria !== source.categoria) throw new Error("ROTATION_CATEGORY_MISMATCH");
  const profile = profileFor(source.categoria);
  if (!profile) throw new Error("ROTATION_CATEGORY_NOT_SUPPORTED");

  const client = buildShopeeClient(env);
  const revalidated = await evaluateStoredProduct(candidateProduct, source, profile, client, env);
  if (!revalidated.candidate) {
    request = await patchRequest(request.id, { status: "failed", reason: `PREFLIGHT_REJECTED:${revalidated.reason}` });
    throw new Error(`ROTATION_PREFLIGHT_REJECTED:${revalidated.reason}`);
  }
  await refreshCandidateProduct(candidateProduct, revalidated.candidate, false, env);
  request = await patchRequest(request.id, { status: "applying", reason: null });

  const clientDb = requireSupabase();
  let sourceArchived = false;
  let candidatePublished = false;
  try {
    const publishedMeta = parseQueueNote(candidateProduct.curatorNote);
    const now = new Date();
    const candidateNote = queueNote({
      score: revalidated.candidate.score,
      profileVersion: AUTONOMOUS_CURATOR_PROFILE_VERSION,
      queuedAt: publishedMeta?.queuedAt || candidateProduct.createdAt || now.toISOString(),
      publishedAt: now.toISOString(),
      query: revalidated.candidate.query,
      shopId: revalidated.candidate.shopId,
      itemId: revalidated.candidate.itemId,
      sourceProductUrl: revalidated.candidate.sourceProductUrl,
      imageUrl: revalidated.candidate.sourceImageUrl,
    });
    const { error: candidateError } = await clientDb.from("products").update({
      ativo: true,
      status: "published",
      created_by: AUTO_QUEUE_CREATED_BY,
      curator_note: candidateNote,
    }).eq("id", candidateProduct.id).eq("status", "paused").eq("ativo", false);
    if (candidateError) throw candidateError;
    candidatePublished = true;

    const { error: sourceError } = await clientDb.from("products").update({ ativo: false, status: "archived" })
      .eq("id", source.id).eq("status", "published");
    if (sourceError) throw sourceError;
    sourceArchived = true;

    const sync = await syncCatalogAndDeploy(`manual product rotation ${request.id}`);
    if (!sync.success) throw new Error(`ROTATION_CATALOG_SYNC_FAILED:${sync.error || "unknown"}`);

    request = await patchRequest(request.id, {
      status: "replaced",
      replacement_product_id: candidateProduct.id,
      reason: "ROTATED_BY_USER",
      completed_at: new Date().toISOString(),
      metadata: {
        ...request.metadata,
        archive_reason: "ROTATED_BY_USER",
        replacement_score: revalidated.candidate.score,
        replaced_at: new Date().toISOString(),
      },
    });
    const replacement = await productsRepository.getProductByIdOrSlug(candidateProduct.id);
    const archivedSource = await productsRepository.getProductByIdOrSlug(source.id);
    if (!replacement || !archivedSource) throw new Error("ROTATION_POST_SYNC_READ_FAILED");
    return { request, source: archivedSource, replacement };
  } catch (error) {
    if (sourceArchived) await clientDb.from("products").update({ ativo: true, status: "published" }).eq("id", source.id).then(() => undefined, () => undefined);
    if (candidatePublished) await clientDb.from("products").update({ ativo: false, status: "paused", created_by: ROTATION_CANDIDATE_CREATED_BY }).eq("id", candidateProduct.id).then(() => undefined, () => undefined);
    await syncCatalogAndDeploy(`manual product rotation rollback ${request.id}`).catch(() => undefined);
    await patchRequest(request.id, { status: "candidate_ready", reason: `APPLY_FAILED:${safeReason(error)}` }).catch(() => undefined);
    throw error;
  }
}

export const productRotationInternals = {
  AUTO_QUEUE_CREATED_BY,
  ROTATION_CANDIDATE_CREATED_BY,
  QUEUE_NOTE_PREFIX,
  ROTATION_VERSION,
  queueNote,
  parseQueueNote,
  profileFor,
  sourceIdentityMatches,
  safeReason,
  newDiagnostics,
};
