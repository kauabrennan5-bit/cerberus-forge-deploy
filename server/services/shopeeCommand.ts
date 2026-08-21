/**
 * N17 — FASE 25C — ORQUESTRADOR /shopee N (TELEGRAM)
 *
 * Comando operacional manual com aprovação humana obrigatória.
 *
 * FLUXO POR ITEM (idêntico ao preview-telegram validado na Fase 24):
 *   discovery — modo URL: extração oficial do padrão canônico ·
 *   modo termo: busca oficial Affiliate por palavra-chave; fallback DDG/Gemini
 *   → aquisição oficial (Affiliate API · acquireAffiliateLink · READ-ONLY)
 *   → enriquecimento pelo SCRAPER EXISTENTE (imagens + preço observacional)
 *   → verificação determinística de identidade (shopId + itemId)
 *   → PendingReview (Supabase · status=pending · TTL 24h)
 *   → card no Telegram (foto quando há imagem real · confirm_pub/cancel_rev)
 *
 * REGRAS DE SEGURANÇA (contrato desta fase):
 * - ZERO mutation de catálogo, N13, N14, N15, N16, N17 (estado), N18.
 * - A Affiliate API é a autoridade para shopId, itemId, productLink, affiliateUrl.
 * - Scraper som enriquece; identidade divergente → item fail-closed (sem card).
 * - Preço: escala NÃO verificada — nunca rotulado como moeda.
 * - Nenhuma credencial/valor sensível em logs ou cards (URLs de afiliado vão
 *   dentro de <code> apenas porque o usuário decide; tokens jamais).
 * - Falha do scraper NÃO cria fallback inventado: o item fica "incompleto"
 *   e NÃO recebe card (fail-closed por item; o lote continua por itens).
 * - Cap estrito: 1 ≤ N ≤ 10. Fora disso → rejeição com sintaxe, zero ação.
 * - Pausa de lote entre itens (respeito ao rate limit Shopee).
 */
import {
  createShopeeApiClient,
  type ShopeeApiClient,
} from "../commercial/affiliate/shopeeApiClient";
import { extractProductForReview, extractMarketplaceId } from "./productAutomation";
import { isShopeePromotionEvidenceFresh, type ShopeePromotionEvidence } from "./scraper";
import {
  sendTelegramMessage,
  sendTelegramPhoto,
} from "./telegramBot";
import {
  savePendingReview,
} from "../repositories/telegramRepository";
import type { PendingReview } from "./telegramBot";
import { discoverShopeeProducts } from "./shopeeDiscovery";

// ---------------------------------------------------------------
// Constantes do lote
// ---------------------------------------------------------------
const MIN_ITEMS = 1;
const MAX_ITEMS = 10;
const DISCOVERY_OVERFETCH_MULTIPLIER = 3;
const MAX_DISCOVERY_CANDIDATES = 30;
const MAX_DISCOVERY_ROUNDS = 3;
const MAX_GEMINI_CALLS = 3;

const LOT_PAUSE_MS = 3000; // pausa entre itens (respeito ao rate limit Shopee)
const REVIEW_TTL_MS = 24 * 60 * 60 * 1000; // 24h
let lotPauseMs = LOT_PAUSE_MS;

export function setTestShopeeLotPauseMs(milliseconds: number | null): void {
  lotPauseMs = milliseconds === null ? LOT_PAUSE_MS : Math.max(0, milliseconds);
}

/**
 * Sintaxe: /shopee N [termo]
 * - N obrigatório, inteiro, 1–10.
 * - termo opcional (default: "achados shopee" — busca ampla de mercado).
 */
export interface ParsedShopeeCommand {
  count: number;
  query: string;
  error: string | null;
  mode?: ShopeeDiscoveryMode;
  urls?: string[];
}

export interface ParsedShopeeCommandWithDiscovery extends ParsedShopeeCommand {
  mode: ShopeeDiscoveryMode;
  urls: string[];
}

export function parseShopeeCommand(argsRaw: string): ParsedShopeeCommand {
  const trimmed = argsRaw.trim();
  if (!trimmed) {
    return { count: 0, query: "", error: "sintaxe: /shopee N [termo] ou /shopee N <URL> [<URL>...] — N é obrigatório (1–10)" };
  }
  const parts = trimmed.split(/\s+/);
  const rawCount = parts[0];
  const count = Number.parseInt(rawCount, 10);
  if (!Number.isFinite(count) || count < MIN_ITEMS || count > MAX_ITEMS) {
    return {
      count: 0,
      query: "",
      error: `sintaxe: N deve ser inteiro entre ${MIN_ITEMS} e ${MAX_ITEMS} (recebido: "${rawCount}")`,
    };
  }
  const discovery = parseShopeeDiscovery(parts);
  // No modo URL, o "termo" registrado é a lista canônica (para o card do lote).
  const query = discovery.mode === "urls" ? discovery.urls.join(" · ") : discovery.query;
  return { count, query, error: null, mode: discovery.mode, urls: discovery.urls };
}

