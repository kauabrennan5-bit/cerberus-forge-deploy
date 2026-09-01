import {
  createShopeeApiClient,
  type ShopeeApiClient,
} from "../commercial/affiliate/shopeeApiClient";
import { savePendingReview } from "../repositories/telegramRepository";
import * as curatorRepo from "../repositories/autonomousCuratorRepository";
import { resolvePublicProductCategory } from "../../src/lib/productCategory";
import type { ProductImageCuration } from "../../src/lib/productImageCuration";
import type { PendingReview } from "./telegramBot";
import { sendTelegramMessage, sendTelegramPhoto } from "./telegramBot";
import {
  controlledShopeeQueryVariants,
  evaluateShopeeCandidateRelevance,
  qualifyOfficialShopeeImage,
  type ShopeeCandidateVisualState,
  type ShopeeImageQualification,
} from "./shopeeCandidateQualification";
import {
  inspectShopeeProviderEnv,
  maskShopeeReference,
  newShopeeCorrelationId,
  providerErrorFromAcquisitionStatus,
  safeShopeeLog,
  searchShopeeOffersWithRetry,
  ShopeeProviderRuntimeError,
  validateOfficialProductLink,
} from "./shopeeProviderRuntime";
import {
  buildShopeeBatchId,
  buildShopeeReviewId,
  parseShopeeCommand,
  type ShopeeCommandOutcomeCode,
  type ShopeeLotItemResult,
  type ShopeeLotResult,
} from "./shopeeCommandRanked";

const MAX_DISCOVERY_CANDIDATES = 30;
const MAX_SEARCH_CALLS = 6;
const SEARCH_PAGE_LIMIT = 10;
const REVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const CARD_PAUSE_MS = 1200;

export interface ShopeeManualDeliveryDeps {
  client?: ShopeeApiClient | null;
  chatId?: number;
  sendMessage?: typeof sendTelegramMessage;
  sendPhoto?: typeof sendTelegramPhoto;
  saveReview?: typeof savePendingReview;
  qualifyImage?: (imageUrl: string, title: string) => Promise<ShopeeImageQualification>;
  identityAlreadyKnown?: (shopId: string, itemId: string) => Promise<boolean>;
  cardPauseMs?: number;
}

type ManualCandidate = {
  candidateIndex: number;
  shopId: string;
  itemId: string;
  name: string;
  price: number;
  productLink: string;
  imageUrl: string;
  round: number;
  queryVariant: string;
  category: string;
  relevanceScore: number;
  warnings: string[];
  qualification: ShopeeImageQualification;
};

function uniqueWarnings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => String(value || "").trim()).filter(Boolean))];
}

function incrementReason(counts: Record<string, number>, reason: string): void {
  const key = String(reason || "UNKNOWN").trim() || "UNKNOWN";
  counts[key] = (counts[key] || 0) + 1;
}

function buildClient(): ShopeeApiClient | null {
  const status = inspectShopeeProviderEnv(process.env);
  if (!status.credentialsConfigured || !status.baseUrlStructurallyValid) return null;
  const appId = String(process.env.SHOPEE_APP_ID ?? process.env.SHOPEE_AFFILIATE_APP_ID ?? "").trim();
  const appSecret = String(process.env.SHOPEE_APP_SECRET ?? process.env.SHOPEE_AFFILIATE_APP_SECRET ?? "").trim();
  if (!appId || !appSecret) return null;
  return createShopeeApiClient({ appId, secret: appSecret, baseUrl: process.env.SHOPEE_AFFILIATE_API_BASE_URL });
}

