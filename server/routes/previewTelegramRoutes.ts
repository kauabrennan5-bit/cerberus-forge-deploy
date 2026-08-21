// ============================================================================
// Fase 23 + 24 — Preview manual Shopee Affiliate → Scraper → Telegram
// (admin-only). FASE 24: o Scraper EXISTENTE (productAutomation scraper +
// Gemini, já usado pelo fluxo de link do bot) enriquece o produto
// confirmado pela Affiliate API com imagens e preço exibido ANTES da
// montagem do card — NÃO cria scraper novo nem rota paralela.
//
// POST /api/commercial/preview-telegram
// Fluxo operacional básico de afiliado, SEM pipeline de publicação:
//   URL pública Shopee → identity (extractShopeeIdentifiers)
//   → acquireAffiliateLink (1 chamada oficial READ-ONLY à productOfferV2,
//     que traz name, price, productLink e o offerLink oficial da conta)
//   → extractProductForReview (scraper existente) sobre a URL canônica
//     oficial + verificação determinística de identidade (shop_id/item_id)
//   → merge com proveniência explícita (affiliate = autoridade para IDs
//     e offerLink; scraper = fonte observacional de imagens/preço exibido)
//   → PendingReview existente (status "pending", meta source "affiliate_preview")
//   → card Telegram (FOTO quando o scraper observou imagens) com teclado
//     [✅ PUBLICAR] [❌ DESCARTAR].
//
// PREVIEW != PUBLICATION · DECISION != ACTION:
//   - NUNCA executa pipeline.publish, generateShortLink, N13/N14/N15,
//     Seller API ou qualquer mutation Shopee.
//   - O callback [✅ PUBLICAR] é tratado pelo bot como approve_only:
//     somente REGISTRA a decisão (status "published" no repositório de
//     review), encaminhando à publicação manual — publicação automática
//     exige o fluxo de review canônico existente (confirm_pub).
//   - Preço do scraper é observacional (proveniência "scraper_observacional",
//     scale=UNVERIFIED) — jamais rotulado como moeda nem convertido.
//   - FAIL-CLOSED SCRAPER: se o scraper falhar (bloqueio/timeout/sem dados),
//     NENHUM card é enviado e NENHUM review é persistido — jamais inventar
//     imagens ou preço. Divergência de identidade → 424 sem card.
// ============================================================================
import type { Request, Response } from "express";
import {
  extractShopeeIdentifiers,
  ShopeeAffiliateAcquisitionResult,
} from "../commercial/affiliate/shopeeClientContracts";
import {
  createShopeeApiClient,
  extractOfferNodes,
  ShopeeApiClient,
} from "../commercial/affiliate/shopeeApiClient";
import {
  extractProductForReview,
} from "../services/productAutomation";
import {
  PendingReview,
  sendTelegramMessage,
  sendTelegramPhoto,
} from "../services/telegramBot";
import {
  savePendingReview,
} from "../repositories/telegramRepository";

/**
 * Extrai (shop_id, item_id) de uma URL normalizada Shopee em formato
 * canônico `/product/{shop_id}/{item_id}` — MESMA normalização já usada
 * pelo fluxo de link do bot (`normalizeProductUrl`). Determinística,
 * sem heurística de conteúdo: identidade vem da URL, não da página.
 */
function extractCanonicalShopeeIds(normalizedUrl: string): {
  shopId: string | null;
  itemId: string | null;
} {
  let shopId: string | null = null;
  let itemId: string | null = null;
  const parsedUrl = normalizedUrl.trim().toLowerCase();
  if (!parsedUrl.includes("shopee.com.br") && !parsedUrl.includes("shope.ee")) {
    return { shopId: null, itemId: null };
  }
  const m1 = normalizedUrl.match(/\/product\/(\d+)\/(\d+)/i);
  if (m1) {
    shopId = m1[1];
    itemId = m1[2];
  }
  if (!shopId) {
    const m2 = normalizedUrl.match(/i\.(\d+)\.(\d+)/i);
    if (m2) {
      shopId = m2[1];
      itemId = m2[2];
    }
  }
  return { shopId, itemId };
}

