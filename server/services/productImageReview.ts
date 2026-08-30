import { GoogleGenAI } from "@google/genai";
import {
  curateProductImages,
  type ProductImageAssessment,
  type ProductImageCuration,
} from "../../src/lib/productImageCuration";
import { ExternalCallBudget, type BudgetDecision } from "./operationalGuards";
import { repairProductImage, type ProductImageRepairResult } from "./productImageRepair";

type BudgetLike = {
  reserve(name: string, amount?: number): BudgetDecision;
};

type GenerateContent = (request: Record<string, unknown>) => Promise<{ text?: string | null }>;
type RepairImage = (options: Parameters<typeof repairProductImage>[0]) => Promise<ProductImageRepairResult | null>;
type DelayImpl = (ms: number) => Promise<void>;

type ReviewOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  generateContent?: GenerateContent;
  repairImage?: RepairImage;
  budget?: BudgetLike;
  allowRepair?: boolean;
  maxImages?: number;
  timeoutMs?: number;
  delayImpl?: DelayImpl;
};

type DownloadedImage = {
  url: string;
  mimeType: string;
  data: string;
};

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const productionImageReviewBudget = new ExternalCallBudget(
  {
    productImageReview: positiveInt(process.env.GEMINI_PRODUCT_IMAGE_REVIEW_HOURLY_BUDGET, 72),
  },
  60 * 60 * 1000,
);

// Image classification is a high-throughput multimodal task and must not
// implicitly inherit the copy/curation model. A dedicated env override remains
// available, but the safe production default is the GA Flash-Lite model.
const CURRENT_IMAGE_REVIEW_MODEL = "gemini-3.5-flash-lite";
const SECONDARY_IMAGE_REVIEW_MODEL = "gemini-3.7-flash";
const LEGACY_IMAGE_REVIEW_MODELS = new Set(["gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"]);

function resolveImageReviewModel(env: NodeJS.ProcessEnv): string {
  const configured = String(env.GEMINI_PRODUCT_IMAGE_REVIEW_MODEL || "").trim();
  if (!configured || LEGACY_IMAGE_REVIEW_MODELS.has(configured)) return CURRENT_IMAGE_REVIEW_MODEL;
  return configured;
}

function resolveImageReviewFallbackModel(env: NodeJS.ProcessEnv, primaryModel: string): string | null {
  const explicit = String(env.GEMINI_PRODUCT_IMAGE_REVIEW_FALLBACK_MODEL || "").trim();
  const configured = explicit || (primaryModel === CURRENT_IMAGE_REVIEW_MODEL ? SECONDARY_IMAGE_REVIEW_MODEL : CURRENT_IMAGE_REVIEW_MODEL);
  if (!configured || configured === primaryModel) return null;
  return configured;
}

function providerErrorText(error: unknown): string {
  return String(error instanceof Error ? error.message : error || "").toLowerCase();
}

function permanentProviderFailure(error: unknown): boolean {
  const message = providerErrorText(error);
  return [
    "401",
    "403",
    "404",
    "not found",
    "model_not_found",
    "model not found",
    "api key not valid",
    "api_key_invalid",
    "permission denied",
    "permission_denied",
    "unauthenticated",
  ].some(marker => message.includes(marker));
}

function quotaProviderFailure(error: unknown): boolean {
  const message = providerErrorText(error);
  return [
    "quota exceeded",
    "quota_exceeded",
    "daily quota",
    "requests per day",
    "rpd",
  ].some(marker => message.includes(marker));
}

function transientProviderFailure(error: unknown): boolean {
  const message = providerErrorText(error);
  return [
    "429",
    "resource_exhausted",
    "rate limit",
    "rate_limit",
    "too many requests",
    "too_many_requests",
    "500",
    "503",
    "api_error",
    "service unavailable",
    "service_unavailable",
    "deadline exceeded",
    "deadline_exceeded",
    "timeout",
    "timed out",
    "overloaded",
  ].some(marker => message.includes(marker));
}