function emptyResult(input: {
  count: number;
  lotId: string;
  correlationId: string;
  chatId: number;
  chatConfigured: boolean;
  clientAvailable: boolean;
  errorCode: ShopeeLotResult["errorCode"];
  discoveryError?: string | null;
}): ShopeeLotResult {
  return {
    lotId: input.lotId,
    correlationId: input.correlationId,
    chatId: input.chatId,
    countRequested: input.count,
    processed: 0,
    ok: 0,
    failed: input.count,
    rejectedCandidates: 0,
    candidatesExamined: 0,
    candidatesReceived: 0,
    hardRejectCount: 0,
    needsHumanReviewCount: 0,
    qualifiedCount: 0,
    topCandidatesCount: 0,
    rankingExecuted: false,
    searchExhausted: false,
    poolLocalExhausted: false,
    sourceExhausted: false,
    budgetExhausted: false,
    discoveryRounds: 0,
    poolCandidates: 0,
    discoveryError: input.discoveryError ?? input.errorCode,
    errorCode: input.errorCode,
    providerQueryExecuted: false,
    rejectionCounts: {},
    items: [],
    chatTargetConfigured: input.chatConfigured,
    affiliateClientAvailable: input.clientAvailable,
  };
}

function providerMessage(code: ShopeeCommandOutcomeCode): string {
  if (code === "SHOPEE_PROVIDER_NOT_CONFIGURED") return "Provider oficial não configurado; nenhuma consulta foi executada.";
  if (code === "SHOPEE_PROVIDER_AUTH_FAILED") return "A API oficial rejeitou a autenticação.";
  if (code === "SHOPEE_PROVIDER_FORBIDDEN") return "A credencial foi reconhecida, mas não possui autorização suficiente.";
  if (code === "SHOPEE_PROVIDER_RESPONSE_INVALID") return "A API oficial respondeu em formato incompatível.";
  return "O provider oficial ficou indisponível, atingiu timeout ou rate limit.";
}

function publicProviderCode(error: ShopeeProviderRuntimeError): ShopeeCommandOutcomeCode {
  if (["SHOPEE_PROVIDER_TIMEOUT", "SHOPEE_PROVIDER_RATE_LIMITED", "SHOPEE_PROVIDER_UNAVAILABLE"].includes(error.code)) {
    return "SHOPEE_PROVIDER_UNAVAILABLE";
  }
  return error.code;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildImageCuration(imageUrl: string, qualification: ShopeeImageQualification): ProductImageCuration {
  const rawImageUrls = imageUrl ? [imageUrl] : [];
  if (qualification.state === "QUALIFIED" && imageUrl) {
    return {
      status: "ready",
      rawImageUrls,
      primaryImageUrl: imageUrl,
      galleryImageUrls: [],
      assessments: qualification.assessment ? [qualification.assessment] : [],
    };
  }
  return {
    status: "review_required",
    rawImageUrls,
    galleryImageUrls: [],
    assessments: qualification.assessment ? [qualification.assessment] : [],
    reason: qualification.curationReason || "no_commercial_image",
  };
}

function manualRankingScore(candidate: ManualCandidate): number {
  const visualBonus: Record<ShopeeCandidateVisualState, number> = {
    QUALIFIED: 140,
    NEEDS_HUMAN_REVIEW: 70,
    HARD_REJECT: 0,
  };
  const warningPenalty = candidate.warnings.reduce((total, warning) => {
    if (warning === "CATEGORY_MISMATCH" || warning === "INTENT_MISMATCH") return total + 420;
    if (warning === "LOW_RELEVANCE") return total + 260;
    if (warning === "SOURCE_IDENTITY_ALREADY_OWNED") return total + 80;
    return total + 15;
  }, 0);
  return candidate.relevanceScore * 10 + visualBonus[candidate.qualification.state] + candidate.qualification.visualScore - warningPenalty;
}

export function rankManualShopeeCandidates<T extends ManualCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort((left, right) => {
    const scoreDelta = manualRankingScore(right) - manualRankingScore(left);
    if (scoreDelta !== 0) return scoreDelta;
    return `${left.shopId}:${left.itemId}`.localeCompare(`${right.shopId}:${right.itemId}`);
  });
}

function reviewStatus(candidate: ManualCandidate): Exclude<ShopeeCandidateVisualState, "HARD_REJECT"> {
  return candidate.qualification.state === "QUALIFIED" && candidate.warnings.length === 0
    ? "QUALIFIED"
    : "NEEDS_HUMAN_REVIEW";
}

