import { GoogleGenAI, Type } from "@google/genai";
import type { Product } from "../../src/types";
import { resolvePublicProductCategory } from "../../src/lib/productCategory";
import { extractShopeeIdentity } from "../commercial/marketplace/shopeeIdentity";
import { requireSupabase } from "../repositories/productsRepository";
import * as productsRepository from "../repositories/productsRepository";
import * as curatorRepository from "../repositories/autonomousCuratorRepository";
import type { AutonomousCuratorCategoryProfile } from "./autonomousCuratorProfiles";
import { scoreAutonomousCandidate } from "./autonomousCuratorScoring";
import { buildDeterministicEditorialFallback } from "./productAutomation";
import { createProductionProductPipeline } from "./productPipeline";
import { reviewProductImages } from "./productImageReview";
import {
  DISPLAY_TITLE_REVIEW_VERSION,
  IMAGE_REVIEW_VERSION,
  imageUrlFingerprint,
  isEditorialDisplayTitle,
} from "./productEditorialReview";
import { publishProductWithGate } from "./productPublicationGate";

const TITLE_PRIMARY_MODEL = "gemini-3.5-flash-lite";
const TITLE_FALLBACK_MODEL = "gemini-3.7-flash";
const DETERMINISTIC_TITLE_MODEL = "deterministic-editorial-v1";
const VISUAL_CHAIN_ID = "cerberus_visual_review_chain_v2";

export type RotationPublicationReviewResult = {
  replacement: Product;
  score: number;
  maximumCatalogSimilarity: number;
  titleReviewModel: string;
};

function safeText(value: unknown, maxLength: number): string {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function titleModels(env: NodeJS.ProcessEnv): string[] {
  const primary = safeText(env.GEMINI_AUTONOMOUS_CURATOR_COPY_MODEL || env.GEMINI_PRODUCT_CURATOR_MODEL, 100) || TITLE_PRIMARY_MODEL;
  const fallback = safeText(env.GEMINI_PRODUCT_CURATOR_FALLBACK_MODEL, 100) || TITLE_FALLBACK_MODEL;
  return [...new Set([primary, fallback].filter(Boolean))];
}

function deterministicDisplayTitle(rawTitle: string): string | null {
  const candidate = safeText(buildDeterministicEditorialFallback({ rawTitle }).title, 90);
  const normalizedCandidate = candidate.toLocaleLowerCase("pt-BR");
  const normalizedRaw = safeText(rawTitle, 180).toLocaleLowerCase("pt-BR");
  if (!candidate || normalizedCandidate === normalizedRaw || !isEditorialDisplayTitle(candidate)) return null;
  return candidate;
}

async function reviewDisplayTitle(input: {
  rawTitle: string;
  category: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ displayTitle: string; model: string }> {
  const apiKey = safeText(input.env.GEMINI_API_KEY, 500);
  let lastReason = apiKey ? "DISPLAY_TITLE_PROVIDER_UNAVAILABLE" : "DISPLAY_TITLE_PROVIDER_NOT_CONFIGURED";

  if (apiKey) {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { headers: { "User-Agent": "aistudio-build" } } });
    for (const model of titleModels(input.env)) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: `Revise este título real de marketplace para publicação editorial no Cerberus Finds.\nTítulo bruto: ${input.rawTitle}\nCategoria confirmada: ${input.category}\n\nRetorne somente um display_title em PT-BR com no máximo 8 palavras. Remova marca, SKU, promoções, frete, marketplace e redundâncias. Não invente material, função, época, cor ou atributo que não esteja explicitamente no título bruto.`,
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: { display_title: { type: Type.STRING } },
              required: ["display_title"],
            },
          },
        });
        const parsed = JSON.parse(String(response.text || "{}")) as { display_title?: unknown };
        const displayTitle = safeText(parsed.display_title, 90);
        if (!displayTitle || displayTitle.toLocaleLowerCase("pt-BR") === input.rawTitle.toLocaleLowerCase("pt-BR") || !isEditorialDisplayTitle(displayTitle)) {
          lastReason = "DISPLAY_TITLE_INVALID_RESPONSE";
          continue;
        }
        return { displayTitle, model };
      } catch (error) {
        const message = safeText(error instanceof Error ? error.message : error, 140).toUpperCase();
        lastReason = /429|RESOURCE_EXHAUSTED|RATE_LIMIT|TIMEOUT|503|UNAVAILABLE/.test(message)
          ? "DISPLAY_TITLE_PROVIDER_TEMPORARILY_UNAVAILABLE"
          : /401|403|API_KEY|PERMISSION|UNAUTHENTICATED/.test(message)
            ? "DISPLAY_TITLE_PROVIDER_AUTH_ERROR"
            : "DISPLAY_TITLE_PROVIDER_INVALID_RESPONSE";
        if (lastReason === "DISPLAY_TITLE_PROVIDER_AUTH_ERROR") break;
      }
    }
  }

  const deterministicTitle = deterministicDisplayTitle(input.rawTitle);
  if (deterministicTitle) {
    return { displayTitle: deterministicTitle, model: `${DETERMINISTIC_TITLE_MODEL}:${lastReason.toLowerCase()}` };
  }

  throw new Error(`REVIEW_RECOVERY_PENDING:${lastReason}`);
}