function reviewRequired(
  rawImageUrls: string[],
  reason: NonNullable<ProductImageCuration["reason"]>,
  assessments: ProductImageAssessment[] = [],
): ProductImageCuration {
  return {
    status: "review_required",
    rawImageUrls,
    galleryImageUrls: [],
    assessments,
    reason,
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadImage(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<DownloadedImage | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: {
          Accept: "image/avif,image/webp,image/jpeg,image/png",
          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.7",
          "User-Agent": "Mozilla/5.0 (compatible; CerberusFinds/1.0; +https://cerberusfinds.com)",
        },
        signal: controller.signal,
      });
      const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "";
      if (!response.ok || !/^image\/(?:avif|webp|jpeg|png)$/.test(mimeType)) {
        if (attempt === 0 && response.status >= 500) {
          await delay(120);
          continue;
        }
        return null;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) return null;
      return { url, mimeType, data: bytes.toString("base64") };
    } catch {
      if (attempt === 0) {
        await delay(120);
        continue;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function downloadReviewableImages(
  rawImageUrls: string[],
  fetchImpl: typeof fetch,
  maxImages: number,
  timeoutMs: number,
): Promise<DownloadedImage[]> {
  const selected = rawImageUrls.slice(0, Math.max(1, maxImages));
  const outcomes = await Promise.all(selected.map(url => downloadImage(url, fetchImpl, timeoutMs)));
  return outcomes.filter((item): item is DownloadedImage => Boolean(item));
}

function parseAssessments(rawImageUrls: string[], downloaded: DownloadedImage[], value: unknown): ProductImageAssessment[] {
  const parsed = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const modelAssessments = Array.isArray(parsed.images) ? parsed.images : [];
  const allowedDecisions = new Set<ProductImageAssessment["decision"]>([
    "clean", "technical", "promotional", "logo", "collage", "screenshot", "unknown",
  ]);
  const allowedConfidence = new Set<ProductImageAssessment["confidence"]>(["HIGH", "MEDIUM", "LOW"]);

  return downloaded.map((image, index) => {
    const item = modelAssessments.find(candidate =>
      candidate && typeof candidate === "object" && Number((candidate as Record<string, unknown>).index) === index + 1,
    ) as Record<string, unknown> | undefined;
    const decisionText = String(item?.decision || "unknown") as ProductImageAssessment["decision"];
    const confidenceText = String(item?.confidence || "LOW") as ProductImageAssessment["confidence"];
    return {
      url: image.url,
      decision: allowedDecisions.has(decisionText) ? decisionText : "unknown",
      confidence: allowedConfidence.has(confidenceText) ? confidenceText : "LOW",
      reason: typeof item?.reason === "string" ? item.reason.slice(0, 180) : "Avaliação visual insuficiente.",
    };
  }).filter(item => rawImageUrls.includes(item.url));
}

function parseModelJson(text: string | null | undefined): unknown {
  const value = String(text || "").trim();
  if (!value) throw new Error("IMAGE_REVIEW_EMPTY_RESPONSE");
  try {
    return JSON.parse(value);
  } catch {
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value);
    if (!fenced) throw new Error("IMAGE_REVIEW_INVALID_JSON");
    return JSON.parse(fenced[1]);
  }
}

function buildReviewRequest(images: DownloadedImage[], title: string, model: string): Record<string, unknown> {
  const prompt = `Avalie TODAS as imagens numeradas deste produto para seleção comercial de catálogo. Produto: ${title || "sem título"}. Para cada imagem, classifique somente como clean, technical, promotional, logo, collage, screenshot ou unknown. Rejeite medidas, dimensões, setas, textos promocionais, selos, logos, marcas d'água, molduras técnicas, colagens e screenshots. clean exige apresentação clara do produto, sem overlay visível, com confiança HIGH ou MEDIUM. Não invente características. Retorne JSON: {"images":[{"index":1,"decision":"clean|technical|promotional|logo|collage|screenshot|unknown","confidence":"HIGH|MEDIUM|LOW","reason":"motivo factual curto"}]}. Inclua exatamente uma entrada para cada imagem recebida.`;
  return {
    model,
    contents: [{
      role: "user",
      parts: [
        { text: prompt },
        ...images.map(image => ({ inlineData: { mimeType: image.mimeType, data: image.data } })),
      ],
    }],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          images: {
            type: "array",
            items: {
              type: "object",
              properties: {
                index: { type: "integer" },
                decision: { type: "string", enum: ["clean", "technical", "promotional", "logo", "collage", "screenshot", "unknown"] },
                confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
                reason: { type: "string" },
              },
              required: ["index", "decision", "confidence", "reason"],
            },
          },
        },
        required: ["images"],
      },
    },
  };
}