function buildCardText(input: {
  rank: number;
  requested: number;
  candidate: ManualCandidate;
  name: string;
  category: string;
  price: number;
  batchId: string;
  affiliateReady: boolean;
}): string {
  const warnings = uniqueWarnings(input.candidate.warnings);
  const price = Number.isFinite(input.price) && input.price > 0
    ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2 }).format(input.price)
    : "não confirmado";
  const warningBlock = warnings.length > 0
    ? [
        "⚠️ <b>FILTROS QUE NÃO PASSARAM — DECISÃO HUMANA</b>",
        ...warnings.map(reason => `• <code>${escapeHtml(reason)}</code>`),
      ].join("\n")
    : "✅ <b>Filtros:</b> sem ressalvas relevantes";
  const affiliateLine = input.affiliateReady
    ? "🔗 <b>Afiliado:</b> evidência oficial disponível"
    : "⚠️ <b>Afiliado:</b> não confirmado neste momento; aprovação pode ser bloqueada no preflight";
  return [
    `🛡️ <b>CERBERUS FINDS — OPÇÃO #${input.rank} DE ${input.requested}</b>`,
    "",
    `🏷️ <b>Produto:</b> ${escapeHtml(input.name)}`,
    `💰 <b>Preço oficial:</b> ${price}`,
    `🗂️ <b>Categoria observada:</b> ${escapeHtml(input.category || "em revisão")}`,
    `🎯 <b>Aderência à busca:</b> ${Math.max(0, Math.min(100, input.candidate.relevanceScore))}/100`,
    `🖼️ <b>Imagem:</b> <code>${escapeHtml(input.candidate.qualification.reason)}</code>`,
    affiliateLine,
    "",
    warningBlock,
    "",
    "👤 <b>A decisão editorial final é sua.</b> Este produto chegou ao card mesmo quando filtros automáticos reprovaram imagem, categoria ou relevância.",
    `🔎 <b>Referência de auditoria:</b> <code>${maskShopeeReference(input.candidate.shopId, input.candidate.itemId)}</code>`,
    `<b>Lote:</b> <code>${escapeHtml(input.batchId)}</code>`,
    "",
    "<i>APROVAR continua executando o preflight canônico antes de qualquer publicação; filtros automáticos não podem mais esconder todas as opções da busca manual.</i>",
  ].join("\n");
}

function previewKeyboard(reviewId: string) {
  return {
    inline_keyboard: [
      [{ text: "✅ APROVAR", callback_data: `confirm_pub:${reviewId}` }],
      [{ text: "❌ REJEITAR", callback_data: `cancel_rev:${reviewId}` }],
    ],
  };
}

async function sendCard(input: {
  chatId: number;
  imageUrl: string;
  text: string;
  reviewId: string;
  sendMessage: typeof sendTelegramMessage;
  sendPhoto: typeof sendTelegramPhoto;
}): Promise<{ ok: boolean; reason?: string }> {
  if (input.imageUrl) {
    try {
      const photo = await input.sendPhoto(input.chatId, input.imageUrl, input.text, previewKeyboard(input.reviewId));
      if (photo.ok) return { ok: true };
    } catch {
      // O card de texto é o fallback obrigatório da busca manual.
    }
  }
  try {
    const text = await input.sendMessage(input.chatId, input.text, previewKeyboard(input.reviewId));
    return text.ok ? { ok: true } : { ok: false, reason: text.failureReason || "TELEGRAM_SEND_FAILED" };
  } catch {
    return { ok: false, reason: "TELEGRAM_TRANSPORT_FAILED" };
  }
}

