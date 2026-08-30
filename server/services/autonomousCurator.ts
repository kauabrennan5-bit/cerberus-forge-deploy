import { randomUUID } from "node:crypto";
import type { Product } from "../../src/types";
import type { PublicProductCategory } from "../../src/lib/productCategory";
import { PUBLIC_PRODUCT_CATEGORIES } from "../../src/lib/productCategory";
import { resolveCanonicalProductImage } from "../../src/lib/productCanonical";
import { extractShopeeIdentity } from "../commercial/marketplace/shopeeIdentity";
import { createShopeeApiClient, type ShopeeApiClient } from "../commercial/affiliate/shopeeApiClient";
import * as productsRepository from "../repositories/productsRepository";
import * as curatorRepo from "../repositories/autonomousCuratorRepository";
import * as telegramRepo from "../repositories/telegramRepository";
import type { PendingReview } from "./telegramTypes";
import { extractProductForReview } from "./productAutomation";
import { createProductionProductPipeline, type LifecycleRecord } from "./productPipeline";
import { syncCatalogAndDeploy } from "./catalogSync";
import { sendTelegramMessage, sendTelegramPhoto, type TelegramDeliveryResult } from "./telegramBot";
import {
  AUTONOMOUS_CURATOR_PROFILES,
  AUTONOMOUS_CURATOR_PROFILE_VERSION,
  queryForProfile,
  type AutonomousCuratorCategoryProfile,
} from "./autonomousCuratorProfiles";
import {
  cheapProfileScore,
  hasBlockedProfileTerm,
  scoreAutonomousCandidate,
  type AutonomousCuratorScoreBreakdown,
} from "./autonomousCuratorScoring";

export type AutonomousCuratorDecision = "auto" | "review" | "reject" | "duplicate" | "none" | "failed";

export type AutonomousCuratorCategoryOutcome = {
  category: PublicProductCategory;
  query: string;
  decision: AutonomousCuratorDecision;
  reason: string;
  score: number | null;
  title: string | null;
  productId?: string | null;
  reviewId?: string | null;
};

export type AutonomousCuratorDailyResult = {
  status: "disabled" | "completed" | "partial" | "failed" | "dry_run" | "already_completed";
  runId: string | null;
  runDate: string;
  dryRun: boolean;
  resumed: boolean;
  categories: AutonomousCuratorCategoryOutcome[];
  autoPublished: number;
  reviewRequired: number;
  rejected: number;
  failed: number;
};

type CuratedCandidate = {
  profile: AutonomousCuratorCategoryProfile;
  query: string;
  shopId: string;
  itemId: string;
  sourceProductUrl: string;
  affiliateUrl: string;
  rawTitle: string;
  displayTitle: string;
  description: string;
  category: PublicProductCategory;
  price: number;
  images: string[];
  imageCuration: NonNullable<Product["imageCuration"]>;
  imageEditorialStatus: "clean";
  score: number;
  breakdown: AutonomousCuratorScoreBreakdown;
  lifecycle: LifecycleRecord;
};

type AutonomousCuratorDependencies = {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  shopeeClient?: ShopeeApiClient;
  getConfig?: typeof curatorRepo.getAutonomousCuratorConfig;
  openRun?: typeof curatorRepo.openAutonomousCuratorRun;
  getCategoryResult?: typeof curatorRepo.getAutonomousCuratorCategoryResult;
  saveCategoryResult?: typeof curatorRepo.saveAutonomousCuratorCategoryResult;
  finishRun?: typeof curatorRepo.finishAutonomousCuratorRun;
  findSourceIdentity?: typeof curatorRepo.findProductSourceIdentity;
  reserveSourceIdentity?: typeof curatorRepo.reserveProductSourceIdentity;
  bindSourceIdentity?: typeof curatorRepo.bindProductSourceIdentity;
  releaseSourceIdentity?: typeof curatorRepo.releaseProductSourceIdentity;
  saveImageReview?: typeof curatorRepo.saveProductImageEditorialReview;
  productsLoader?: typeof productsRepository.getProducts;
  createProduct?: typeof productsRepository.createProduct;
  updateProduct?: typeof productsRepository.updateProduct;
  extractor?: typeof extractProductForReview;
  pipelineFactory?: typeof createProductionProductPipeline;
  catalogSync?: typeof syncCatalogAndDeploy;
  savePendingReview?: typeof telegramRepo.savePendingReview;
  sendMessage?: typeof sendTelegramMessage;
  sendPhoto?: typeof sendTelegramPhoto;
};

function localRunDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Fortaleza",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (name: string) => parts.find(item => item.type === name)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function buildShopeeClient(env: NodeJS.ProcessEnv): ShopeeApiClient | null {
  const appId = (env.SHOPEE_APP_ID || env.SHOPEE_AFFILIATE_APP_ID || "").trim();
  const secret = (env.SHOPEE_APP_SECRET || env.SHOPEE_AFFILIATE_APP_SECRET || "").trim();
  if (!appId || !secret) return null;
  return createShopeeApiClient({ appId, secret, baseUrl: env.SHOPEE_AFFILIATE_API_BASE_URL });
}

function adminChatId(env: NodeJS.ProcessEnv): number | null {
  const raw = (env.TELEGRAM_ADMIN_CHAT_ID || env.TELEGRAM_ALLOWED_USER_IDS?.split(",")[0] || "").trim();
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed !== 0 ? parsed : null;
}

function actorId(env: NodeJS.ProcessEnv, chatId: number): string {
  return (env.TELEGRAM_ADMIN_USER_ID || env.TELEGRAM_ALLOWED_USER_IDS?.split(",")[0] || String(chatId)).trim();
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function canonicalSourceUrl(shopId: string, itemId: string): string {
  return `https://shopee.com.br/product/${shopId}/${itemId}`;
}

function terminalDecision(decision: string): boolean {
  return ["auto_published", "review_required", "rejected", "duplicate", "no_candidate", "dry_run_auto", "dry_run_review"].includes(decision);
}

function sourceIdentityMatches(url: string, shopId: string, itemId: string): boolean {
  const identity = extractShopeeIdentity(url);
  return identity.shopId === shopId && identity.itemId === itemId;
}

function exactExistingIdentity(products: readonly Product[], shopId: string, itemId: string): Product | null {
  for (const product of products) {
    const candidates = [product.link, product.paginaPonteUrl].filter((value): value is string => typeof value === "string" && Boolean(value));
    if (candidates.some(url => sourceIdentityMatches(url, shopId, itemId))) return product;
  }
  return null;
}

async function sendReviewCard(candidate: CuratedCandidate, review: PendingReview, deps: AutonomousCuratorDependencies): Promise<boolean> {
  const sendMessage = deps.sendMessage || sendTelegramMessage;
  const sendPhoto = deps.sendPhoto || sendTelegramPhoto;
  const text = [
    "🧠 <b>CURADORIA AUTÔNOMA — REVISÃO HUMANA</b>",
    "",
    `<b>${escapeHtml(candidate.displayTitle)}</b>`,
    `Categoria: <b>${escapeHtml(candidate.category)}</b>`,
    `Preço-base observado: <b>R$ ${candidate.price.toFixed(2).replace(".", ",")}</b>`,
    `Cerberus Score: <b>${candidate.score}/100</b>`,
    `Novidade: ${candidate.breakdown.novelty} · Imagem: ${candidate.breakdown.imageQuality} · Estilo: ${candidate.breakdown.styleFit}`,
    "",
    "O produto passou pelos gates mínimos, mas não atingiu o threshold de publicação automática.",
    "A decisão humana continua usando o pipeline canônico existente.",
  ].join("\n");
  const keyboard = {
    inline_keyboard: [
      [{ text: "✅ PUBLICAR", callback_data: `confirm_pub:${review.id}` }],
      [{ text: "❌ DESCARTAR", callback_data: `cancel_rev:${review.id}` }],
    ],
  };
  const primary = candidate.imageCuration.primaryImageUrl;
  if (primary) {
    try {
      const sent = await sendPhoto(review.chatId, primary, text, keyboard);
      if (sent.ok) return true;
    } catch {
      // fallback para texto abaixo
    }
  }
  try {
    const sent = await sendMessage(review.chatId, text, keyboard);
    return sent.ok;
  } catch {
    return false;
  }
}

async function persistHumanReview(candidate: CuratedCandidate, runId: string, env: NodeJS.ProcessEnv, deps: AutonomousCuratorDependencies): Promise<string> {
  const chatId = adminChatId(env);
  if (!chatId) throw new Error("AUTONOMOUS_CURATOR_TELEGRAM_CHAT_MISSING");
  const reviewId = `autocur-${randomUUID()}`;
  const review: PendingReview = {
    id: reviewId,
    chatId,
    senderId: actorId(env, chatId),
    firstName: "Cerberus",
    username: "autonomous_curator",
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    // Produto canônico de fallback já é editorial; rawTitle fica separado para auditoria.
    produto: candidate.displayTitle,
    rawTitle: candidate.rawTitle,
    displayTitle: candidate.displayTitle,
    categoria: candidate.category,
    preco: candidate.price,
    imagens: candidate.images,
    imagensOriginais: candidate.imageCuration.rawImageUrls,
    imagemPrincipal: candidate.imageCuration.primaryImageUrl,
    imagensGaleria: candidate.imageCuration.galleryImageUrls,
    imageEditorialStatus: "clean",
    normalizedUrl: candidate.sourceProductUrl,
    descricao: candidate.description,
    status: "pending",
    existingProduct: {
      source: "autonomous_curator",
      affiliateUrl: candidate.affiliateUrl,
      shopId: candidate.shopId,
      itemId: candidate.itemId,
      autonomousCuratorRunId: runId,
      cerberusScore: candidate.score,
    },
    lifecycle: candidate.lifecycle,
  };
  await (deps.savePendingReview || telegramRepo.savePendingReview)(review);
  const delivered = await sendReviewCard(candidate, review, deps);
  if (!delivered) throw new Error("AUTONOMOUS_CURATOR_REVIEW_TELEGRAM_FAILED");
  return reviewId;
}

async function prepareCategoryCandidate(input: {
  profile: AutonomousCuratorCategoryProfile;
  query: string;
  runId: string;
  config: curatorRepo.AutonomousCuratorConfig;
  existingProducts: Product[];
  client: ShopeeApiClient;
  deps: AutonomousCuratorDependencies;
}): Promise<{ candidate: CuratedCandidate | null; decision: "none" | "duplicate" | "reject" | "failed"; reason: string; rawTitle?: string | null; shopId?: string | null; itemId?: string | null; sourceUrl?: string | null }> {
  const search = await input.client.searchOffers({ query: input.query, limit: input.config.maxSearchCandidates });
  if (!search.ok) return { candidate: null, decision: "failed", reason: `SHOPEE_SEARCH:${search.reason || "failed"}` };
  if (search.items.length === 0) return { candidate: null, decision: "none", reason: "NO_OFFICIAL_CANDIDATES" };

  const ranked = [...search.items]
    .filter(item => item.shopId && item.itemId && item.productLink && item.name)
    .map(item => ({ item, cheap: cheapProfileScore(input.profile, item.name || "") }))
    .filter(entry => entry.cheap > -1000)
    .sort((a, b) => b.cheap - a.cheap || String(a.item.itemId).localeCompare(String(b.item.itemId)));
  if (ranked.length === 0) return { candidate: null, decision: "none", reason: "NO_PROFILE_CANDIDATES" };

  const findIdentity = input.deps.findSourceIdentity || curatorRepo.findProductSourceIdentity;
  const extractor = input.deps.extractor || extractProductForReview;
  const pipeline = (input.deps.pipelineFactory || createProductionProductPipeline)();
  let examined = 0;
  let lastReason = "NO_ENRICHABLE_CANDIDATE";

  for (const entry of ranked) {
    if (examined >= input.config.maxEnrichPerCategory) break;
    const item = entry.item;
    const shopId = String(item.shopId);
    const itemId = String(item.itemId);
    const sourceUrl = canonicalSourceUrl(shopId, itemId);
    const sourceIdentity = await findIdentity("Shopee", shopId, itemId);
    const existingByIdentity = exactExistingIdentity(input.existingProducts, shopId, itemId);
    if (sourceIdentity?.productId || existingByIdentity) {
      lastReason = "SOURCE_IDENTITY_ALREADY_PUBLISHED";
      continue;
    }
    examined += 1;

    const acquisition = await input.client.acquireAffiliateLink({ shopId, itemId });
    if (acquisition.status !== "link_acquired" || !acquisition.affiliateUrl || !acquisition.productLink || !acquisition.shopId || !acquisition.itemId) {
      lastReason = `AFFILIATE_${acquisition.status}`;
      continue;
    }
    if (acquisition.shopId !== shopId || acquisition.itemId !== itemId || !sourceIdentityMatches(acquisition.productLink, shopId, itemId)) {
      lastReason = "AFFILIATE_IDENTITY_MISMATCH";
      continue;
    }

    const extracted = await extractor(acquisition.productLink);
    if (!extracted.success || !extracted.data) {
      lastReason = `EXTRACTION_${extracted.error || "failed"}`;
      continue;
    }
    const data = extracted.data;
    if (!sourceIdentityMatches(data.normalizedUrl, shopId, itemId)) {
      lastReason = "SCRAPER_IDENTITY_MISMATCH";
      continue;
    }
    const rawTitle = (data.rawTitle || data.produto || acquisition.name || "").trim();
    const displayTitle = (data.displayTitle || "").trim();
    const description = (data.descricao || "").trim();
    const category = data.categoria as PublicProductCategory;
    const price = Number(data.preco);
    const imageCuration = data.imageCuration;
    const image = resolveCanonicalProductImage({
      imagens: data.imagens,
      imageCuration,
      imageEditorialStatus: data.imageEditorialStatus,
    });

    const blocked = hasBlockedProfileTerm(input.profile, `${rawTitle} ${displayTitle} ${description}`);
    if (blocked) return { candidate: null, decision: "reject", reason: `PROFILE_BLOCKED_TERM:${blocked}`, rawTitle, shopId, itemId, sourceUrl };
    if (!displayTitle || displayTitle === rawTitle || description.length < 24) {
      return { candidate: null, decision: "reject", reason: "EDITORIAL_COPY_INCOMPLETE", rawTitle, shopId, itemId, sourceUrl };
    }
    if (category !== input.profile.category) {
      return { candidate: null, decision: "reject", reason: `CATEGORY_MISMATCH:${category || "unknown"}`, rawTitle, shopId, itemId, sourceUrl };
    }
    if (!Number.isFinite(price) || price <= 0) {
      return { candidate: null, decision: "reject", reason: "SCRAPER_PRICE_UNVERIFIED", rawTitle, shopId, itemId, sourceUrl };
    }
    if (data.imageEditorialStatus !== "clean" || !imageCuration || imageCuration.status !== "ready" || image.status !== "ready" || !image.primaryImageUrl) {
      return { candidate: null, decision: "reject", reason: "IMAGE_REVIEW_NOT_CLEAN", rawTitle, shopId, itemId, sourceUrl };
    }

    const lifecycle = await pipeline.evaluate({
      normalizedUrl: sourceUrl,
      link: acquisition.affiliateUrl,
      marketplace: "Shopee",
      // Nunca deixar o título bruto virar fallback público.
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
    if (lifecycle.validation.outcome === "FAIL" || lifecycle.state === "ERROR" || lifecycle.state === "REJECTED") {
      return { candidate: null, decision: "reject", reason: `PIPELINE_REJECTED:${lifecycle.validation.errors.join("|")}`, rawTitle, shopId, itemId, sourceUrl };
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
      existingProducts: input.existingProducts,
    });
    if (breakdown.maximumCatalogSimilarity >= 0.82) {
      return { candidate: null, decision: "duplicate", reason: `CATALOG_SIMILARITY:${breakdown.maximumCatalogSimilarity}`, rawTitle, shopId, itemId, sourceUrl };
    }

    return {
      candidate: {
        profile: input.profile,
        query: input.query,
        shopId,
        itemId,
        sourceProductUrl: sourceUrl,
        affiliateUrl: acquisition.affiliateUrl,
        rawTitle,
        displayTitle,
        description,
        category,
        price,
        images: image.publicHttpsImageUrls,
        imageCuration,
        imageEditorialStatus: "clean",
        score: breakdown.finalScore,
        breakdown,
        lifecycle,
      },
      decision: "none",
      reason: "CURATED",
      rawTitle,
      shopId,
      itemId,
      sourceUrl,
    };
  }

  return { candidate: null, decision: lastReason === "SOURCE_IDENTITY_ALREADY_PUBLISHED" ? "duplicate" : "reject", reason: lastReason };
}

async function rollbackCreatedProducts(productIds: string[], deps: AutonomousCuratorDependencies): Promise<void> {
  const updateProduct = deps.updateProduct || productsRepository.updateProduct;
  for (const id of productIds) {
    await updateProduct(id, { ativo: false, status: "error" }, { syncCatalog: false }).catch(() => null);
  }
  if (productIds.length > 0) await (deps.catalogSync || syncCatalogAndDeploy)("rollback autonomous curator").catch(() => undefined);
}

async function publishAutoBatch(input: {
  runId: string;
  candidates: CuratedCandidate[];
  env: NodeJS.ProcessEnv;
  deps: AutonomousCuratorDependencies;
}): Promise<Array<{ candidate: CuratedCandidate; ok: boolean; productId: string | null; reason: string }>> {
  const reserve = input.deps.reserveSourceIdentity || curatorRepo.reserveProductSourceIdentity;
  const bind = input.deps.bindSourceIdentity || curatorRepo.bindProductSourceIdentity;
  const release = input.deps.releaseSourceIdentity || curatorRepo.releaseProductSourceIdentity;
  const saveImageReview = input.deps.saveImageReview || curatorRepo.saveProductImageEditorialReview;
  const createProduct = input.deps.createProduct || productsRepository.createProduct;
  const updateProduct = input.deps.updateProduct || productsRepository.updateProduct;
  const productsLoader = input.deps.productsLoader || productsRepository.getProducts;
  const created: Array<{ candidate: CuratedCandidate; productId: string }> = [];
  const results: Array<{ candidate: CuratedCandidate; ok: boolean; productId: string | null; reason: string }> = [];

  for (const candidate of input.candidates) {
    const latestProducts = await productsLoader();
    if (exactExistingIdentity(latestProducts, candidate.shopId, candidate.itemId) || latestProducts.some(product => product.link === candidate.affiliateUrl)) {
      results.push({ candidate, ok: false, productId: null, reason: "DUPLICATE_AT_COMMIT" });
      continue;
    }
    const reservation = await reserve({
      marketplace: "Shopee",
      shopId: candidate.shopId,
      itemId: candidate.itemId,
      sourceProductUrl: candidate.sourceProductUrl,
      runId: input.runId,
    });
    if (!reservation.reserved) {
      results.push({ candidate, ok: false, productId: reservation.identity?.productId || null, reason: "SOURCE_IDENTITY_RESERVED" });
      continue;
    }

    try {
      const product = await createProduct({
        produto: candidate.displayTitle,
        rawTitle: candidate.rawTitle,
        displayTitle: candidate.displayTitle,
        categoria: candidate.category,
        preco: candidate.price,
        imagens: candidate.images,
        link: candidate.affiliateUrl,
        descricao: candidate.description,
        status: "approved",
        imageEditorialStatus: "clean",
        imageCuration: candidate.imageCuration,
      }, { syncCatalog: false });
      const promoted = await updateProduct(product.id, { ativo: true, status: "published" }, { syncCatalog: false });
      if (!promoted) throw new Error("PRODUCT_PROMOTION_FAILED");
      await bind({ marketplace: "Shopee", shopId: candidate.shopId, itemId: candidate.itemId, runId: input.runId, productId: product.id });
      await saveImageReview({
        productId: product.id,
        curation: candidate.imageCuration,
        model: input.env.GEMINI_PRODUCT_IMAGE_REVIEW_MODEL || input.env.GEMINI_PRODUCT_CURATOR_MODEL || "gemini-3.6-flash",
        reviewVersion: "1.0",
      });
      created.push({ candidate, productId: product.id });
    } catch (error) {
      await release({ marketplace: "Shopee", shopId: candidate.shopId, itemId: candidate.itemId, runId: input.runId }).catch(() => undefined);
      results.push({ candidate, ok: false, productId: null, reason: error instanceof Error ? error.message.slice(0, 80) : "PERSISTENCE_FAILED" });
    }
  }

  if (created.length === 0) return results;
  const sync = await (input.deps.catalogSync || syncCatalogAndDeploy)("autonomous curator daily");
  if (!sync.success) {
    await rollbackCreatedProducts(created.map(item => item.productId), input.deps);
    for (const item of created) results.push({ candidate: item.candidate, ok: false, productId: item.productId, reason: sync.error || "CATALOG_SYNC_FAILED" });
    return results;
  }
  for (const item of created) results.push({ candidate: item.candidate, ok: true, productId: item.productId, reason: "PUBLISHED_AND_PUBLICLY_VALIDATED" });
  return results;
}

function resultStatus(outcomes: AutonomousCuratorCategoryOutcome[], dryRun: boolean): AutonomousCuratorDailyResult["status"] {
  if (dryRun) return "dry_run";
  const failed = outcomes.filter(item => item.decision === "failed").length;
  return failed === 0 ? "completed" : failed < outcomes.length ? "partial" : "failed";
}

function summaryText(result: AutonomousCuratorDailyResult): string {
  const icon = result.status === "completed" || result.status === "dry_run" ? "🧠" : "⚠️";
  const lines = result.categories.map(item => {
    const marker = item.decision === "auto" ? "✅" : item.decision === "review" ? "🟡" : item.decision === "failed" ? "⚠️" : "·";
    const score = item.score === null ? "" : ` · ${item.score}/100`;
    return `${marker} <b>${escapeHtml(item.category)}</b>: ${escapeHtml(item.title || item.reason)}${score}`;
  });
  return [
    `${icon} <b>CERBERUS AUTONOMOUS CURATOR</b>`,
    "",
    `Data: <code>${result.runDate}</code>${result.dryRun ? " · <b>DRY RUN</b>" : ""}`,
    `Auto-publicados: <b>${result.autoPublished}</b> · revisão humana: <b>${result.reviewRequired}</b> · rejeitados/sem candidato: <b>${result.rejected}</b> · falhas: <b>${result.failed}</b>`,
    "",
    ...lines,
    "",
    result.dryRun
      ? "Nenhum produto, review ou catálogo foi alterado neste dry-run."
      : "A quota é um teto, não uma obrigação: categorias sem candidato forte ficam sem publicação.",
  ].join("\n");
}

export async function runAutonomousCuratorDaily(options: { dryRun?: boolean; notify?: boolean } = {}, deps: AutonomousCuratorDependencies = {}): Promise<AutonomousCuratorDailyResult> {
  const env = deps.env || process.env;
  const now = deps.now || new Date();
  const runDate = localRunDate(now);
  const dryRun = options.dryRun === true;
  const config = await (deps.getConfig || curatorRepo.getAutonomousCuratorConfig)();
  if (!dryRun && !config.enabled) {
    return { status: "disabled", runId: null, runDate, dryRun: false, resumed: false, categories: [], autoPublished: 0, reviewRequired: 0, rejected: 0, failed: 0 };
  }
  const client = deps.shopeeClient || buildShopeeClient(env);
  if (!client) throw new Error("AUTONOMOUS_CURATOR_SHOPEE_NOT_CONFIGURED");
  const open = await (deps.openRun || curatorRepo.openAutonomousCuratorRun)({
    runDate,
    dryRun,
    profileVersion: AUTONOMOUS_CURATOR_PROFILE_VERSION,
    categoriesTotal: AUTONOMOUS_CURATOR_PROFILES.length,
  });
  if (!dryRun && open.resumed && open.run.status === "completed") {
    return { status: "already_completed", runId: open.run.id, runDate, dryRun: false, resumed: true, categories: [], autoPublished: 0, reviewRequired: 0, rejected: 0, failed: 0 };
  }

  const productsLoader = deps.productsLoader || productsRepository.getProducts;
  const existingProducts = await productsLoader();
  const outcomes: AutonomousCuratorCategoryOutcome[] = [];
  const autoCandidates: CuratedCandidate[] = [];
  const saveResult = deps.saveCategoryResult || curatorRepo.saveAutonomousCuratorCategoryResult;
  const getPrevious = deps.getCategoryResult || curatorRepo.getAutonomousCuratorCategoryResult;

  for (const profile of AUTONOMOUS_CURATOR_PROFILES) {
    const query = queryForProfile(profile, runDate);
    const previous = await getPrevious(open.run.id, profile.category);
    if (!dryRun && previous && terminalDecision(previous.decision)) {
      outcomes.push({
        category: profile.category,
        query,
        decision: previous.decision === "auto_published" ? "auto" : previous.decision === "review_required" ? "review" : previous.decision === "failed" ? "failed" : previous.decision === "duplicate" ? "duplicate" : "reject",
        reason: previous.reason || previous.decision,
        score: previous.score ?? null,
        title: previous.displayTitle || previous.rawTitle || null,
        productId: previous.productId,
        reviewId: previous.reviewId,
      });
      continue;
    }
    if (config.maxDailyPerCategory <= 0) {
      await saveResult({ runId: open.run.id, category: profile.category, searchQuery: query, decision: "no_candidate", reason: "CATEGORY_DAILY_LIMIT_ZERO" });
      outcomes.push({ category: profile.category, query, decision: "none", reason: "CATEGORY_DAILY_LIMIT_ZERO", score: null, title: null });
      continue;
    }

    try {
      const prepared = await prepareCategoryCandidate({ profile, query, runId: open.run.id, config, existingProducts, client, deps });
      if (!prepared.candidate) {
        const decision = prepared.decision === "failed" ? "failed" : prepared.decision === "duplicate" ? "duplicate" : prepared.decision === "reject" ? "rejected" : "no_candidate";
        await saveResult({
          runId: open.run.id,
          category: profile.category,
          searchQuery: query,
          shopId: prepared.shopId,
          itemId: prepared.itemId,
          sourceProductUrl: prepared.sourceUrl,
          rawTitle: prepared.rawTitle,
          decision,
          reason: prepared.reason,
        });
        outcomes.push({ category: profile.category, query, decision: prepared.decision, reason: prepared.reason, score: null, title: prepared.rawTitle || null });
        continue;
      }

      const candidate = prepared.candidate;
      const canAuto = config.autoPublishEnabled
        && candidate.score >= config.autoPublishThreshold
        && candidate.lifecycle.validation.outcome === "PASS"
        && candidate.lifecycle.curation.recommendation === "PUBLISH";
      const canReview = candidate.score >= config.reviewThreshold;

      if (dryRun) {
        const decision = canAuto ? "dry_run_auto" : canReview ? "dry_run_review" : "rejected";
        await saveResult({
          runId: open.run.id,
          category: profile.category,
          searchQuery: query,
          shopId: candidate.shopId,
          itemId: candidate.itemId,
          sourceProductUrl: candidate.sourceProductUrl,
          rawTitle: candidate.rawTitle,
          displayTitle: candidate.displayTitle,
          score: candidate.score,
          scoreBreakdown: candidate.breakdown as unknown as Record<string, unknown>,
          decision,
          reason: canAuto ? "WOULD_AUTO_PUBLISH" : canReview ? "WOULD_REQUIRE_REVIEW" : "BELOW_REVIEW_THRESHOLD",
        });
        outcomes.push({ category: profile.category, query, decision: canAuto ? "auto" : canReview ? "review" : "reject", reason: canAuto ? "WOULD_AUTO_PUBLISH" : canReview ? "WOULD_REQUIRE_REVIEW" : "BELOW_REVIEW_THRESHOLD", score: candidate.score, title: candidate.displayTitle });
        continue;
      }

      if (canAuto) {
        await saveResult({
          runId: open.run.id,
          category: profile.category,
          searchQuery: query,
          shopId: candidate.shopId,
          itemId: candidate.itemId,
          sourceProductUrl: candidate.sourceProductUrl,
          rawTitle: candidate.rawTitle,
          displayTitle: candidate.displayTitle,
          score: candidate.score,
          scoreBreakdown: candidate.breakdown as unknown as Record<string, unknown>,
          decision: "auto_selected",
          reason: "STRICT_AUTO_PUBLISH_GATES_PASSED",
        });
        autoCandidates.push(candidate);
        outcomes.push({ category: profile.category, query, decision: "auto", reason: "AUTO_SELECTED", score: candidate.score, title: candidate.displayTitle });
        continue;
      }

      if (canReview) {
        const reviewId = await persistHumanReview(candidate, open.run.id, env, deps);
        await saveResult({
          runId: open.run.id,
          category: profile.category,
          searchQuery: query,
          shopId: candidate.shopId,
          itemId: candidate.itemId,
          sourceProductUrl: candidate.sourceProductUrl,
          rawTitle: candidate.rawTitle,
          displayTitle: candidate.displayTitle,
          score: candidate.score,
          scoreBreakdown: candidate.breakdown as unknown as Record<string, unknown>,
          decision: "review_required",
          reason: "BELOW_AUTO_THRESHOLD_OR_PIPELINE_WARNING",
          reviewId,
        });
        outcomes.push({ category: profile.category, query, decision: "review", reason: "HUMAN_REVIEW_REQUIRED", score: candidate.score, title: candidate.displayTitle, reviewId });
        continue;
      }

      await saveResult({
        runId: open.run.id,
        category: profile.category,
        searchQuery: query,
        shopId: candidate.shopId,
        itemId: candidate.itemId,
        sourceProductUrl: candidate.sourceProductUrl,
        rawTitle: candidate.rawTitle,
        displayTitle: candidate.displayTitle,
        score: candidate.score,
        scoreBreakdown: candidate.breakdown as unknown as Record<string, unknown>,
        decision: "rejected",
        reason: "BELOW_REVIEW_THRESHOLD",
      });
      outcomes.push({ category: profile.category, query, decision: "reject", reason: "BELOW_REVIEW_THRESHOLD", score: candidate.score, title: candidate.displayTitle });
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 120) : "CATEGORY_PROCESSING_FAILED";
      await saveResult({ runId: open.run.id, category: profile.category, searchQuery: query, decision: "failed", reason }).catch(() => undefined);
      outcomes.push({ category: profile.category, query, decision: "failed", reason, score: null, title: null });
    }
  }

  if (!dryRun && autoCandidates.length > 0) {
    const publication = await publishAutoBatch({ runId: open.run.id, candidates: autoCandidates, env, deps });
    for (const item of publication) {
      const index = outcomes.findIndex(outcome => outcome.category === item.candidate.category);
      if (item.ok) {
        await saveResult({
          runId: open.run.id,
          category: item.candidate.category,
          searchQuery: item.candidate.query,
          shopId: item.candidate.shopId,
          itemId: item.candidate.itemId,
          sourceProductUrl: item.candidate.sourceProductUrl,
          rawTitle: item.candidate.rawTitle,
          displayTitle: item.candidate.displayTitle,
          score: item.candidate.score,
          scoreBreakdown: item.candidate.breakdown as unknown as Record<string, unknown>,
          decision: "auto_published",
          reason: item.reason,
          productId: item.productId,
        });
        if (index >= 0) outcomes[index] = { ...outcomes[index], decision: "auto", reason: item.reason, productId: item.productId };
      } else {
        const duplicate = item.reason.includes("DUPLICATE") || item.reason.includes("RESERVED");
        await saveResult({
          runId: open.run.id,
          category: item.candidate.category,
          searchQuery: item.candidate.query,
          shopId: item.candidate.shopId,
          itemId: item.candidate.itemId,
          sourceProductUrl: item.candidate.sourceProductUrl,
          rawTitle: item.candidate.rawTitle,
          displayTitle: item.candidate.displayTitle,
          score: item.candidate.score,
          scoreBreakdown: item.candidate.breakdown as unknown as Record<string, unknown>,
          decision: duplicate ? "duplicate" : "failed",
          reason: item.reason,
          productId: item.productId,
        });
        if (index >= 0) outcomes[index] = { ...outcomes[index], decision: duplicate ? "duplicate" : "failed", reason: item.reason, productId: item.productId };
      }
    }
  }

  const autoPublished = outcomes.filter(item => item.decision === "auto" && (!dryRun ? Boolean(item.productId) : true)).length;
  const reviewRequired = outcomes.filter(item => item.decision === "review").length;
  const failed = outcomes.filter(item => item.decision === "failed").length;
  const rejected = outcomes.filter(item => ["reject", "duplicate", "none"].includes(item.decision)).length;
  const status = resultStatus(outcomes, dryRun);
  await (deps.finishRun || curatorRepo.finishAutonomousCuratorRun)({
    runId: open.run.id,
    status: dryRun ? "dry_run" : status === "completed" ? "completed" : status === "partial" ? "partial" : "failed",
    categoriesProcessed: outcomes.length,
    autoPublished,
    reviewRequired,
    rejected,
    failed,
    metadata: { profileVersion: AUTONOMOUS_CURATOR_PROFILE_VERSION },
  });

  const result: AutonomousCuratorDailyResult = {
    status,
    runId: open.run.id,
    runDate,
    dryRun,
    resumed: open.resumed,
    categories: outcomes,
    autoPublished,
    reviewRequired,
    rejected,
    failed,
  };
  if (options.notify !== false) {
    const chatId = adminChatId(env);
    if (chatId) await (deps.sendMessage || sendTelegramMessage)(chatId, summaryText(result)).catch(() => ({ ok: false } as TelegramDeliveryResult));
  }
  return result;
}