/** Idempotência por URL (mesma URL dentro de 1h retorna o mesmo reviewId). */
interface PreviewEntry {
  reviewId: string;
  createdAt: number;
}

const PREVIEW_TTL_MS = 60 * 60 * 1000;
const previewRegistry = new Map<string, PreviewEntry>();

// Hook de teste controlado (padrão setXForTests da codebase): limpa o
// registry de idempotência ao final de cada teste unitário. NUNCA usar em produção.
export function setTestPreviewRegistryForTests(): void {
  previewRegistry.clear();
}

function cleanRegistry(): void {
  const cutoff = Date.now() - PREVIEW_TTL_MS;
  for (const [key, entry] of previewRegistry) {
    if (entry.createdAt < cutoff) previewRegistry.delete(key);
  }
}

function buildShopeeClient(): ShopeeApiClient | null {
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
 * Gera um reviewId determinístico a partir da URL normalizada + chatId
 * (idempotência simples, sem depender do estado do Telegram).
 */
function buildPreviewReviewId(normalizedUrl: string, chatId: number): string {
  const key = `${normalizedUrl}|${chatId}`;
  let hash = 5381;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 33) ^ key.charCodeAt(i);
  }
  return `affprev-${Math.abs(hash >>> 0).toString(36)}-${Date.now().toString(36)}`;
}

/**
 * Formata o preço preservando a escala NÃO verificada:
 * o número bruto é exibido SOMENTE acompanhado da nota de escala não
 * verificada. Jamais rotulado como moeda (R$) nem convertido.
 */
function formatPreviewPrice(value: number | null): {
  display: string | null;
  verified: boolean;
} {
  if (value === null || value === undefined) {
    return { display: null, verified: false };
  }
  if (!Number.isFinite(value)) {
    return { display: null, verified: false };
  }
  const str =
    Number.isInteger(value)
      ? value.toFixed(0)
      : value.toFixed(2).replace(".", ",");
  return { display: str, verified: false };
}

/**
 * Monta o texto do card de preview com todos os campos oficialmente
 * retornados pela Affiliate API (productOfferV2) + auditoria de identidade.
 */
function buildPreviewCardText(params: {
  name: string | null;
  price: number | null;
  priceSource: "affiliate_api" | "scraper_observacional";
  productLink: string | null;
  affiliateUrl: string | null;
  shopId: string | null;
  itemId: string | null;
  status: ShopeeAffiliateAcquisitionResult["status"];
  imageUrl: string | null;
  imageCount: number;
}): string {
  const priceInfo = formatPreviewPrice(params.price);
  const priceSourceNote =
    params.priceSource === "scraper_observacional"
      ? " (observacional — escala não verificada — não tratar como moeda)"
      : " (escala não verificada — não tratar como moeda)";
  const priceLine = priceInfo.display
    ? `💰 <b>Preço:</b> ${priceInfo.display}<i>${priceSourceNote}</i>`
    : `⚠️ <b>Preço:</b> não retornado por nenhuma das fontes`;
  const affiliateLine = params.affiliateUrl
    ? `<b>Link de afiliado:</b> <code>${params.affiliateUrl}</code>`
    : `<b>Link de afiliado:</b> <i>não elegível (fonte oficial não retornou offerLink)</i>`;
  const imageLine =
    params.imageUrl
      ? `🖼️ <b>Imagem:</b> ${params.imageCount} imagem(ns) oficial(is) observadas no anúncio (scraper · proveniência do anúncio original)`
      : `🖼️ <b>Imagem:</b> não observada pelo scraper (nenhuma imagem real foi inventada)`;
  const identityLine = `🔎 <b>Auditoria:</b> shop_id=<code>${params.shopId ?? "?"}</code> · item_id=<code>${params.itemId ?? "?"}</code> · status=<code>${params.status}</code>`;
  return (
    `🛡️ <b>CERBERUS FINDS — PREVIEW SHOPEE AFFILIATE</b>\n\n` +
    `🏷️ <b>Produto:</b> ${params.name ?? "<i>sem nome retornado</i>"}\n` +
    priceLine + `\n` +
    `🔗 <b>URL original:</b> <code>${params.productLink ?? "?"}</code>\n` +
    `${affiliateLine}\n` +
    `${imageLine}\n` +
    `${identityLine}\n\n` +
    `<i>Affiliate API oficial · preview de decisão manual — nada é publicado ou adquirido além do link oficial retornado pela consulta.</i>`
  );
}