async function discoverCandidates(input: {
  client: ShopeeApiClient;
  query: string;
  rejectionCounts: Record<string, number>;
}): Promise<{ candidates: Omit<ManualCandidate, "qualification">[]; received: number; calls: number; sourceExhausted: boolean }> {
  const candidates: Omit<ManualCandidate, "qualification">[] = [];
  const seen = new Set<string>();
  const variants = controlledShopeeQueryVariants(input.query);
  let received = 0;
  let calls = 0;
  let sourceExhausted = true;

  for (let variantIndex = 0; variantIndex < variants.length && calls < MAX_SEARCH_CALLS && candidates.length < MAX_DISCOVERY_CANDIDATES; variantIndex += 1) {
    const variant = variants[variantIndex];
    const pagesForVariant = variantIndex === 0 ? 3 : 1;
    for (let page = 1; page <= pagesForVariant && calls < MAX_SEARCH_CALLS && candidates.length < MAX_DISCOVERY_CANDIDATES; page += 1) {
      calls += 1;
      const search = await searchShopeeOffersWithRetry({ client: input.client, query: variant, limit: SEARCH_PAGE_LIMIT, page });
      received += search.items.length;
      if (search.items.length === 0) break;
      for (const raw of search.items) {
        const shopId = String(raw.shopId || "").trim();
        const itemId = String(raw.itemId || "").trim();
        const identity = `${shopId}:${itemId}`;
        if (shopId && itemId && seen.has(identity)) {
          incrementReason(input.rejectionCounts, "DUPLICATE_DISCOVERY_IDENTITY");
          continue;
        }
        if (shopId && itemId) seen.add(identity);

        const name = String(raw.name || "").replace(/\s+/g, " ").trim().slice(0, 180);
        const price = Number(raw.price);
        const productLink = String(raw.productLink || "").trim();
        const imageUrl = String(raw.imageUrl || "").trim();
        const warnings: string[] = [];
        if (!shopId || !itemId) warnings.push("IDENTITY_MISSING");
        if (!name) warnings.push("TITLE_MISSING");
        if (!Number.isFinite(price) || price <= 0) warnings.push("PRICE_MISSING");
        if (shopId && itemId && !validateOfficialProductLink(productLink, shopId, itemId)) warnings.push("OFFICIAL_PRODUCT_LINK_INVALID");
        if (!imageUrl) warnings.push("IMAGE_MISSING");

        const relevance = name
          ? evaluateShopeeCandidateRelevance(input.query, name)
          : { compatible: false, category: resolvePublicProductCategory("", { title: input.query }), score: 0, reason: "TITLE_MISSING" };
        if (!relevance.compatible) warnings.push(relevance.reason);
        for (const warning of uniqueWarnings(warnings)) incrementReason(input.rejectionCounts, warning);

        candidates.push({
          candidateIndex: candidates.length + 1,
          shopId,
          itemId,
          name,
          price: Number.isFinite(price) ? price : 0,
          productLink,
          imageUrl,
          round: calls,
          queryVariant: variant,
          category: relevance.category,
          relevanceScore: relevance.score,
          warnings: uniqueWarnings(warnings),
        });
        if (candidates.length >= MAX_DISCOVERY_CANDIDATES) break;
      }
      if (search.items.length < SEARCH_PAGE_LIMIT) break;
      sourceExhausted = false;
    }
  }
  return { candidates, received, calls, sourceExhausted };
}

function unavailableImage(reason: string): ShopeeImageQualification {
  return {
    state: "HARD_REJECT",
    reason,
    probe: { ok: false, httpStatus: null, mimeType: null, width: null, height: null, format: null, byteLength: null, reason },
    assessment: null,
    curationReason: "no_commercial_image",
    visualScore: 0,
  };
}

