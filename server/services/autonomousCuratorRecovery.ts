import type { ExtractedReviewData } from "./productAutomation";
import { fetchProductDataFromUrl } from "./scraper";
import { extractShopeeIdentity } from "../commercial/marketplace/shopeeIdentity";
import {
  isEditorialDisplayTitle,
  recoverProductCandidateWithOpenAI,
} from "./productAiRecovery";

export type AutonomousExtractionResult = {
  success: boolean;
  data?: ExtractedReviewData;
  error?: string;
};

function canonicalShopeeUrl(rawUrl: string): string {
  const identity = extractShopeeIdentity(rawUrl);
  if (identity.shopId && identity.itemId) {
    return `https://shopee.com.br/product/${identity.shopId}/${identity.itemId}`;
  }
  return rawUrl.trim();
}

function incompleteEditorialData(data: ExtractedReviewData | undefined): boolean {
  if (!data) return true;
  return !isEditorialDisplayTitle(data.displayTitle)
    || String(data.descricao || "").trim().length < 24
    || !String(data.categoria || "").trim();
}

function safeRecoveryReason(reason: string, imageReason?: string): string {
  const cleanReason = String(reason || "invalid_response").replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80);
  const cleanImage = String(imageReason || "").replace(/[^a-zA-Z0-9_.:=,-]/g, "_").slice(0, 120);
  return `AI_RECOVERY_REJECTED:${cleanReason}${cleanImage ? `:${cleanImage}` : ""}`;
}

function mergeRecoveredData(data: ExtractedReviewData, recovery: Awaited<ReturnType<typeof recoverProductCandidateWithOpenAI>>): AutonomousExtractionResult {
  if (!recovery || !recovery.viable || recovery.imageCuration.status !== "ready" || !recovery.imageCuration.primaryImageUrl) {
    return {
      success: false,
      error: safeRecoveryReason(recovery?.reasonCode || "unavailable", recovery?.imageCuration.reason),
    };
  }
  console.info(`[AUTONOMOUS-CURATOR-RECOVERY] status=recovered model=${recovery.model} confidence=${recovery.confidence}`);
  return {
    success: true,
    data: {
      ...data,
      displayTitle: recovery.displayTitle,
      categoria: recovery.category,
      descricao: recovery.description,
      imagens: [recovery.imageCuration.primaryImageUrl, ...recovery.imageCuration.galleryImageUrls],
      imagensOriginais: recovery.imageCuration.rawImageUrls,
      imagemPrincipal: recovery.imageCuration.primaryImageUrl,
      imagensGaleria: recovery.imageCuration.galleryImageUrls,
      imageCuration: recovery.imageCuration,
      imageEditorialStatus: "clean",
    },
  };
}

export async function recoverIncompleteAutonomousExtraction(
  current: AutonomousExtractionResult,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AutonomousExtractionResult> {
  if (!current.success || !current.data || !incompleteEditorialData(current.data)) return current;
  const data = current.data;
  const recovery = await recoverProductCandidateWithOpenAI({
    rawTitle: data.rawTitle || data.produto,
    trustedTitle: data.rawTitle || data.produto,
    rawContent: data.descricao || "",
    rawImages: data.imagensOriginais?.length ? data.imagensOriginais : data.imagens,
  }, { env });
  if (!recovery) return current;
  const merged = mergeRecoveredData(data, recovery);
  return merged.success ? merged : current;
}

export async function recoverFailedAutonomousExtraction(
  rawUrl: string,
  rawTextOverride?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AutonomousExtractionResult | null> {
  try {
    const scraped = await fetchProductDataFromUrl(rawUrl, rawTextOverride);
    const recovery = await recoverProductCandidateWithOpenAI({
      rawTitle: scraped.title || "",
      trustedTitle: scraped.title || "",
      rawContent: scraped.rawContent,
      rawImages: scraped.images,
    }, { env });
    if (!recovery) return null;
    if (!recovery.viable || recovery.imageCuration.status !== "ready" || !recovery.imageCuration.primaryImageUrl) {
      console.info(`[AUTONOMOUS-CURATOR-RECOVERY] status=rejected reason=${recovery.reasonCode}`);
      return {
        success: false,
        error: safeRecoveryReason(recovery.reasonCode, recovery.imageCuration.reason),
      };
    }

    const rawTitle = String(scraped.title || recovery.displayTitle).replace(/\s+/g, " ").trim().slice(0, 300);
    console.info(`[AUTONOMOUS-CURATOR-RECOVERY] status=recovered model=${recovery.model} confidence=${recovery.confidence}`);
    return {
      success: true,
      data: {
        normalizedUrl: canonicalShopeeUrl(rawUrl),
        marketplace: "Shopee",
        rawTitle,
        displayTitle: recovery.displayTitle,
        produto: rawTitle || recovery.displayTitle,
        categoria: recovery.category,
        preco: scraped.price,
        precoMaximo: scraped.priceMax,
        precoCheckout: scraped.checkoutPrice,
        condicaoPrecoCheckout: scraped.checkoutPriceCondition,
        evidenciaPromocional: scraped.promotionEvidence,
        imagens: [recovery.imageCuration.primaryImageUrl, ...recovery.imageCuration.galleryImageUrls],
        imagensOriginais: recovery.imageCuration.rawImageUrls,
        imagemPrincipal: recovery.imageCuration.primaryImageUrl,
        imagensGaleria: recovery.imageCuration.galleryImageUrls,
        imageCuration: recovery.imageCuration,
        imageEditorialStatus: "clean",
        descricao: recovery.description,
        existingProduct: null,
      },
    };
  } catch {
    return null;
  }
}

export const autonomousCuratorRecoveryInternals = {
  canonicalShopeeUrl,
  incompleteEditorialData,
  safeRecoveryReason,
};