async function loadIdentity(productId: string) {
  const { data, error } = await requireSupabase()
    .from("product_source_identities")
    .select("marketplace,shop_id,item_id,source_product_url")
    .eq("product_id", productId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.shop_id || !data?.item_id || !data?.source_product_url) throw new Error("ROTATION_PUBLICATION_SOURCE_IDENTITY_MISSING");
  const sourceProductUrl = String(data.source_product_url);
  const parsed = extractShopeeIdentity(sourceProductUrl);
  if (String(data.marketplace || "").toLowerCase() !== "shopee" || parsed.shopId !== String(data.shop_id) || parsed.itemId !== String(data.item_id)) {
    throw new Error("ROTATION_PUBLICATION_SOURCE_IDENTITY_INVALID");
  }
  return {
    shopId: String(data.shop_id),
    itemId: String(data.item_id),
    sourceProductUrl,
  };
}

export async function reviewAndPublishRotationCandidate(input: {
  source: Product;
  candidate: Product;
  profile: AutonomousCuratorCategoryProfile;
  query: string;
  env?: NodeJS.ProcessEnv;
}): Promise<RotationPublicationReviewResult> {
  const env = input.env || process.env;
  if (input.candidate.status !== "paused" || input.candidate.ativo !== false) throw new Error("ROTATION_CANDIDATE_STATE_CHANGED");
  if (input.source.status !== "published" || input.source.ativo === false) throw new Error("ROTATION_SOURCE_NO_LONGER_ACTIVE");
  if (input.candidate.categoria !== input.source.categoria || input.profile.category !== input.source.categoria) throw new Error("ROTATION_CATEGORY_MISMATCH");

  const identity = await loadIdentity(input.candidate.id);
  const rawTitle = safeText(input.candidate.rawTitle || input.candidate.produto, 180);
  if (!rawTitle) throw new Error("ROTATION_PUBLICATION_RAW_TITLE_MISSING");

  const titleReview = await reviewDisplayTitle({ rawTitle, category: input.profile.category, env });
  const inferredCategory = resolvePublicProductCategory(input.profile.category, { title: titleReview.displayTitle });
  if (inferredCategory !== input.profile.category) throw new Error("ROTATION_PUBLICATION_CATEGORY_MISMATCH");

  const imageCuration = await reviewProductImages(input.candidate.imagens || [], rawTitle, { env, allowRepair: true });
  if (imageCuration.status !== "ready" || !imageCuration.primaryImageUrl) {
    throw new Error(`REVIEW_RECOVERY_PENDING:${imageCuration.reason || "IMAGE_REVIEW_UNAVAILABLE"}`);
  }
  const primaryAssessment = imageCuration.assessments.find(assessment => assessment.url === imageCuration.primaryImageUrl);
  if (!primaryAssessment || primaryAssessment.decision !== "clean" || primaryAssessment.confidence === "LOW") {
    throw new Error("ROTATION_PUBLICATION_IMAGE_NOT_CLEAN");
  }

  const price = Number(input.candidate.preco);
  if (!Number.isFinite(price) || price <= 0) throw new Error("ROTATION_PUBLICATION_PRICE_UNVERIFIED");
  const deterministic = buildDeterministicEditorialFallback({ rawTitle });
  const description = safeText(input.candidate.descricao, 600) || deterministic.description;
  const publicImages = [imageCuration.primaryImageUrl, ...imageCuration.galleryImageUrls];

  const pipeline = await createProductionProductPipeline().evaluate({
    normalizedUrl: identity.sourceProductUrl,
    link: input.candidate.link,
    marketplace: "Shopee",
    produto: titleReview.displayTitle,
    rawTitle,
    displayTitle: titleReview.displayTitle,
    categoria: input.profile.category,
    preco: price,
    imagens: publicImages,
    imagensOriginais: imageCuration.rawImageUrls,
    imageCuration,
    imagemPrincipal: imageCuration.primaryImageUrl,
    imagensGaleria: imageCuration.galleryImageUrls,
    imageEditorialStatus: "clean",
    descricao: description,
  });
  const lifecycleApproved = pipeline.validation.outcome === "PASS"
    && pipeline.state !== "ERROR"
    && pipeline.state !== "REJECTED"
    && pipeline.curation.recommendation === "PUBLISH";
  if (!lifecycleApproved) {
    throw new Error(`ROTATION_PUBLICATION_PIPELINE_REJECTED:${pipeline.validation.errors.join("|") || pipeline.curation.recommendation}`);
  }

  const existingProducts = (await productsRepository.getProducts()).filter(product => product.id !== input.candidate.id && product.id !== input.source.id);
  const breakdown = scoreAutonomousCandidate({
    profile: input.profile,
    rawTitle,
    displayTitle: titleReview.displayTitle,
    description,
    category: input.profile.category,
    price,
    imageCuration,
    pipelineScore: pipeline.curation.score,
    existingProducts,
  });
  const config = await curatorRepository.getAutonomousCuratorConfig();
  if (!config.autoPublishEnabled || breakdown.finalScore < config.autoPublishThreshold) {
    throw new Error(`ROTATION_PUBLICATION_SCORE_BELOW_CANONICAL_THRESHOLD:${breakdown.finalScore}`);
  }
  if (breakdown.maximumCatalogSimilarity >= 0.82) {
    throw new Error(`ROTATION_PUBLICATION_CATALOG_SIMILARITY:${breakdown.maximumCatalogSimilarity}`);
  }

  const reviewedAt = new Date().toISOString();
  const { error: updateError } = await requireSupabase().from("products").update({
    produto: titleReview.displayTitle,
    categoria: input.profile.category,
    preco: price,
    imagens: publicImages,
    descricao: description,
    raw_title: rawTitle,
    display_title: titleReview.displayTitle,
    display_title_status: "reviewed",
    display_title_reviewed_at: reviewedAt,
    display_title_review_model: titleReview.model,
    display_title_review_version: DISPLAY_TITLE_REVIEW_VERSION,
    image_editorial_status: "clean",
    image_curation: imageCuration,
    image_reviewed_at: reviewedAt,
    image_review_model: VISUAL_CHAIN_ID,
    image_review_version: IMAGE_REVIEW_VERSION,
    image_review_fingerprint: imageUrlFingerprint(imageCuration.primaryImageUrl),
    ativo: false,
    status: "paused",
  }).eq("id", input.candidate.id).eq("status", "paused").eq("ativo", false);
  if (updateError) throw updateError;

  const reviewedProduct: Product = {
    ...input.candidate,
    produto: titleReview.displayTitle,
    rawTitle,
    displayTitle: titleReview.displayTitle,
    displayTitleStatus: "reviewed",
    displayTitleReviewedAt: reviewedAt,
    displayTitleReviewModel: titleReview.model,
    displayTitleReviewVersion: DISPLAY_TITLE_REVIEW_VERSION,
    categoria: input.profile.category,
    preco: price,
    imagens: publicImages,
    descricao: description,
    imageEditorialStatus: "clean",
    imageCuration,
    imageReviewedAt: reviewedAt,
    imageReviewModel: VISUAL_CHAIN_ID,
    imageReviewVersion: IMAGE_REVIEW_VERSION,
    imageReviewFingerprint: imageUrlFingerprint(imageCuration.primaryImageUrl),
    ativo: false,
    status: "paused",
  };

  await publishProductWithGate({
    product: reviewedProduct,
    createdBy: "autonomous_curator_queue",
    evidence: {
      source: "product_rotation",
      score: breakdown.finalScore,
      threshold: config.autoPublishThreshold,
      maximumCatalogSimilarity: breakdown.maximumCatalogSimilarity,
      categoryMismatch: false,
      offBrand: false,
      lifecycleApproved: true,
      reviewState: pipeline.state,
    },
  });

  const replacement = await productsRepository.getProductByIdOrSlug(input.candidate.id);
  if (!replacement || replacement.status !== "published" || replacement.ativo === false) throw new Error("ROTATION_PUBLICATION_POST_GATE_READ_FAILED");
  return {
    replacement,
    score: breakdown.finalScore,
    maximumCatalogSimilarity: breakdown.maximumCatalogSimilarity,
    titleReviewModel: titleReview.model,
  };
}

export const productRotationPublicationInternals = {
  titleModels,
  deterministicDisplayTitle,
  reviewDisplayTitle,
  VISUAL_CHAIN_ID,
};