export async function runShopeeManualDeliveryCommand(argsRaw: string, deps: ShopeeManualDeliveryDeps = {}): Promise<ShopeeLotResult> {
  const parsed = parseShopeeCommand(argsRaw);
  if (parsed.error || (parsed.mode || "term") !== "term") {
    const fallback = emptyResult({
      count: parsed.count,
      lotId: "",
      correlationId: "",
      chatId: 0,
      chatConfigured: false,
      clientAvailable: false,
      errorCode: null,
      discoveryError: parsed.error,
    });
    return fallback;
  }

  const lotId = buildShopeeBatchId();
  const correlationId = newShopeeCorrelationId("shopee-manual");
  const chatId = deps.chatId ?? Number((process.env.TELEGRAM_ALLOWED_USER_IDS?.split(",")[0] || "").trim() || "0");
  const chatTargetConfigured = Number.isSafeInteger(chatId) && chatId > 0;
  const client = deps.client === undefined ? buildClient() : deps.client;
  const affiliateClientAvailable = client !== null;
  const sendMessage = deps.sendMessage || sendTelegramMessage;
  const sendPhoto = deps.sendPhoto || sendTelegramPhoto;
  const saveReview = deps.saveReview || savePendingReview;
  const qualifyImage = deps.qualifyImage || qualifyOfficialShopeeImage;
  const identityAlreadyKnown = deps.identityAlreadyKnown || (async (shopId: string, itemId: string) => {
    const identity = await curatorRepo.findProductSourceIdentity("Shopee", shopId, itemId);
    return Boolean(identity?.productId);
  });

  if (!chatTargetConfigured) {
    return emptyResult({ count: parsed.count, lotId, correlationId, chatId, chatConfigured: false, clientAvailable: affiliateClientAvailable, errorCode: "TELEGRAM_ALLOWED_USER_IDS_MISSING" });
  }
  if (!client) {
    await sendMessage(chatId, "⚠️ <b>SHOPEE_PROVIDER_NOT_CONFIGURED</b>\n\nProvider oficial não configurado; nenhuma consulta foi executada.").catch(() => undefined);
    return emptyResult({ count: parsed.count, lotId, correlationId, chatId, chatConfigured: true, clientAvailable: false, errorCode: "SHOPEE_PROVIDER_NOT_CONFIGURED" });
  }

  const rejectionCounts: Record<string, number> = {};
  let discovered: Awaited<ReturnType<typeof discoverCandidates>>;
  try {
    discovered = await discoverCandidates({ client, query: parsed.query, rejectionCounts });
  } catch (error) {
    const providerFailure = error instanceof ShopeeProviderRuntimeError
      ? error
      : new ShopeeProviderRuntimeError("SHOPEE_PROVIDER_UNAVAILABLE", "unexpected_search_failure", true);
    const code = publicProviderCode(providerFailure);
    await sendMessage(chatId, `⚠️ <b>${code}</b>\n\n${providerMessage(code)}`).catch(() => undefined);
    const base = emptyResult({ count: parsed.count, lotId, correlationId, chatId, chatConfigured: true, clientAvailable: true, errorCode: code });
    return { ...base, providerQueryExecuted: true };
  }

  if (discovered.received === 0) {
    await sendMessage(chatId, "🔎 <b>SHOPEE_NO_RESULTS</b>\n\nA busca oficial foi executada e não retornou nenhum produto.").catch(() => undefined);
    const base = emptyResult({ count: parsed.count, lotId, correlationId, chatId, chatConfigured: true, clientAvailable: true, errorCode: "SHOPEE_NO_RESULTS" });
    return {
      ...base,
      providerQueryExecuted: true,
      discoveryRounds: discovered.calls,
      sourceExhausted: discovered.sourceExhausted,
      searchExhausted: discovered.sourceExhausted,
    };
  }

  await sendMessage(
    chatId,
    `🛒 <b>LOTE SHOPEE INICIADO</b>\n\nSolicitados: <b>${parsed.count}</b>\nCandidatos oficiais recebidos: <b>${discovered.received}</b>\nPool único: <b>${discovered.candidates.length}</b>\n\n<i>Regra manual: filtros qualificam e ranqueiam, mas não podem zerar os cards. As melhores ${parsed.count} opções chegam para decisão humana.</i>`,
  ).catch(() => undefined);

  const qualifiedCandidates: ManualCandidate[] = [];
  let hardRejectCount = 0;
  let qualifiedCount = 0;

  for (const raw of discovered.candidates) {
    let qualification: ShopeeImageQualification;
    if (!raw.imageUrl) {
      qualification = unavailableImage("IMAGE_MISSING");
    } else {
      try {
        qualification = await qualifyImage(raw.imageUrl, raw.name || parsed.query);
      } catch {
        qualification = {
          state: "NEEDS_HUMAN_REVIEW",
          reason: "IMAGE_REVIEW_UNAVAILABLE",
          probe: { ok: true, httpStatus: null, mimeType: null, width: null, height: null, format: null, byteLength: null, reason: null },
          assessment: null,
          curationReason: "image_review_unavailable",
          visualScore: 35,
        };
      }
    }
    const warnings = [...raw.warnings];
    if (qualification.state !== "QUALIFIED") {
      warnings.push(qualification.reason);
      incrementReason(rejectionCounts, qualification.reason);
    }
    if (raw.shopId && raw.itemId) {
      try {
        if (await identityAlreadyKnown(raw.shopId, raw.itemId)) {
          warnings.push("SOURCE_IDENTITY_ALREADY_OWNED");
          incrementReason(rejectionCounts, "SOURCE_IDENTITY_ALREADY_OWNED");
        }
      } catch {
        warnings.push("DUPLICATE_CHECK_UNAVAILABLE");
        incrementReason(rejectionCounts, "DUPLICATE_CHECK_UNAVAILABLE");
      }
    }
    if (qualification.state === "HARD_REJECT") hardRejectCount += 1;
    if (qualification.state === "QUALIFIED" && warnings.length === 0) qualifiedCount += 1;
    qualifiedCandidates.push({ ...raw, warnings: uniqueWarnings(warnings), qualification });
  }

  const ranked = rankManualShopeeCandidates(qualifiedCandidates);
  const items: ShopeeLotItemResult[] = qualifiedCandidates.map(candidate => ({
    position: candidate.candidateIndex,
    candidateIndex: candidate.candidateIndex,
    discoveryRound: candidate.round,
    status: candidate.warnings.length > 0 ? "needs_human_review" : "ok",
    publicUrl: candidate.productLink || null,
    shopId: candidate.shopId || null,
    itemId: candidate.itemId || null,
    reviewId: null,
    imageCount: candidate.imageUrl ? 1 : 0,
    reason: candidate.warnings.length > 0 ? candidate.warnings.join(" | ") : null,
    qualificationState: candidate.qualification.state,
    rank: null,
  }));

  let accepted = 0;
  let providerFailure: ShopeeProviderRuntimeError | null = null;
  const pauseMs = Math.max(0, deps.cardPauseMs ?? CARD_PAUSE_MS);

  for (let rankIndex = 0; rankIndex < ranked.length && accepted < parsed.count; rankIndex += 1) {
    const candidate = ranked[rankIndex];
    if (!candidate.shopId || !candidate.itemId) continue;
    if (accepted > 0 && pauseMs > 0) await new Promise<void>(resolve => setTimeout(resolve, pauseMs));
    const item = items.find(current => current.candidateIndex === candidate.candidateIndex)!;
    item.rank = accepted + 1;

    let acquisition: Awaited<ReturnType<ShopeeApiClient["acquireAffiliateLink"]>>;
    try {
      acquisition = await client.acquireAffiliateLink({ shopId: candidate.shopId, itemId: candidate.itemId });
    } catch {
      providerFailure = new ShopeeProviderRuntimeError("SHOPEE_PROVIDER_UNAVAILABLE", "affiliate_acquisition_failed", true);
      item.status = "provider_error";
      item.reason = providerFailure.code;
      break;
    }

    if (acquisition.status !== "link_acquired") {
      const infrastructure = providerErrorFromAcquisitionStatus(acquisition.status, acquisition.error?.kind);
      if (infrastructure) {
        providerFailure = infrastructure;
        item.status = "provider_error";
        item.reason = infrastructure.code;
        break;
      }
      item.status = "affiliate_not_eligible";
      item.reason = `AFFILIATE_${acquisition.status}`;
      incrementReason(rejectionCounts, item.reason);
      continue;
    }

    const acquiredLink = String(acquisition.productLink || "").trim();
    if (!acquiredLink || acquisition.shopId !== candidate.shopId || acquisition.itemId !== candidate.itemId || !validateOfficialProductLink(acquiredLink, candidate.shopId, candidate.itemId)) {
      item.status = "affiliate_not_eligible";
      item.reason = "AFFILIATE_EVIDENCE_INVALID";
      incrementReason(rejectionCounts, "AFFILIATE_EVIDENCE_INVALID");
      continue;
    }

    const finalName = String(acquisition.name || candidate.name || "Produto Shopee em revisão").replace(/\s+/g, " ").trim().slice(0, 180);
    const acquiredPrice = Number(acquisition.price ?? candidate.price);
    const finalPrice = Number.isFinite(acquiredPrice) && acquiredPrice > 0 ? acquiredPrice : candidate.price;
    if (!Number.isFinite(finalPrice) || finalPrice <= 0) {
      candidate.warnings = uniqueWarnings([...candidate.warnings, "PRICE_UNVERIFIED"]);
      incrementReason(rejectionCounts, "PRICE_UNVERIFIED");
    }
    const category = candidate.category
      || resolvePublicProductCategory("", { title: finalName })
      || resolvePublicProductCategory("", { title: parsed.query })
      || "Em revisão";
    const status = reviewStatus(candidate);
    const reviewId = buildShopeeReviewId(acquiredLink, chatId);
    const imageCuration = buildImageCuration(candidate.imageUrl, candidate.qualification);
    const review: PendingReview = {
      id: reviewId,
      chatId,
      senderId: chatId,
      firstName: process.env.USER || "admin",
      username: process.env.USER || "admin",
      produto: finalName,
      rawTitle: finalName,
      displayTitle: finalName,
      curatorNote: candidate.warnings.length > 0
        ? `Busca manual entregue com ressalvas: ${candidate.warnings.join(", ")}`
        : "Busca manual sem ressalvas automáticas.",
      categoria: category,
      preco: Number.isFinite(finalPrice) && finalPrice > 0 ? finalPrice : 0,
      imagens: candidate.imageUrl ? [candidate.imageUrl] : [],
      imagensOriginais: candidate.imageUrl ? [candidate.imageUrl] : [],
      imagemPrincipal: candidate.imageUrl || undefined,
      imagensGaleria: [],
      imageEditorialStatus: status === "QUALIFIED" ? "clean" : "review_required",
      imageCuration,
      normalizedUrl: acquiredLink,
      descricao: "",
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + REVIEW_TTL_MS,
      existingProduct: {
        source: "affiliate_preview",
        affiliateUrl: acquisition.affiliateUrl || null,
        priceScaleVerified: Number.isFinite(finalPrice) && finalPrice > 0,
        shopId: candidate.shopId,
        itemId: candidate.itemId,
        visualReviewStatus: candidate.qualification.state,
        manualReviewStatus: status,
        manualReviewReasons: candidate.warnings,
        manualDeliveryContract: true,
      },
      promotionEvidence: null,
    };

    try {
      await saveReview(review);
    } catch {
      item.status = "review_persist_failed";
      item.reason = "REVIEW_PERSIST_FAILED";
      incrementReason(rejectionCounts, "REVIEW_PERSIST_FAILED");
      continue;
    }

    const cardText = buildCardText({
      rank: accepted + 1,
      requested: parsed.count,
      candidate,
      name: finalName,
      category,
      price: finalPrice,
      batchId: lotId,
      affiliateReady: Boolean(acquisition.affiliateUrl),
    });
    const sent = await sendCard({ chatId, imageUrl: candidate.imageUrl, text: cardText, reviewId, sendMessage, sendPhoto });
    item.reviewId = reviewId;
    if (!sent.ok) {
      item.status = "telegram_send_failed";
      item.reason = sent.reason || "TELEGRAM_SEND_FAILED";
      incrementReason(rejectionCounts, item.reason);
      continue;
    }
    item.status = status === "QUALIFIED" ? "ok" : "needs_human_review";
    item.reason = candidate.warnings.length > 0 ? candidate.warnings.join(" | ") : null;
    accepted += 1;
  }

  if (providerFailure) {
    const code = publicProviderCode(providerFailure);
    await sendMessage(chatId, `⚠️ <b>${code}</b>\n\n${providerMessage(code)} Os filtros editoriais não causaram a interrupção; houve falha real de provider.`).catch(() => undefined);
    return {
      lotId,
      correlationId,
      chatId,
      countRequested: parsed.count,
      processed: items.length,
      ok: accepted,
      failed: parsed.count - accepted,
      rejectedCandidates: hardRejectCount,
      candidatesExamined: qualifiedCandidates.length,
      candidatesReceived: discovered.received,
      hardRejectCount,
      needsHumanReviewCount: qualifiedCandidates.filter(candidate => candidate.warnings.length > 0).length,
      qualifiedCount,
      topCandidatesCount: accepted,
      rankingExecuted: ranked.length > 0,
      searchExhausted: discovered.sourceExhausted,
      poolLocalExhausted: accepted < parsed.count,
      sourceExhausted: discovered.sourceExhausted,
      budgetExhausted: discovered.calls >= MAX_SEARCH_CALLS && discovered.candidates.length < MAX_DISCOVERY_CANDIDATES,
      discoveryRounds: discovered.calls,
      poolCandidates: discovered.candidates.length,
      discoveryError: code,
      errorCode: code,
      providerQueryExecuted: true,
      rejectionCounts,
      items,
      chatTargetConfigured,
      affiliateClientAvailable,
    };
  }

  const errorCode: ShopeeCommandOutcomeCode | null = accepted < parsed.count ? "SHOPEE_CANDIDATES_REJECTED" : null;
  const topReasons = Object.entries(rejectionCounts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ") || "nenhuma";
  const title = errorCode ? "⚠️ <b>ENTREGA SHOPEE PARCIAL</b>" : "🏁 <b>LOTE SHOPEE ENTREGUE</b>";
  const shortfall = errorCode
    ? "\n\nFaltaram cards por pré-requisito técnico verificável (identidade/link afiliado/persistência/transporte), não porque filtros editoriais eliminaram os produtos."
    : "\n\nMesmo os itens com filtro reprovado foram mantidos disponíveis para sua decisão humana.";
  await sendMessage(
    chatId,
    `${title}\n\nSolicitados: <b>${parsed.count}</b>\nCandidatos oficiais recebidos: <b>${discovered.received}</b>\nCards enviados: <b>${accepted}</b>\nCandidatos com ressalvas: <b>${qualifiedCandidates.filter(candidate => candidate.warnings.length > 0).length}</b>\nSem ressalvas: <b>${qualifiedCount}</b>\nMotivos observados: <code>${escapeHtml(topReasons)}</code>${shortfall}`,
  ).catch(() => undefined);

  safeShopeeLog("shopee_manual_delivery_complete", {
    correlationId,
    requested: parsed.count,
    candidatesReceived: discovered.received,
    candidatesExamined: qualifiedCandidates.length,
    cardsSent: accepted,
    hardRejectCount,
    warningCandidates: qualifiedCandidates.filter(candidate => candidate.warnings.length > 0).length,
    errorCode,
  });

  return {
    lotId,
    correlationId,
    chatId,
    countRequested: parsed.count,
    processed: items.length,
    ok: accepted,
    failed: parsed.count - accepted,
    rejectedCandidates: hardRejectCount,
    candidatesExamined: qualifiedCandidates.length,
    candidatesReceived: discovered.received,
    hardRejectCount,
    needsHumanReviewCount: qualifiedCandidates.filter(candidate => candidate.warnings.length > 0).length,
    qualifiedCount,
    topCandidatesCount: accepted,
    rankingExecuted: ranked.length > 0,
    searchExhausted: discovered.sourceExhausted,
    poolLocalExhausted: accepted < parsed.count,
    sourceExhausted: discovered.sourceExhausted,
    budgetExhausted: discovered.calls >= MAX_SEARCH_CALLS && discovered.candidates.length < MAX_DISCOVERY_CANDIDATES,
    discoveryRounds: discovered.calls,
    poolCandidates: discovered.candidates.length,
    discoveryError: errorCode,
    errorCode,
    providerQueryExecuted: true,
    rejectionCounts,
    items,
    chatTargetConfigured,
    affiliateClientAvailable,
  };
}
