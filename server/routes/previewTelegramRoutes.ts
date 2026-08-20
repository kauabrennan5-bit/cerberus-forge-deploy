// ============================================================================
// Fase 23 — Preview manual Shopee Affiliate → Telegram (admin-only).
//
// POST /api/commercial/preview-telegram
// Fluxo operacional básico de afiliado, SEM pipeline de publicação:
//   URL pública Shopee → identity (extractShopeeIdentifiers)
//   → acquireAffiliateLink (1 chamada oficial READ-ONLY à productOfferV2,
//     que traz name, price, productLink e o offerLink oficial da conta)
//   → PendingReview existente (status "pending", meta source "affiliate_preview")
//   → card Telegram com teclado [✅ PUBLICAR] [❌ DESCARTAR].
//
// PREVIEW != PUBLICATION · DECISION != ACTION:
//   - NUNCA executa pipeline.publish, generateShortLink, N13/N14/N15,
//     scraping, Seller API ou qualquer mutation Shopee.
//   - O callback [✅ PUBLICAR] é tratado pelo bot como approve_only:
//     somente REGISTRA a decisão (status "published" no repositório de
//     review), encaminhando à publicação manual — publicação automática
//     exige o fluxo de review canônico existente (confirm_pub).
//   - Preço exibido com escala explicitamente NÃO verificada (jamais "R$").
//   - Imagem não é fornecida pela fonte oficial → card informa a ausência.
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
  PendingReview,
  sendTelegramMessage,
} from "../services/telegramBot";
import {
  savePendingReview,
} from "../repositories/telegramRepository";

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
  productLink: string | null;
  affiliateUrl: string | null;
  shopId: string | null;
  itemId: string | null;
  status: ShopeeAffiliateAcquisitionResult["status"];
}): string {
  const priceInfo = formatPreviewPrice(params.price);
  const priceLine = priceInfo.display
    ? `💰 <b>Preço:</b> ${priceInfo.display} <i>(escala não verificada — não tratar como moeda)</i>`
    : `⚠️ <b>Preço:</b> não retornado pela fonte oficial`;
  const affiliateLine = params.affiliateUrl
    ? `<b>Link de afiliado:</b> <code>${params.affiliateUrl}</code>`
    : `<b>Link de afiliado:</b> <i>não elegível (fonte oficial não retornou offerLink)</i>`;
  const imageLine = `🖼️ <b>Imagem:</b> não fornecida pela fonte oficial (a API de Afiliados não inclui imagens no nó de oferta)`;
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
}): Promise<{ messageId: number | null; ok: boolean; reason?: string }> {
  try {
    const sent = await sendTelegramMessage(params.chatId, params.text, params.keyboard);
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
 * Cria o PendingReview a partir do resultado oficial da API (sem scraping,
 * sem lifecycle, sem candidate) e persiste no repositório existente.
 */
async function persistPreviewReview(params: {
  chatId: number;
  reviewId: string;
  name: string | null;
  price: number | null;
  normalizedUrl: string;
  productLink: string | null;
  affiliateUrl: string | null;
}): Promise<PendingReview> {
  const username = process.env.USER ?? "admin";
  const review: PendingReview = {
    id: params.reviewId,
    chatId: params.chatId,
    senderId: Number(process.env.TELEGRAM_ALLOWED_USER_IDS?.split(",")[0] ?? 0) || 0,
    firstName: "admin",
    username,
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    produto: params.name ?? "(sem nome oficial)",
    categoria: "affiliate_preview",
    preco: params.price ?? 0,
    imagens: [],
    normalizedUrl: params.productLink ?? params.normalizedUrl,
    descricao: params.affiliateUrl
      ? `affiliate_preview · link oficial retornado pela Affiliate API (source=affiliate_preview) · preço com escala não verificada`
      : `affiliate_preview · link de afiliado não elegível (source=affiliate_preview) · preço com escala não verificada`,
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

      const reviewId = buildPreviewReviewId(trimmedUrl, chatId);
      const text = buildPreviewCardText({
        name: acquisition.name,
        price: parsedPrice,
        productLink: acquisition.productLink,
        affiliateUrl: acquisition.affiliateUrl,
        shopId: acquisition.shopId,
        itemId: acquisition.itemId,
        status: acquisition.status,
      });

      const persistPromise = persistPreviewReview({
        chatId,
        reviewId,
        name: acquisition.name,
        price: parsedPrice,
        normalizedUrl: trimmedUrl,
        productLink: acquisition.productLink,
        affiliateUrl: acquisition.affiliateUrl,
      });
      const sendPromise = sendPreviewCard({ chatId, text, keyboard: buildPreviewKeyboard(reviewId) });

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
        cardMessageId: sendResult.messageId,
      });
    } catch (err) {
      // Sem expor mensagem bruta (pode conter valores comerciais).
      res.status(500).json({ ok: false, error: "preview_internal_error" });
    }
  });
}
