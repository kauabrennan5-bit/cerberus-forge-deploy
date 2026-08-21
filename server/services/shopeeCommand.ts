/**
 * N17 — FASE 25C — ORQUESTRADOR /shopee N (TELEGRAM)
 *
 * Comando operacional manual com aprovação humana obrigatória.
 *
 * FLUXO POR ITEM (idêntico ao preview-telegram validado na Fase 24):
 *   discovery — modo URL: extração oficial do padrão canônico ·
 *   modo termo (Fase 26): DuckDuckGo HTML + Gemini 3.6 Flash (normalização)
 *   → aquisição oficial (Affiliate API · acquireAffiliateLink · READ-ONLY)
 *   → enriquecimento pelo SCRAPER EXISTENTE (imagens + preço observacional)
 *   → verificação determinística de identidade (shopId + itemId)
 *   → PendingReview (Supabase · status=pending · TTL 24h)
 *   → card no Telegram (foto quando há imagem real · approve_only/cancel_rev)
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
import { extractProductForReview } from "./productAutomation";
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

const LOT_PAUSE_MS = 3000; // pausa entre itens (respeito ao rate limit Shopee)
const REVIEW_TTL_MS = 24 * 60 * 60 * 1000; // 24h

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

// ---------------------------------------------------------------
// Identificadores do item — extraídos da URL oficial (padrão /{loja}/{shop}/{item})
// ---------------------------------------------------------------
function extractCanonicalShopeeIds(url: string): { shopId: string | null; itemId: string | null } {
  const pattern = /\/(\d+)\/(\d+)\/?$/;
  const match = pattern.exec(url.replace(/[#?].*$/, "").replace(/\/$/, ""));
  if (!match) return { shopId: null, itemId: null };
  return { shopId: match[1], itemId: match[2] };
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
      return { ok: false, failureReason: "scraper_identity_mismatch", images: [], scraperPrice: null, curatedTitle: null };
    }
    return {
      ok: true,
      failureReason: null,
      images: data.imagens ?? [],
      scraperPrice: data.preco ?? null,
      curatedTitle: data.produto ?? null,
    };
  } catch {
    return { ok: false, failureReason: "scraper_unexpected_error", images: [], scraperPrice: null, curatedTitle: null };
  }
}

// ---------------------------------------------------------------
// Formatação do preço com escala NÃO verificada
// ---------------------------------------------------------------
function formatPreviewPrice(value: number | null): string | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2).replace(".", ",");
}

// ---------------------------------------------------------------
// Texto do card (contrato de proveniência da Fase 24)
// ---------------------------------------------------------------
function buildShopeeCardText(params: {
  name: string | null;
  price: number | null;
  priceSource: "affiliate_api" | "scraper_observacional";
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
      ? " (observacional — escala não verificada — não tratar como moeda)"
      : " (escala não verificada — não tratar como moeda)";
  const priceLine = priceInfo
    ? `💰 <b>Preço:</b> ${priceInfo}<i>${priceSourceNote}</i>`
    : `⚠️ <b>Preço:</b> não retornado por nenhuma das fontes`;
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
      [{ text: "✅ PUBLICAR", callback_data: `approve_only:${reviewId}` }],
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
  if (params.imageUrl) {
    try {
      await sendTelegramPhoto(params.chatId, params.imageUrl, params.text, params.keyboard);
      cardAsPhoto = true;
      return { cardAsPhoto, ok: true };
    } catch {
      cardAsPhoto = false;
    }
  }
  try {
    await sendTelegramMessage(params.chatId, params.text, params.keyboard);
    return { cardAsPhoto, ok: true };
  } catch (err) {
    return { cardAsPhoto, ok: false, reason: err instanceof Error ? err.message : "telegram_send_failed" };
  }
}

// ---------------------------------------------------------------
// Orquestrador
// ---------------------------------------------------------------
export interface ShopeeLotItemResult {
  position: number;
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
      items: [],
      chatTargetConfigured: false,
      affiliateClientAvailable: false,
    };
  }
  const discoveryMode: ShopeeDiscoveryMode = parsed.mode ?? "term";
  let directUrls: string[] = parsed.urls ?? [];

  const chatId = Number(
    (process.env.TELEGRAM_ALLOWED_USER_IDS?.split(",")[0] ?? "").trim() || "0",
  );

  // FASE 26: Se o modo for 'term', usamos o Gemini Search Grounding para obter URLs
  let discoveryError: string | null = null;
  if (discoveryMode === "term") {
    const discovery = await discoverShopeeProducts(parsed.query, parsed.count);
    if (discovery.success && discovery.products.length > 0) {
      directUrls = discovery.products.map(p => p.url);
    } else {
      discoveryError = discovery.error || "no_products_found";
    }
  }
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
      items: Array.from({ length: parsed.count }, (_, i) => ({
        position: i + 1,
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
      items: Array.from({ length: parsed.count }, (_, i) => ({
        position: i + 1,
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

  for (let position = 1; position <= parsed.count; position += 1) {
    if (position > 1) await new Promise((resolve) => setTimeout(resolve, LOT_PAUSE_MS));

    // 1. Discovery (Fase 26: Gemini Search Grounding ou URL Direta)
    if (discoveryMode === "urls" || discoveryMode === "term") {
      const url = directUrls[position - 1] ?? null;
      if (!url) {
        if (discoveryMode === "urls") {
          items.push({
            position,
            status: "discovery_failed",
            publicUrl: null,
            shopId: null,
            itemId: null,
            reviewId: null,
            imageCount: 0,
            reason: "url_missing_for_position",
          });
          if (chatId) {
            await sendTelegramMessage(
              chatId,
              `⚠️ <b>Descoberta indisponível</b> (motivo: <code>url_missing_for_position</code>) — lote fechado sem inventar dados. Envie uma URL por item: <code>/shopee N URL1 [URL2 ...]</code>.`,
            ).catch(() => undefined);
          }
          break;
        } else {
          // No modo termo, se não houver mais URLs retornadas pelo Gemini
          if (discoveryError) {
            while (items.length < parsed.count) {
              items.push({
                position: items.length + 1,
                status: "discovery_failed",
                publicUrl: null,
                shopId: null,
                itemId: null,
                reviewId: null,
                imageCount: 0,
                reason: discoveryError,
              });
            }
            if (chatId) {
              await sendTelegramMessage(
                chatId,
                `⚠️ <b>Descoberta indisponível</b> (motivo: <code>${discoveryError}</code>) — lote fechado sem inventar dados.`,
              ).catch(() => undefined);
            }
            break;
          }
          continue;
        }
      } else {
        const identity = extractCanonicalShopeeIds(url);
        if (!identity.shopId || !identity.itemId) {
          items.push({
            position,
            status: "discovery_failed",
            publicUrl: url,
            shopId: null,
            itemId: null,
            reviewId: null,
            imageCount: 0,
            reason: "identifiers_not_extractable_from_url",
          });
          if (chatId) {
            await sendTelegramMessage(
              chatId,
              `❌ <b>Item ${position}</b> falhou na descoberta: identificadores não extraíveis da URL — nenhum card enviado.`,
            ).catch(() => undefined);
          }
        } else {
          items.push({
            position,
            status: "ok",
            publicUrl: url,
            shopId: identity.shopId,
            itemId: identity.itemId,
            reviewId: null,
            imageCount: 0,
            reason: null,
          });
        }
      }
    }
    // 2. Aquisição oficial + 3. Scraper + 4. Identidade + 5. Review + 6. Card
    const item = items[position - 1];
    if (!item) continue;
    if (!item.publicUrl || !item.shopId || !item.itemId) {
      item.status = "discovery_failed";
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `❌ <b>Item ${item.position}</b> falhou na descoberta: ${item.reason ?? "indisponível"} — nenhum card enviado.`,
        ).catch(() => undefined);
      }
      continue;
    }

    let acquisition;
    try {
      acquisition = await client.acquireAffiliateLink({ shopId: item.shopId, itemId: item.itemId });
    } catch (err) {
      acquisition = null;
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `❌ <b>Item ${item.position}</b> falhou na fonte oficial: ${err instanceof Error ? err.message : "unknown"} — nenhum card enviado.`,
        ).catch(() => undefined);
      }
      item.status = "affiliate_not_eligible";
      item.reason = err instanceof Error ? err.message : "unknown";
      continue;
    }
    if (!acquisition || acquisition.status !== "link_acquired") {
      item.status = "affiliate_not_eligible";
      item.reason = acquisition?.status ?? "not_eligible";
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `❌ <b>Item ${item.position}</b> não elegível na fonte oficial (status: <code>${item.reason}</code>) — nenhum card enviado.`,
        ).catch(() => undefined);
      }
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
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `❌ <b>Item ${item.position}</b> falhou no enriquecimento (scraper: <code>${enriched.failureReason}</code>) — nenhum card enviado (fail-closed).`,
        ).catch(() => undefined);
      }
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
    const displayPrice = hasScrapedPrice ? enriched.scraperPrice : 0;
    const provenanceNote = hasScrapedPrice
      ? "preço exibido observacional (scraper_observacional) · escala não verificada"
      : "preço com escala não verificada";
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
        `affiliate_preview · source=/shopee · batch=${lotId} · position=${position}`,
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
    };
    try {
      await savePendingReview(review);
    } catch (err) {
      item.status = "review_persist_failed";
      item.reason = err instanceof Error ? err.message : "persist_failed";
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          `❌ <b>Item ${item.position}</b> falhou ao registrar a decisão pendente — nenhuma publicação foi executada.`,
        ).catch(() => undefined);
      }
      continue;
    }

    // 6. Card no Telegram
    const text = buildShopeeCardText({
      name: enriched.curatedTitle ?? acquisition.name ?? null,
      price: enriched.scraperPrice ?? null,
      priceSource: enriched.scraperPrice !== null ? "scraper_observacional" : "affiliate_api",
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
    if (!sent.ok) item.reason = sent.reason ?? "send_failed";
  }

  const okCount = items.filter((i) => i.status === "ok").length;

  // Card final do lote
  if (chatId) {
    await sendTelegramMessage(
      chatId,
      `🏁 <b>LOTE CONCLUÍDO</b>\n\n` +
        `🆔 Lote: <code>${lotId}</code>\n` +
        `✅ Enviados como card: <b>${okCount}</b> de <b>${items.length}</b>\n` +
        `❌ Falhas (fail-closed, nada inventado): <b>${items.length - okCount}</b>\n\n` +
        `Cada card tem decisão independente: ✅ PUBLICAR registra a decisão · ❌ DESCARTAR cancela.\n` +
        `<i>Nenhuma publicação ou aquisição adicional foi executada.</i>`,
    ).catch(() => undefined);
  }

  return {
    lotId,
    chatId,
    countRequested: parsed.count,
    processed: items.length,
    ok: okCount,
    failed: items.length - okCount,
    items,
    chatTargetConfigured,
    affiliateClientAvailable,
  };
}