// ---------------------------------------------------------------
// Cliente oficial da Affiliate API (mesma lógica do preview-telegram)
// ---------------------------------------------------------------
// Override de teste (injetável via setTestShopeeClient) — só para suítes de teste.
let testClientOverride: ShopeeApiClient | null = null;

function buildShopeeClient(): ShopeeApiClient | null {
  if (testClientOverride) return testClientOverride;
  const appId = process.env.SHOPEE_APP_ID ?? process.env.SHOPEE_AFFILIATE_APP_ID;
  const appSecret =
    process.env.SHOPEE_APP_SECRET ?? process.env.SHOPEE_AFFILIATE_APP_SECRET;
  if (!appId || !appSecret) return null;
  return createShopeeApiClient({
    appId,
    secret: appSecret,
    baseUrl: process.env.SHOPEE_AFFILIATE_API_BASE_URL,
  });
}

/**
 * Hook de teste: substitui o cliente Affiliate usado pelo orquestrador.
 * Passar null restaura a construção a partir do ambiente.
 */
export function setTestShopeeClient(client: ShopeeApiClient | null): void {
  testClientOverride = client;
}

/**
 * Inspeção administrativa somente-leitura do schema oficial. O retorno contém
 * somente nomes de campos; jamais loga credenciais, URLs de oferta ou payloads.
 */
export async function inspectShopeePromotionFields(): Promise<{
  available: boolean;
  nodeType: string | null;
  fields: string[];
  reason: string | null;
}> {
  const client = buildShopeeClient();
  if (!client) return { available: false, nodeType: null, fields: [], reason: "credentials_not_configured" };
  const result = await client.inspectPromotionFields();
  return {
    available: result.ok,
    nodeType: result.nodeType,
    fields: result.fields,
    reason: result.reason,
  };
}

// ---------------------------------------------------------------
// Identificadores do item — extraídos da URL oficial (padrão /{loja}/{shop}/{item})
// ---------------------------------------------------------------
import { extractShopeeIdentity } from "../commercial/marketplace/shopeeIdentity";

function extractCanonicalShopeeIds(url: string): { shopId: string | null; itemId: string | null } {
  const identity = extractShopeeIdentity(url);
  if (identity.shopId && identity.itemId) {
    return identity;
  }
  
  // Fallback para compatibilidade com extrator de marketplace genérico
  const mktId = extractMarketplaceId(url);
  if (mktId && mktId.startsWith("shopee-")) {
    const parts = mktId.split("-");
    return { shopId: parts[1], itemId: parts[2] };
  }
  return { shopId: null, itemId: null };
}

// ---------------------------------------------------------------
// Modo de descoberta do lote: por termo (busca pública) ou por URLs diretas.
// ---------------------------------------------------------------
export type ShopeeDiscoveryMode = "term" | "urls";