/**
 * Monta o teclado inline do preview:
 *   [✅ PUBLICAR]  → callback "approve_only:{reviewId}" (só registra decisão)
 *   [❌ DESCARTAR] → callback "cancel_rev:{reviewId}" (repositorio existente)
 */
function buildPreviewKeyboard(reviewId: string) {
  return {
    inline_keyboard: [
      [{ text: "✅ PUBLICAR", callback_data: `approve_only:${reviewId}` }],
      [{ text: "❌ DESCARTAR", callback_data: `cancel_rev:${reviewId}` }],
    ],
  };
}

async function sendPreviewCard(params: {
  chatId: number;
  text: string;
  keyboard: ReturnType<typeof buildPreviewKeyboard>;
  /** Primeira imagem oficial observada pelo scraper (pode ser null). */
  imageUrl?: string | null;
}): Promise<{ messageId: number | null; ok: boolean; reason?: string }> {
  try {
    let sent: any = null;
    if (params.imageUrl) {
      try {
        sent = await sendTelegramPhoto(
          params.chatId,
          params.imageUrl,
          params.text,
          params.keyboard,
        );
      } catch {
        sent = null;
      }
    }
    if (!sent) {
      sent = await sendTelegramMessage(params.chatId, params.text, params.keyboard);
    }
    const messageId =
      sent && typeof sent === "object" && "message_id" in sent
        ? Number((sent as { message_id?: number }).message_id ?? 0)
        : null;
    return { messageId, ok: true };
  } catch (err) {
    return { messageId: null, ok: false, reason: "telegram_send_failed" };
  }
}

/**
 * Cria o PendingReview a partir do merge Affiliate API (autoridade para
 * identidade e offerLink) + Scraper existente (imagens e preço exibido,
 * proveniência "scraper_observacional", scale=UNVERIFIED) e persiste no
 * repositório existente. SEM lifecycle, SEM candidate — PREVIEW != PUBLICATION.
 */
