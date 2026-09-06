import { createHash } from "node:crypto";
import { savePendingReview } from "../repositories/telegramRepository";
import { releaseProductSourceIdentityByReview, reserveProductSourceIdentity } from "../repositories/autonomousCuratorRepository";
import type { ProductImageCuration } from "../../src/lib/productImageCuration";
import type { PendingReview } from "./telegramTypes";
import { runShopeeManualDeliveryCommand } from "./shopeeManualDelivery";
import type { ShopeeLotResult } from "./shopeeCommandRanked";

/**
 * Falhas técnicas objetivas de imagem continuam sendo hard blocks mesmo no
 * fluxo manual. Tudo o que não estiver nesta lista é evidência editorial ou
 * indisponibilidade do reviewer e pode ser submetido à decisão humana.
 */
const TECHNICAL_IMAGE_BLOCKERS = new Set([
  "IMAGE_MISSING",
  "IMAGE_HOST_INVALID",
  "IMAGE_PLACEHOLDER",
  "IMAGE_INACCESSIBLE",
  "IMAGE_REDIRECT_HOST_INVALID",
  "IMAGE_HTTP_ERROR",
  "IMAGE_BODY_UNREADABLE",
  "IMAGE_EMPTY",
  "IMAGE_TOO_LARGE",
  "IMAGE_BYTES_INVALID",
  "IMAGE_MIME_UNSUPPORTED",
  "IMAGE_DIMENSIONS_UNKNOWN",
  "IMAGE_TOO_SMALL",
  "IMAGE_INVALID",
]);

function isPublicHttpsImage(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function manualReviewReasons(review: PendingReview): string[] {
  const values = review.existingProduct?.manualReviewReasons;
  return Array.isArray(values)
    ? values.map((value: unknown) => String(value || "").trim()).filter(Boolean)
    : [];
}

function hasTechnicalImageBlock(review: PendingReview): boolean {
  return manualReviewReasons(review).some(reason => TECHNICAL_IMAGE_BLOCKERS.has(reason));
}

/**
 * O contrato /shopee entrega opções ao administrador mesmo quando a análise
 * visual automática está indisponível ou reprova critérios editoriais. O
 * confirm_pub legado ainda interpreta imageEditorialStatus/imageCuration como
 * hard gate antes de ProductPipeline.approve(), portanto esta adaptação torna
 * a imagem tecnicamente utilizável no caminho MANUAL sem apagar a proveniência
 * real da review: visualReviewStatus, manualReviewStatus e manualReviewReasons
 * permanecem intactos em existingProduct para auditoria.
 *
 * Isso não libera imagem inexistente, não-HTTPS ou tecnicamente inválida. Link,
 * identidade Shopee, afiliado, preço, categoria, duplicidade e teto continuam
 * sendo revalidados pelos hard gates já existentes após o clique humano.
 */
export function applyShopeeManualImageAuthority(review: PendingReview): PendingReview {
  if (review.existingProduct?.manualDeliveryContract !== true) return review;

  const primaryImage = [review.imagemPrincipal, ...(review.imagens || [])]
    .find(isPublicHttpsImage);
  if (!primaryImage || hasTechnicalImageBlock(review)) return review;

  const rawImageUrls = Array.from(new Set(
    [...(review.imagensOriginais || []), ...(review.imagens || []), primaryImage]
      .filter(isPublicHttpsImage),
  ));
  const assessments = review.imageCuration?.assessments || [];
  const curation: ProductImageCuration = {
    status: "ready",
    rawImageUrls,
    primaryImageUrl: primaryImage,
    galleryImageUrls: rawImageUrls.filter(url => url !== primaryImage),
    assessments,
  };

  return {
    ...review,
    imagens: rawImageUrls,
    imagensOriginais: rawImageUrls,
    imagemPrincipal: primaryImage,
    imagensGaleria: curation.galleryImageUrls,
    // Compatibilidade do caminho humano: o estado visual original segue
    // registrado em existingProduct e continua aparecendo no card de decisão.
    imageEditorialStatus: "clean",
    imageCuration: curation,
  };
}

type ManualIdentityReservationInput = {
  marketplace: "Shopee";
  shopId: string;
  itemId: string;
  sourceProductUrl: string;
  runId: string;
  reviewId: string;
  ttlMinutes: number;
};

/**
 * product_source_identities.reserved_run_id é UUID. Reviews manuais não têm um
 * autonomous_curator_run real, portanto derivamos um UUID estável somente para
 * satisfazer o contrato de armazenamento; a autoridade/ownership continua
 * sendo determinada pelo reviewId e pela URL oficial exata.
 */
function manualReservationRunId(reviewId: string): string {
  const hex = createHash("sha256").update(`telegram_manual:${reviewId}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function manualIdentityReservationInput(review: PendingReview, now = Date.now()): ManualIdentityReservationInput | null {
  if (review.existingProduct?.manualDeliveryContract !== true) return null;
  const meta = review.existingProduct as Record<string, unknown>;
  const shopId = String(meta.shopId || "").trim();
  const itemId = String(meta.itemId || "").trim();
  const sourceProductUrl = String(review.normalizedUrl || "").trim();
  if (!shopId || !itemId || !/^https:\/\/([^/]+\.)?shopee\.com\.br\//i.test(sourceProductUrl)) return null;
  const expiresAt = Number(review.expiresAt || (review.createdAt || now) + 60 * 60 * 1000);
  const ttlMinutes = Math.max(5, Math.ceil((expiresAt - now) / 60_000));
  return {
    marketplace: "Shopee",
    shopId,
    itemId,
    sourceProductUrl,
    runId: manualReservationRunId(review.id),
    reviewId: review.id,
    ttlMinutes,
  };
}

export async function runShopeeManualDeliveryWithHumanAuthority(argsRaw: string): Promise<ShopeeLotResult> {
  return runShopeeManualDeliveryCommand(argsRaw, {
    saveReview: async review => {
      const adapted = applyShopeeManualImageAuthority(review);
      const identity = manualIdentityReservationInput(adapted);
      if (!identity) throw new Error("SHOPEE_MANUAL_REVIEW_IDENTITY_METADATA_INVALID");
      const reservation = await reserveProductSourceIdentity(identity);
      if (!reservation.reserved) throw new Error("SHOPEE_MANUAL_REVIEW_IDENTITY_CONFLICT");
      try {
        await savePendingReview(adapted);
      } catch (error) {
        await releaseProductSourceIdentityByReview(adapted.id).catch(() => undefined);
        throw error;
      }
    },
  });
}

export const shopeeManualHumanAuthorityInternals = {
  manualIdentityReservationInput,
  manualReservationRunId,
};