function parseShopeeDiscovery(args: string[]): { mode: ShopeeDiscoveryMode; query: string; urls: string[] } {
  // Se todos os argumentos (a partir do 2º) forem URLs Shopee válidas, entra no modo direto.
  const rest = args.slice(1);
  const urlPattern = /^https?:\/\/shopee\.com\.br\/[\w\-./]*\/\d+\/\d+$/;
  const allUrls = rest.length > 0 && rest.every((a) => urlPattern.test(a.replace(/[#?].*$/, "").replace(/\/$/, "")));
  if (allUrls) {
    return { mode: "urls", query: "", urls: rest.map((a) => a.replace(/[#?].*$/, "").replace(/\/$/, "")) };
  }
  return { mode: "term", query: rest.join(" ").trim() || "achados shopee", urls: [] };
}

function discoveryQueryForRound(query: string, round: number): string {
  if (round === 1) return query;
  if (round === 2) return `${query} Shopee Brasil`;
  return `${query} produto Shopee`;
}

/** Converte resultados oficiais em URLs canônicas sem derivar links. */
async function searchOfficialShopeeOffers(params: {
  client: ShopeeApiClient;
  query: string;
  limit: number;
}): Promise<{ candidates: string[]; sourceResponded: boolean; error: string | null }> {
  try {
    const result = await params.client.searchOffers({ query: params.query, limit: params.limit });
    if (!result.ok) return { candidates: [], sourceResponded: false, error: result.reason ?? "official_search_failed" };
    const candidates = result.items.flatMap((item) => {
      if (!item.productLink || !item.shopId || !item.itemId) return [];
      const identity = extractCanonicalShopeeIds(item.productLink);
      if (identity.shopId !== item.shopId || identity.itemId !== item.itemId) return [];
      return [`https://shopee.com.br/product/${item.shopId}/${item.itemId}`];
    });
    return { candidates, sourceResponded: true, error: null };
  } catch {
    return { candidates: [], sourceResponded: false, error: "official_search_unexpected_error" };
  }
}

export function buildShopeeBatchId(): string {
  return `shopee-${Date.now().toString(36)}`;
}

export function buildShopeeReviewId(publicUrl: string, chatId: number): string {
  const key = `${publicUrl}|${chatId}`;
  let hash = 5381;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 33) ^ key.charCodeAt(i);
  }
  return `affprev-${Math.abs(hash >>> 0).toString(36)}-${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------
// Enriquecimento pelo scraper existente (idêntico ao contrato da Fase 24)
// ---------------------------------------------------------------
async function enrichWithExistingScraper(params: {
  productLink: string;
  officialShopId: string;
  officialItemId: string;
}): Promise<{
  ok: boolean;
  failureReason: string | null;
  images: string[];
  scraperPrice: number | null;
  scraperPriceMax: number | null;
  scraperCheckoutPrice: number | null;
  scraperCheckoutPriceCondition: "pix" | "pix_with_coupon" | null;
  promotionEvidence: ShopeePromotionEvidence | null;
  curatedTitle: string | null;
}> {
  try {
    const result = await extractProductForReview(params.productLink);
    if (!result.success || !result.data) {
      return {
        ok: false,
        failureReason: result.error ?? "scraper_extraction_failed",
        images: [],
        scraperPrice: null,
        scraperPriceMax: null,
        scraperCheckoutPrice: null,
        scraperCheckoutPriceCondition: null,
        promotionEvidence: null,
        curatedTitle: null,
      };
    }
    const data = result.data;
    const extracted = extractCanonicalShopeeIds(data.normalizedUrl);
    const identityMatches =
      extracted.shopId !== null &&
      extracted.itemId !== null &&
      extracted.shopId === params.officialShopId &&
      extracted.itemId === params.officialItemId;
    if (!identityMatches) {
      return { ok: false, failureReason: "scraper_identity_mismatch", images: [], scraperPrice: null, scraperPriceMax: null, scraperCheckoutPrice: null, scraperCheckoutPriceCondition: null, promotionEvidence: null, curatedTitle: null };
    }
    return {
      ok: true,
      failureReason: null,
      images: data.imagens ?? [],
      scraperPrice: data.preco ?? null,
      scraperPriceMax: data.precoMaximo ?? null,
      scraperCheckoutPrice: data.precoCheckout ?? null,
      scraperCheckoutPriceCondition: data.condicaoPrecoCheckout ?? null,
      promotionEvidence: data.evidenciaPromocional ?? null,
      curatedTitle: data.produto ?? null,
    };
  } catch {
    return { ok: false, failureReason: "scraper_unexpected_error", images: [], scraperPrice: null, scraperPriceMax: null, scraperCheckoutPrice: null, scraperCheckoutPriceCondition: null, promotionEvidence: null, curatedTitle: null };
  }
}

// ---------------------------------------------------------------
// Formatação de preço de fonte oficial brasileira ou de observação do anúncio.
// ---------------------------------------------------------------
function formatPreviewPrice(value: number | null): string | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

// ---------------------------------------------------------------
// Texto do card (contrato de proveniência da Fase 24)
// ---------------------------------------------------------------
function buildShopeeCardText(params: {
  name: string | null;
  price: number | null;
  priceMax: number | null;
  priceSource: "affiliate_api" | "scraper_observacional";
  checkoutPrice: number | null;
  checkoutPriceCondition: "pix" | "pix_with_coupon" | null;
  promotionEvidence: ShopeePromotionEvidence | null;
  productLink: string | null;
  affiliateUrl: string | null;
  shopId: string | null;
  itemId: string | null;
  status: string;
  imageUrl: string | null;
  imageCount: number;
  batchId: string;
}): string {
  const priceInfo = formatPreviewPrice(params.price);
  const priceSourceNote =
    params.priceSource === "scraper_observacional"
      ? " <i>(preço exibido no anúncio)</i>"
      : " <i>(Shopee Affiliate API)</i>";
  const priceRange = priceInfo && params.priceMax && params.priceMax > (params.price ?? 0)
    ? ` · <b>Faixa por variante:</b> ${priceInfo}–${formatPreviewPrice(params.priceMax)}`
    : "";
  const priceLine = priceInfo
    ? `💰 <b>Preço do anúncio:</b> ${priceInfo}${priceSourceNote}${priceRange}`
    : `⚠️ <b>Preço:</b> não retornado por nenhuma das fontes`;
  const promotionFresh = isShopeePromotionEvidenceFresh(params.promotionEvidence);
  const checkoutPriceInfo = formatPreviewPrice(promotionFresh ? params.promotionEvidence?.checkoutPrice ?? null : params.checkoutPrice);
  const checkoutCondition = promotionFresh ? params.promotionEvidence?.checkoutPriceCondition ?? null : params.checkoutPriceCondition;
  const checkoutLine = checkoutCondition === "pix_with_coupon"
    ? checkoutPriceInfo
      ? `🏷️ <b>Preço no Pix com cupom:</b> ${checkoutPriceInfo}\n<i>Condição exibida no anúncio; cupom e elegibilidade devem ser confirmados no checkout.</i>`
      : `🏷️ <b>Condição observada:</b> desconto no Pix com cupom pode estar disponível no checkout.\n<i>Não foi calculado nem prometido nenhum valor.</i>`
    : checkoutCondition === "pix"
      ? checkoutPriceInfo
        ? `🏷️ <b>Preço no Pix:</b> ${checkoutPriceInfo}\n<i>Condição exibida no anúncio; confirme a elegibilidade no checkout.</i>`
        : `🏷️ <b>Condição observada:</b> desconto no Pix pode estar disponível no checkout.\n<i>Não foi calculado nem prometido nenhum valor.</i>`
      : `ℹ️ <i>Pix, cupons, frete e elegibilidade podem alterar o total no checkout; este card não estima descontos.</i>`;
  const coupon = promotionFresh ? params.promotionEvidence?.coupon ?? null : null;
  const couponLine = coupon
    ? `🎟️ <b>Cupom observado:</b> ${formatPreviewPrice(coupon.amount)} OFF${coupon.minimumSpend ? ` acima de ${formatPreviewPrice(coupon.minimumSpend)}` : ""}\n<i>Regra exibida no anúncio; disponibilidade, conta e validade devem ser confirmadas no checkout.</i>`
    : "";
  const evidenceLine = promotionFresh
    ? `⏱️ <i>Condições promocionais observadas neste preview; podem mudar após ${new Date(params.promotionEvidence!.expiresAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" })}.</i>`
    : "";
  const affiliateLine = params.affiliateUrl
    ? `<b>Link de afiliado:</b> <code>${params.affiliateUrl}</code>`
    : `<b>Link de afiliado:</b> <i>não elegível (fonte oficial não retornou offerLink)</i>`;
  const imageLine = params.imageUrl
    ? `🖼️ <b>Imagem:</b> ${params.imageCount} imagem(ns) oficial(is) observadas no anúncio (scraper · proveniência do anúncio original)`
    : `🖼️ <b>Imagem:</b> não observada pelo scraper (nenhuma imagem real foi inventada)`;
  const identityLine = `🔎 <b>Auditoria:</b> shop_id=<code>${params.shopId ?? "?"}</code> · item_id=<code>${params.itemId ?? "?"}</code> · status=<code>${params.status}</code>`;
  const batchLine = `<b>Lote:</b> <code>${params.batchId}</code> · decisão independente por card`;
  return (
    `🛡️ <b>CERBERUS FINDS — PREVIEW SHOPEE AFFILIATE</b>\n\n` +
    `🏷️ <b>Produto:</b> ${params.name ?? "<i>sem nome retornado</i>"}\n` +
    priceLine + `\n` +
    checkoutLine + `\n` +
    (couponLine ? couponLine + `\n` : "") +
    (evidenceLine ? evidenceLine + `\n` : "") +
    `🔗 <b>URL original:</b> <code>${params.productLink ?? "?"}</code>\n` +
    `${affiliateLine}\n` +
    `${imageLine}\n` +
    `${identityLine}\n` +
    `${batchLine}\n\n` +
    `<i>Affiliate API oficial · preview de decisão manual — nada é publicado ou adquirido além do link oficial retornado pela consulta.</i>`
  );
}

function buildPreviewKeyboard(reviewId: string) {
  return {
    inline_keyboard: [
      // PUBLICAR é uma aprovação humana explícita. O callback canônico executa
      // o lifecycle de publicação e só confirma sucesso após Supabase, sync e
      // validação da vitrine pública.
      [{ text: "✅ PUBLICAR", callback_data: `confirm_pub:${reviewId}` }],
      [{ text: "🏷️ AJUSTAR PROMOÇÃO", callback_data: `promo_edit:${reviewId}` }],
      [{ text: "❌ DESCARTAR", callback_data: `cancel_rev:${reviewId}` }],
    ],
  };
}

async function sendShopeeCard(params: {
  chatId: number;
  text: string;
  keyboard: ReturnType<typeof buildPreviewKeyboard>;
  imageUrl?: string | null;
}): Promise<{ cardAsPhoto: boolean; ok: boolean; reason?: string }> {
  let cardAsPhoto = false;
  let photoFailureReason: string | undefined;
  if (params.imageUrl) {
    try {
      const photoDelivery = await sendTelegramPhoto(params.chatId, params.imageUrl, params.text, params.keyboard);
      if (photoDelivery.ok === true) {
        cardAsPhoto = true;
        return { cardAsPhoto, ok: true };
      }
      photoFailureReason = photoDelivery.failureReason ?? "telegram_photo_failed";
    } catch {
      photoFailureReason = "telegram_photo_transport_error";
    }
  }
  try {
    const textDelivery = await sendTelegramMessage(params.chatId, params.text, params.keyboard);
    if (textDelivery.ok === true) return { cardAsPhoto, ok: true };
    return { cardAsPhoto, ok: false, reason: textDelivery.failureReason ?? photoFailureReason ?? "telegram_send_failed" };
  } catch (err) {
    return { cardAsPhoto, ok: false, reason: photoFailureReason ?? (err instanceof Error ? "telegram_text_transport_error" : "telegram_send_failed") };
  }
}

function logShopeeCandidateResult(params: {
  lotId: string;
  candidateIndex: number;
  discoveryRound: number;
  stage: "discovery" | "affiliate" | "scraper" | "review" | "telegram";
  outcome: "found" | "accepted" | "rejected";
  reason: string;
}): void {
  console.info(
    `[SHOPEE LOT] lot=${params.lotId} candidate=${params.candidateIndex} discovery_round=${params.discoveryRound} stage=${params.stage} outcome=${params.outcome} reason=${params.reason}`,
  );
}

// ---------------------------------------------------------------
// Orquestrador
// ---------------------------------------------------------------
export interface ShopeeLotItemResult {
  position: number;
  candidateIndex: number;
  discoveryRound: number;
  status:
    | "ok"
    | "discovery_failed"
    | "affiliate_not_eligible"
    | "scraper_enrichment_failed"
    | "telegram_send_failed"
    | "review_persist_failed";
  publicUrl: string | null;
  shopId: string | null;
  itemId: string | null;
  reviewId: string | null;
  imageCount: number;
  reason: string | null;
}

export interface ShopeeLotResult {
  lotId: string;
  chatId: number;
  countRequested: number;
  processed: number;
  ok: number;
  failed: number;
  rejectedCandidates?: number;
  candidatesExamined: number;
  searchExhausted: boolean;
  poolLocalExhausted: boolean;
  sourceExhausted: boolean;
  budgetExhausted: boolean;
  discoveryRounds: number;
  poolCandidates: number;
  discoveryError: string | null;
  items: ShopeeLotItemResult[];
  chatTargetConfigured: boolean;
  affiliateClientAvailable: boolean;
}

/**
 * Executa o lote /shopee N com fail-closed POR ITEM e relatório final.
 * Nenhum item falho cria dado inventado; um item falho não derruba o lote.
 */
export async function runShopeeCommand(argsRaw: string): Promise<ShopeeLotResult> {
  const parsed = parseShopeeCommand(argsRaw);
  if (parsed.error) {
    return {
      lotId: "",
      chatId: 0,
      countRequested: parsed.count,
      processed: 0,
      ok: 0,
      failed: 0,
      candidatesExamined: 0,
      searchExhausted: false,
      poolLocalExhausted: false,
      sourceExhausted: false,
      budgetExhausted: false,
      discoveryRounds: 0,
      poolCandidates: 0,
      discoveryError: null,
      items: [],
      chatTargetConfigured: false,
      affiliateClientAvailable: false,
    };
  }
  const discoveryMode: ShopeeDiscoveryMode = parsed.mode ?? "term";
  let directUrls: string[] = parsed.urls ?? [];
  const candidateTarget = Math.min(
    MAX_DISCOVERY_CANDIDATES,
    Math.max(parsed.count, parsed.count * DISCOVERY_OVERFETCH_MULTIPLIER),
  );

  const chatId = Number(
    (process.env.TELEGRAM_ALLOWED_USER_IDS?.split(",")[0] ?? "").trim() || "0",
  );

  let discoveryError: string | null = null;
  const chatTargetConfigured = chatId > 0;
  const client = buildShopeeClient();
  const affiliateClientAvailable = client !== null;

  const lotId = buildShopeeBatchId();
  const items: ShopeeLotItemResult[] = [];

  if (!chatTargetConfigured) {
    return {
      lotId,
      chatId,
      countRequested: parsed.count,
      processed: 0,
      ok: 0,
      failed: parsed.count,
      candidatesExamined: 0,
      searchExhausted: false,
      poolLocalExhausted: false,
      sourceExhausted: false,
      budgetExhausted: false,
      discoveryRounds: 0,
      poolCandidates: directUrls.length,
      discoveryError,
      items: Array.from({ length: parsed.count }, (_, i) => ({
        position: i + 1,
        candidateIndex: i + 1,
        discoveryRound: 0,
        status: "telegram_send_failed",
        publicUrl: null,
        shopId: null,
        itemId: null,
        reviewId: null,
        imageCount: 0,
        reason: "TELEGRAM_ALLOWED_USER_IDS ausente — nenhum card enviado",
      })),
      chatTargetConfigured,
      affiliateClientAvailable,
    };
  }

  if (!client) {
    if (chatId) {
      await sendTelegramMessage(
        chatId,
        "⚠️ <b>/shopee indisponível</b>\n\nCredenciais oficiais da Affiliate API ausentes no ambiente. Nenhuma consulta foi executada.",
      ).catch(() => undefined);
    }
    return {
      lotId,
      chatId,
      countRequested: parsed.count,
      processed: 0,
      ok: 0,
      failed: parsed.count,
      candidatesExamined: 0,
      searchExhausted: false,
      poolLocalExhausted: false,
      sourceExhausted: false,
      budgetExhausted: false,
      discoveryRounds: 0,
      poolCandidates: directUrls.length,
      discoveryError,
      items: Array.from({ length: parsed.count }, (_, i) => ({
        position: i + 1,
        candidateIndex: i + 1,
        discoveryRound: 0,
        status: "discovery_failed",
        publicUrl: null,
        shopId: null,
        itemId: null,
        reviewId: null,
        imageCount: 0,
        reason: "affiliate_auth_unavailable",
      })),
      chatTargetConfigured,
      affiliateClientAvailable,
    };
  }

  // Card inicial do lote
  if (chatId) {
    const sourceLine =
      discoveryMode === "urls"
        ? `📦 Solicitados: <b>${parsed.count}</b> · Modo: URL direta · <code>${directUrls.length}</code> URL(s)`
        : `📦 Solicitados: <b>${parsed.count}</b> · Termo: "${parsed.query}"`;
    await sendTelegramMessage(
      chatId,
      `🛒 <b>LOTE SHOPEE INICIADO</b>\n\n` + `🆔 Lote: <code>${lotId}</code>\n` + sourceLine + `\n\n` + `<i>Cada item passa por: descoberta oficial → link de afiliado → scraper → auditoria de identidade → card. Falhas são reportadas por item, sem inventar dados.</i>`,
    ).catch(() => undefined);
  }

  const seenCandidates = new Set<string>();
  const discoveryKeyForUrl = (url: string): string => {
    const identity = extractCanonicalShopeeIds(url);
    return identity.shopId && identity.itemId ? `${identity.shopId}:${identity.itemId}` : url;
  };
  const seenDiscoveryKeys = new Set<string>(directUrls.map(discoveryKeyForUrl));
  const candidateRounds = directUrls.map(() => 0);
  let candidateCursor = 0;
  let acceptedCount = 0;
  let discoveryRounds = 0;
  let geminiCalls = 0;
  let poolLocalExhausted = false;
  let sourceExhausted = false;
  let budgetExhausted = false;

  const runNextDiscoveryRound = async (): Promise<number> => {
    if (discoveryMode !== "term") return 0;
    if (
      discoveryRounds >= MAX_DISCOVERY_ROUNDS ||
      geminiCalls >= MAX_GEMINI_CALLS ||
      directUrls.length >= MAX_DISCOVERY_CANDIDATES
    ) {
      budgetExhausted = true;
      return 0;
    }
    const round = discoveryRounds + 1;
    discoveryRounds = round;
    const roundQuery = discoveryQueryForRound(parsed.query, round);
    const remainingCapacity = Math.min(candidateTarget, MAX_DISCOVERY_CANDIDATES - directUrls.length);
    const official = await searchOfficialShopeeOffers({ client, query: roundQuery, limit: remainingCapacity });
    if (official.candidates.length === 0) {
      console.info(
        `[SHOPEE LOT] lot=${lotId} discovery_round=${round} stage=official_search outcome=${official.sourceResponded ? "empty" : "unavailable"} reason=${official.error ?? "no_candidates"}`,
      );
    }
    const discoveredUrls = [...official.candidates];
    let externalDiscoveryUsed = false;
    if (discoveredUrls.length === 0) {
      if (geminiCalls >= MAX_GEMINI_CALLS) {
        budgetExhausted = true;
        discoveryError = official.error ?? "external_discovery_budget_exhausted";
        return 0;
      }
      geminiCalls += 1;
      externalDiscoveryUsed = true;
      const discovery = await discoverShopeeProducts(roundQuery, remainingCapacity);
      if (!discovery.success) {
        discoveryError = discovery.error || official.error || "discovery_round_failed";
        if (/quota|auth|credential/i.test(discoveryError)) budgetExhausted = true;
        return 0;
      }
      discoveredUrls.push(...discovery.products.map((product) => product.url));
      if (official.sourceResponded && discovery.products.length === 0) sourceExhausted = true;
    }
    let added = 0;
    for (const url of discoveredUrls) {
      const discoveryKey = url ? discoveryKeyForUrl(url) : "";
      if (!url || !discoveryKey || seenDiscoveryKeys.has(discoveryKey)) continue;
      seenDiscoveryKeys.add(discoveryKey);
      directUrls.push(url);
      candidateRounds.push(round);
      added += 1;
      if (directUrls.length >= MAX_DISCOVERY_CANDIDATES) {
        budgetExhausted = true;
        break;
      }
      logShopeeCandidateResult({
        lotId,
        candidateIndex: directUrls.length,
        discoveryRound: round,
        stage: "discovery",
        outcome: "found",
        reason: externalDiscoveryUsed ? "external_candidate_added" : "official_affiliate_candidate_added",
      });
    }
    if (added > 0) poolLocalExhausted = false;
    return added;
  };

  while (acceptedCount < parsed.count) {
    if (candidateCursor >= directUrls.length) {
      poolLocalExhausted = true;
      if (discoveryMode === "urls") {
        sourceExhausted = true;
        break;
      }
      if (
        discoveryRounds >= MAX_DISCOVERY_ROUNDS ||
        geminiCalls >= MAX_GEMINI_CALLS ||
        directUrls.length >= MAX_DISCOVERY_CANDIDATES
      ) {
        budgetExhausted = true;
        break;
      }
      await runNextDiscoveryRound();
      if (candidateCursor >= directUrls.length && budgetExhausted) break;
      continue;
    }
    if (candidateCursor > 0 && lotPauseMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, lotPauseMs));
    }
    const candidateIndex = candidateCursor + 1;
    const url = directUrls[candidateCursor++] ?? null;
    const discoveryRound = candidateRounds[candidateIndex - 1] ?? 0;
    const identity = url ? extractCanonicalShopeeIds(url) : { shopId: null, itemId: null };
    const candidateKey = identity.shopId && identity.itemId ? `${identity.shopId}:${identity.itemId}` : url ?? `missing:${candidateIndex}`;
    const item: ShopeeLotItemResult = {
      position: candidateIndex,
      candidateIndex,
      discoveryRound,
      status: "ok",
      publicUrl: url,
      shopId: identity.shopId,
      itemId: identity.itemId,
      reviewId: null,
      imageCount: 0,
      reason: null,
    };
    items.push(item);

    if (seenCandidates.has(candidateKey)) {
      item.status = "discovery_failed";
      item.reason = "duplicate_candidate";
      logShopeeCandidateResult({ lotId, candidateIndex, discoveryRound, stage: "discovery", outcome: "rejected", reason: item.reason });
      continue;
    }
    seenCandidates.add(candidateKey);
    if (!url || !item.shopId || !item.itemId) {
      item.status = "discovery_failed";
      item.reason = "identifiers_not_extractable_from_url";
      logShopeeCandidateResult({ lotId, candidateIndex, discoveryRound, stage: "discovery", outcome: "rejected", reason: item.reason });
      continue;
    }

    let acquisition;
    try {
      acquisition = await client.acquireAffiliateLink({ shopId: item.shopId, itemId: item.itemId });
    } catch (err) {
      acquisition = null;
      item.status = "affiliate_not_eligible";
      item.reason = "affiliate_request_error";
      logShopeeCandidateResult({ lotId, candidateIndex, discoveryRound, stage: "affiliate", outcome: "rejected", reason: item.reason });
      continue;
    }
    if (!acquisition || acquisition.status !== "link_acquired") {
      item.status = "affiliate_not_eligible";
      item.reason = acquisition?.status ?? "not_eligible";
      logShopeeCandidateResult({ lotId, candidateIndex, discoveryRound, stage: "affiliate", outcome: "rejected", reason: item.reason });
      continue;
    }

    // 3+4. Scraper + identidade
    const enriched = await enrichWithExistingScraper({
      productLink: acquisition.productLink,
      officialShopId: acquisition.shopId,
      officialItemId: acquisition.itemId,
    });
    if (!enriched.ok) {
      item.status = "scraper_enrichment_failed";
      item.reason = enriched.failureReason;
      logShopeeCandidateResult({ lotId, candidateIndex, discoveryRound, stage: "scraper", outcome: "rejected", reason: item.reason ?? "scraper_failed" });
      continue;
    }

    // 5. PendingReview — contrato REAL de PendingReview (telegramBot.ts):
    // id/chatId/senderId/firstName/username/produto/categoria/preco/imagens/
    // normalizedUrl/descricao/status/expiresAt/existingProduct. Espelha
    // persistPreviewReview do preview-telegram validado na Fase 24.
    const reviewId = buildShopeeReviewId(item.publicUrl, chatId);
    const hasScrapedPrice =
      enriched.scraperPrice !== null &&
      Number.isFinite(enriched.scraperPrice) &&
      enriched.scraperPrice > 0;
    const hasOfficialPrice =
      acquisition.price !== null &&
      Number.isFinite(acquisition.price) &&
      acquisition.price > 0;
    // Prioridade: preço exibido no anúncio; se a página SSR não expuser preço,
    // preservar o preço atual do mesmo item retornado pela Affiliate API oficial.
    const displayPrice = hasScrapedPrice
      ? enriched.scraperPrice
      : hasOfficialPrice
        ? acquisition.price
        : 0;
    const provenanceNote = hasScrapedPrice
      ? "preço exibido no anúncio (scraper_observacional)"
      : hasOfficialPrice
        ? "preço atual retornado pela Shopee Affiliate API"
        : "preço não retornado por nenhuma fonte";
    const review: PendingReview = {
      id: reviewId,
      chatId,
      senderId: chatId,
      firstName: process.env.USER ?? "admin",
      username: process.env.USER ?? "admin",
      produto: enriched.curatedTitle ?? acquisition.name ?? `item ${item.itemId}`,
      categoria: "affiliate_preview",
      preco: displayPrice,
      imagens: enriched.images,
      normalizedUrl: acquisition.productLink ?? item.publicUrl,
      descricao: [
        `affiliate_preview · source=/shopee · batch=${lotId} · candidate=${candidateIndex}`,
        `link oficial retornado pela Affiliate API: ${acquisition.affiliateUrl}`,
        `enriquecimento scraper: ${enriched.images.length} imagem(ns)${hasScrapedPrice ? ", preço observacional presente" : ""} · ${provenanceNote}`,
        `auditoria identidade: shop_id=${item.shopId} item_id=${item.itemId}`,
      ].join(" · "),
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + REVIEW_TTL_MS,
      existingProduct: {
        source: "affiliate_preview",
        affiliateUrl: acquisition.affiliateUrl,
        priceScaleVerified: false,
        shopId: item.shopId,
        itemId: item.itemId,
      },
      promotionEvidence: enriched.promotionEvidence,
    };
    try {
      await savePendingReview(review);
    } catch (err) {
      item.status = "review_persist_failed";
      item.reason = "persist_failed";
      logShopeeCandidateResult({ lotId, candidateIndex, discoveryRound, stage: "review", outcome: "rejected", reason: item.reason });
      continue;
    }

    // 6. Card no Telegram
    const text = buildShopeeCardText({
      name: enriched.curatedTitle ?? acquisition.name ?? null,
      price: hasScrapedPrice ? enriched.scraperPrice : hasOfficialPrice ? acquisition.price : null,
      priceMax: hasScrapedPrice ? enriched.scraperPriceMax : null,
      priceSource: hasScrapedPrice ? "scraper_observacional" : "affiliate_api",
      checkoutPrice: enriched.scraperCheckoutPrice,
      checkoutPriceCondition: enriched.scraperCheckoutPriceCondition,
      promotionEvidence: enriched.promotionEvidence,
      productLink: acquisition.productLink,
      affiliateUrl: acquisition.affiliateUrl,
      shopId: acquisition.shopId,
      itemId: acquisition.itemId,
      status: acquisition.status,
      imageUrl: enriched.images[0] ?? null,
      imageCount: enriched.images.length,
      batchId: lotId,
    });
    const sent = await sendShopeeCard({
      chatId,
      text,
      keyboard: buildPreviewKeyboard(reviewId),
      imageUrl: enriched.images[0] ?? null,
    });
    item.reviewId = reviewId;
    item.imageCount = enriched.images.length;
    item.status = sent.ok ? "ok" : "telegram_send_failed";
    if (!sent.ok) {
      item.reason = sent.reason ?? "send_failed";
      logShopeeCandidateResult({ lotId, candidateIndex, discoveryRound, stage: "telegram", outcome: "rejected", reason: item.reason });
      continue;
    }
    acceptedCount += 1;
    logShopeeCandidateResult({ lotId, candidateIndex, discoveryRound, stage: "telegram", outcome: "accepted", reason: "send_success" });
  }

  const okCount = acceptedCount;
  const searchExhausted = poolLocalExhausted;

  // Card final do lote
  if (chatId) {
    await sendTelegramMessage(
      chatId,
      `🏁 <b>LOTE CONCLUÍDO</b>\n\n` +
        `🆔 Lote: <code>${lotId}</code>\n` +
        `✅ Enviados como card: <b>${okCount}</b> de <b>${parsed.count}</b>\n` +
        `❌ Candidatos rejeitados (fail-closed, nada inventado): <b>${items.length - okCount}</b>\n` +
        `🔎 Candidatos avaliados: <b>${items.length}</b> · pool: <b>${directUrls.length}</b> · rounds: <b>${discoveryRounds}</b>\n` +
        `${poolLocalExhausted ? "⚠️ Pool local esgotado." : "✅ Meta atingida antes de esgotar o pool."}${budgetExhausted ? " Orçamento de discovery esgotado." : ""}${sourceExhausted ? " Fonte explícita de URLs esgotada." : ""}\n\n` +
        `Cada card tem decisão independente: ✅ PUBLICAR inicia a publicação canônica após aprovação humana · ❌ DESCARTAR cancela.\n` +
        `<i>Nenhuma publicação é executada antes do clique explícito em PUBLICAR.</i>`,
    ).catch(() => undefined);
  }

  return {
    lotId,
    chatId,
    countRequested: parsed.count,
    processed: items.length,
    ok: okCount,
    failed: parsed.count - okCount,
    rejectedCandidates: items.length - okCount,
    candidatesExamined: items.length,
    searchExhausted,
    poolLocalExhausted,
    sourceExhausted,
    budgetExhausted,
    discoveryRounds,
    poolCandidates: directUrls.length,
    discoveryError,
    items,
    chatTargetConfigured,
    affiliateClientAvailable,
  };
}