async function persistPreviewReview(params: {
  chatId: number;
  reviewId: string;
  name: string | null;
  price: number | null;
  normalizedUrl: string;
  productLink: string | null;
  affiliateUrl: string | null;
  enriched?: {
    /** Imagens oficiais observadas pelo scraper (pode estar vazio). */
    images: string[];
    /** Preço exibido observado pelo scraper (null quando ausente). */
    scraperPrice: number | null;
    /** Título curatorial do scraper/curador (opcional). */
    curatedTitle?: string | null;
    /** Categoria curatorial do scraper/curador (opcional). */
    curatedCategory?: string | null;
    /** Descrição curatorial do scraper/curador (opcional). */
    curatedDescription?: string | null;
  } | null;
}): Promise<PendingReview> {
  const username = process.env.USER ?? "admin";
  const images = params.enriched?.images ?? [];
  const hasScrapedPrice =
    params.enriched?.scraperPrice !== null &&
    params.enriched?.scraperPrice !== undefined &&
    Number.isFinite(params.enriched?.scraperPrice) &&
    (params.enriched?.scraperPrice ?? 0) > 0;
  // Precedência de preço: exibir o observado pelo scraper quando válido,
  // SENÃO o valor bruto da Affiliate API — em ambos os casos a escala
  // permanece EXPLICITAMENTE não verificada (jamais "R$").
  const displayPrice = hasScrapedPrice
    ? (params.enriched?.scraperPrice ?? null)
    : (params.price ?? null);
  const provenanceNote = hasScrapedPrice
    ? `preço exibido observacional (scraper_observacional) · escala não verificada`
    : `preço com escala não verificada`;
  const review: PendingReview = {
    id: params.reviewId,
    chatId: params.chatId,
    senderId: Number(process.env.TELEGRAM_ALLOWED_USER_IDS?.split(",")[0] ?? 0) || 0,
    firstName: "admin",
    username,
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    produto: params.enriched?.curatedTitle ?? params.name ?? "(sem nome oficial)",
    categoria: params.enriched?.curatedCategory ?? "affiliate_preview",
    preco: displayPrice ?? 0,
    imagens: images,
    normalizedUrl: params.productLink ?? params.normalizedUrl,
    descricao: [
      `affiliate_preview · source=affiliate_preview`,
      params.affiliateUrl ? `link oficial retornado pela Affiliate API: ${params.affiliateUrl}` : `link de afiliado não elegível`,
      hasScrapedPrice || images.length > 0 ? `enriquecimento scraper: ${images.length} imagem(ns)${hasScrapedPrice ? ", preço observacional presente" : ""} · ${provenanceNote}` : "enriquecimento scraper: imagens e preço exibido ausentes",
      params.enriched?.curatedDescription
        ? `descrição curatorial: ${params.enriched.curatedDescription}`
        : null,
    ].filter(Boolean).join(" · "),
    status: "pending",
    existingProduct: {
      source: "affiliate_preview",
      affiliateUrl: params.affiliateUrl,
      priceScaleVerified: false,
    },
  };
  await savePendingReview(review);
  return review;
}

/**
 * Enriquece o produto confirmado pela Affiliate API com o SCRAPER EXISTENTE
 * (productAutomation: scraper + curadoria Gemini). FAIL-CLOSED estrito:
 * se o scraper falhar (bloqueio, timeout, sem título/imagens), retorna
 * failureReason — NENHUM card é enviado e NENHUM review é persistido,
 * pois o produto seria apresentado como completo sem as evidências reais.
 * A identidade é verificada deterministicamente contra os IDs oficiais.
 */
async function enrichWithExistingScraper(params: {
  productLink: string | null;
  officialShopId: string | null;
  officialItemId: string | null;
}): Promise<{
  ok: boolean;
  failureReason: string | null;
  images: string[];
  scraperPrice: number | null;
  curatedTitle: string | null;
  curatedCategory: string | null;
  curatedDescription: string | null;
} | null> {
  const link = params.productLink;
  if (!link) {
    // Sem URL oficial: o scraper não tem identidade verificável — fail-closed
    return {
      ok: false,
      failureReason: "affiliate_no_product_link",
      images: [],
      scraperPrice: null,
      curatedTitle: null,
      curatedCategory: null,
      curatedDescription: null,
    };
  }
  let result: Awaited<ReturnType<typeof extractProductForReview>>;
  try {
    result = await extractProductForReview(link);
  } catch {
    return {
      ok: false,
      failureReason: "scraper_unexpected_error",
      images: [],
      scraperPrice: null,
      curatedTitle: null,
      curatedCategory: null,
      curatedDescription: null,
    };
  }
  if (!result.success || !result.data) {
    return {
      ok: false,
      failureReason: result.error ?? "scraper_extraction_failed",
      images: [],
      scraperPrice: null,
      curatedTitle: null,
      curatedCategory: null,
      curatedDescription: null,
    };
  }
  const data = result.data;
  // Verificação determinística de identidade contra a resposta oficial
  // da Affiliate API (a URL é do productLink oficial, normalizada para
  // /product/{shop_id}/{item_id} pelo próprio scraper).
  const extracted = extractCanonicalShopeeIds(data.normalizedUrl);
  const identityMatches =
    extracted.shopId !== null &&
    extracted.itemId !== null &&
    extracted.shopId === params.officialShopId &&
    extracted.itemId === params.officialItemId;
  if (!identityMatches) {
    return {
      ok: false,
      failureReason: "scraper_identity_mismatch",
      images: [],
      scraperPrice: null,
      curatedTitle: null,
      curatedCategory: null,
      curatedDescription: null,
    };
  }
  return {
    ok: true,
    failureReason: null,
    images: data.imagens ?? [],
    scraperPrice: data.preco,
    curatedTitle: data.produto ?? null,
    curatedCategory: data.categoria ?? null,
    curatedDescription: data.descricao ?? null,
  };
}