async function reviewWithProvider(input: {
  rawImageUrls: string[];
  downloaded: DownloadedImage[];
  title: string;
  model: string;
  fallbackModel?: string | null;
  generateContent: GenerateContent;
  budget: BudgetLike;
  delayImpl?: DelayImpl;
}): Promise<ProductImageAssessment[]> {
  const delayImpl = input.delayImpl || delay;

  const callBatch = async (model: string, reserveCall: boolean): Promise<{ assessments: ProductImageAssessment[] | null; error: unknown | null; budgetExhausted: boolean }> => {
    if (reserveCall) {
      const reserved = input.budget.reserve("productImageReview");
      if (!reserved.allowed) return { assessments: null, error: null, budgetExhausted: true };
    }
    try {
      const response = await input.generateContent(buildReviewRequest(input.downloaded, input.title, model));
      return {
        assessments: parseAssessments(input.rawImageUrls, input.downloaded, parseModelJson(response.text)),
        error: null,
        budgetExhausted: false,
      };
    } catch (error) {
      return { assessments: null, error, budgetExhausted: false };
    }
  };

  let batch = await callBatch(input.model, false);
  if (batch.assessments) return batch.assessments;
  if (batch.budgetExhausted) return [];
  const lastError = batch.error;

  if (permanentProviderFailure(lastError)) return [];

  // Provider/rate-limit failures affect the whole batch, not the individual
  // image. Avoid repeatedly charging the same throttled model. After one
  // short backoff, fail over once to the alternate multimodal model.
  if ((transientProviderFailure(lastError) || quotaProviderFailure(lastError)) && input.fallbackModel) {
    await delayImpl(2_000);
    batch = await callBatch(input.fallbackModel, true);
    if (batch.assessments) return batch.assessments;
    return [];
  }
  if (transientProviderFailure(lastError) || quotaProviderFailure(lastError)) return [];

  // Um payload multimodal ruim não pode derrubar todas as imagens válidas.
  // Reavalia individualmente somente para falhas de payload/parse não
  // classificadas como provider/rate-limit, cobrando budget por chamada extra.
  const isolated: ProductImageAssessment[] = [];
  for (const image of input.downloaded) {
    const reserved = input.budget.reserve("productImageReview");
    if (!reserved.allowed) break;
    try {
      const response = await input.generateContent(buildReviewRequest([image], input.title, input.model));
      isolated.push(...parseAssessments(input.rawImageUrls, [image], parseModelJson(response.text)));
    } catch {
      // Falha desta imagem permanece isolada. Nenhuma decisão é inventada.
    }
  }
  return isolated;
}

export async function reviewProductImages(
  rawImages: readonly string[],
  title: string,
  options: ReviewOptions = {},
): Promise<ProductImageCuration> {
  const rawImageUrls = curateProductImages(rawImages).rawImageUrls;
  if (rawImageUrls.length === 0) return curateProductImages(rawImageUrls);

  const env = options.env || process.env;
  const apiKey = String(env.GEMINI_API_KEY || "").trim();
  if (!apiKey) return reviewRequired(rawImageUrls, "image_review_unavailable");

  const budget = options.budget || productionImageReviewBudget;
  const reserved = budget.reserve("productImageReview");
  if (!reserved.allowed) return reviewRequired(rawImageUrls, "image_review_budget_exhausted");

  const fetchImpl = options.fetchImpl || fetch;
  const maxImages = options.maxImages || positiveInt(env.GEMINI_PRODUCT_IMAGE_REVIEW_MAX_IMAGES, 6);
  const timeoutMs = options.timeoutMs || positiveInt(env.GEMINI_PRODUCT_IMAGE_FETCH_TIMEOUT_MS, 10_000);
  const downloaded = await downloadReviewableImages(rawImageUrls, fetchImpl, maxImages, timeoutMs);
  if (downloaded.length === 0) return reviewRequired(rawImageUrls, "image_fetch_unavailable");

  const model = resolveImageReviewModel(env);
  const fallbackModel = resolveImageReviewFallbackModel(env, model);
  const generateContent: GenerateContent = options.generateContent || (async input => {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } },
    });
    return ai.models.generateContent(input as any) as Promise<{ text?: string | null }>;
  });

  const assessments = await reviewWithProvider({
    rawImageUrls,
    downloaded,
    title,
    model,
    fallbackModel,
    generateContent,
    budget,
    delayImpl: options.delayImpl,
  });
  if (assessments.length === 0) {
    console.warn(`[Product Image Review] provider indisponível para lote e imagens isoladas (model=${model}, fallback=${fallbackModel || "none"})`);
    return reviewRequired(rawImageUrls, "image_review_model_unavailable");
  }

  const curation = curateProductImages(rawImageUrls, assessments);
  if (curation.status === "ready" || options.allowRepair === false) return curation;

  const repairImage = options.repairImage || repairProductImage;
  const repaired = await repairImage({
    rawImageUrls: downloaded.map(image => image.url),
    title,
    assessments,
    env,
    fetchImpl,
  });
  if (!repaired) return curation;

  // Generated/edited imagery is never trusted directly. It must pass the
  // exact same reviewer once more before it can become canonical.
  const repairedCuration = await reviewProductImages([repaired.url], title, {
    ...options,
    env,
    fetchImpl,
    budget,
    allowRepair: false,
  });
  if (repairedCuration.status !== "ready" || !repairedCuration.primaryImageUrl) return curation;
  return {
    status: "ready",
    rawImageUrls: [...rawImageUrls, repaired.url],
    primaryImageUrl: repairedCuration.primaryImageUrl,
    galleryImageUrls: repairedCuration.galleryImageUrls,
    assessments: [...assessments, ...repairedCuration.assessments],
  };
}

export const productImageReviewInternals = {
  downloadImage,
  downloadReviewableImages,
  parseAssessments,
  parseModelJson,
  buildReviewRequest,
  reviewWithProvider,
  resolveImageReviewModel,
  resolveImageReviewFallbackModel,
  permanentProviderFailure,
  quotaProviderFailure,
  transientProviderFailure,
  positiveInt,
};