export interface PreviewTelegramResult {
  ok: boolean;
  reviewId: string | null;
  affiliateStatus: ShopeeAffiliateAcquisitionResult["status"] | null;
  affiliateUrl: string | null;
  name: string | null;
  price: number | null;
  priceScaleVerified: boolean;
  productLink: string | null;
  shopId: string | null;
  itemId: string | null;
  cardSent: boolean;
  error?: string;
}

interface PreviewRouteDeps {
  app: { post(path: string, ...handlers: unknown[]): unknown };
  requireAdminAuth: (req: Request, res: Response, next: (err?: unknown) => void) => void;
}

export function setupPreviewTelegramRoutes(deps: PreviewRouteDeps): void {
  const { app, requireAdminAuth } = deps;

  // PREVIEW != PUBLICATION · PREVIEW != PROMOTION — a rota NUNCA executa
  // pipeline de publicação, acquisition mutation, scraping, Seller API,
  // N13, N14, N15, N16, N17, N18 ou qualquer alteração do catálogo.
  app.post("/api/commercial/preview-telegram", requireAdminAuth, async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const url = body.url;
      if (!url || typeof url !== "string" || url.trim().length === 0) {
        res.status(400).json({ ok: false, error: "missing_url" });
        return;
      }
      const trimmedUrl = url.trim();
      const identity = extractShopeeIdentifiers(trimmedUrl);
      if (!identity.shopId || !identity.itemId) {
        res.status(400).json({
          ok: false,
          error: "invalid_shopee_url",
          reason: "URL não resolve para (shop_id, item_id) no formato oficial Shopee",
        });
        return;
      }

      // Idempotência: mesma URL retorna o mesmo previewId dentro do TTL.
      cleanRegistry();
      const registryKey = `${trimmedUrl}`;
      const existing = previewRegistry.get(registryKey);
      if (existing) {
        res.status(200).json({
          ok: true,
          reviewId: existing.reviewId,
          duplicate: true,
          note: "preview_idêntico já enviado recentemente — nenhuma nova consulta à Affiliate API",
        });
        return;
      }

      const chatId = Number(
        (process.env.TELEGRAM_ALLOWED_USER_IDS?.split(",")[0] ?? "").trim() || "0",
      );
      if (!chatId) {
        res.status(503).json({ ok: false, error: "telegram_target_unconfigured" });
        return;
      }

      const client = buildShopeeClient();
      if (!client) {
        res.status(503).json({ ok: false, error: "affiliate_auth_unavailable" });
        return;
      }

      // UMA chamada oficial READ-ONLY (productOfferV2) — acquireAffiliateLink
      // parseia o offerLink do nó sem mutation; sem elegibilidade → not_eligible.
      const acquisition = await client.acquireAffiliateLink({
        shopId: identity.shopId,
        itemId: identity.itemId,
      });

      if (acquisition.status !== "link_acquired") {
        // Falha fechada: reportar o estado oficial SEM card e SEM retry.
        res.status(424).json({
          ok: false,
          error: "affiliate_link_not_available",
          affiliateStatus: acquisition.status,
          shopId: acquisition.shopId,
          itemId: acquisition.itemId,
          name: acquisition.name,
        });
        return;
      }

      // O tipo público de acquisition não expõe price; o raw oficial é
      // a única fonte — extrair o nó com o match estrito já validado
      // pelo acquisition e ler o price com a normalização fail-closed
      // da Fase 19 (forma decimal pura, escala permanece NÃO verificada).
      const nodes = extractOfferNodes(acquisition.raw);
      const matchedNode = nodes.find(
        (n) => n.itemId === acquisition.itemId && n.shopId === acquisition.shopId,
      ) ?? null;
      const parsedPrice = matchedNode?.price ?? null;

      // FASE 24 — enriquecimento pelo SCRAPER EXISTENTE (sem criar scraper novo).
      // O produto confirmado pela Affiliate API recebe imagens e preço exibido
      // ANTES da montagem do card. FAIL-CLOSED estrito: scraper falho ou
      // identidade divergente → 424 SEM card e SEM review persistido (jamais
      // apresentar o produto como completo sem as evidências reais observadas).
      const enriched = await enrichWithExistingScraper({
        productLink: acquisition.productLink,
        officialShopId: acquisition.shopId,
        officialItemId: acquisition.itemId,
      });
      if (!enriched.ok) {
        // Sem retry: a falha do scraper é uma condição de mercado (bloqueio
        // anti-bot, timeout, página sem dados) — reportar e parar.
        res.status(424).json({
          ok: false,
          error: "scraper_enrichment_failed",
          failureReason: enriched.failureReason,
          shopId: acquisition.shopId,
          itemId: acquisition.itemId,
          affiliateUrl: acquisition.affiliateUrl,
          note:
            "o scraper existente não conseguiu enriquecer o produto confirmado pela Affiliate API — nenhum card foi enviado e nenhum review foi persistido (fail-closed)",
        });
        return;
      }

      const reviewId = buildPreviewReviewId(trimmedUrl, chatId);
      const text = buildPreviewCardText({
        name: enriched.curatedTitle ?? acquisition.name,
        price: enriched.scraperPrice ?? parsedPrice,
        priceSource: enriched.scraperPrice ? "scraper_observacional" : "affiliate_api",
        productLink: acquisition.productLink,
        affiliateUrl: acquisition.affiliateUrl,
        shopId: acquisition.shopId,
        itemId: acquisition.itemId,
        status: acquisition.status,
        imageUrl: enriched.images[0] ?? null,
        imageCount: enriched.images.length,
      });

      const persistPromise = persistPreviewReview({
        chatId,
        reviewId,
        name: acquisition.name,
        price: parsedPrice,
        normalizedUrl: trimmedUrl,
        productLink: acquisition.productLink,
        affiliateUrl: acquisition.affiliateUrl,
        enriched: {
          images: enriched.images,
          scraperPrice: enriched.scraperPrice,
          curatedTitle: enriched.curatedTitle,
          curatedCategory: enriched.curatedCategory,
          curatedDescription: enriched.curatedDescription,
        },
      });
      const sendPromise = sendPreviewCard({
        chatId,
        text,
        keyboard: buildPreviewKeyboard(reviewId),
        imageUrl: enriched.images[0] ?? null,
      });

      const [review, sendResult] = await Promise.all([persistPromise, sendPromise]);

      if (!sendResult.ok) {
        res.status(503).json({
          ok: false,
          error: "telegram_send_failed",
          reviewId,
          note: "review registrado, card não enviado",
        });
        return;
      }

      previewRegistry.set(registryKey, { reviewId, createdAt: Date.now() });

      res.status(200).json({
        ok: true,
        reviewId,
        affiliateStatus: "link_acquired",
        affiliateUrl: acquisition.affiliateUrl,
        name: acquisition.name,
        price: parsedPrice,
        priceScaleVerified: false,
        productLink: acquisition.productLink,
        shopId: acquisition.shopId,
        itemId: acquisition.itemId,
        cardSent: true,
        cardAsPhoto: Boolean(enriched.images[0] ?? null),
        extractedImageCount: enriched.images.length,
        cardMessageId: sendResult.messageId,
      });
    } catch (err) {
      // Sem expor mensagem bruta (pode conter valores comerciais).
      res.status(500).json({ ok: false, error: "preview_internal_error" });
    }
  });
}
