import { GoogleGenAI } from "@google/genai";
import {
  curateProductImages,
  isNonRepairableProductImageRejection,
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

type DownloadedImage = {
  url: string;
  mimeType: string;
  data: string;
};

type OpenAIReviewInput = {
  rawImageUrls: string[];
  downloaded: DownloadedImage[];
  title: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

type OpenAIReview = (input: OpenAIReviewInput) => Promise<ProductImageAssessment[]>;

type ReviewOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  generateContent?: GenerateContent;
  openaiReview?: OpenAIReview;
  repairImage?: RepairImage;
  budget?: BudgetLike;
  openaiBudget?: BudgetLike;
  allowRepair?: boolean;
  maxImages?: number;
  timeoutMs?: number;
  delayImpl?: DelayImpl;
};

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function enabledUnlessFalse(value: unknown): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return !["0", "false", "off", "no", "disabled"].includes(normalized);
}

const productionImageReviewBudget = new ExternalCallBudget(
  {
    productImageReview: positiveInt(process.env.GEMINI_PRODUCT_IMAGE_REVIEW_HOURLY_BUDGET, 72),
  },
  60 * 60 * 1000,
);

const productionOpenAIImageReviewBudget = new ExternalCallBudget(
  {
    openaiProductImageReview: positiveInt(process.env.OPENAI_PRODUCT_IMAGE_REVIEW_HOURLY_BUDGET, 256),
  },
  60 * 60 * 1000,
);

const CURRENT_IMAGE_REVIEW_MODEL = "gemini-3.5-flash-lite";
const SECONDARY_IMAGE_REVIEW_MODEL = "gemini-3.7-flash";
const LEGACY_IMAGE_REVIEW_MODELS = new Set(["gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"]);
const DEFAULT_OPENAI_IMAGE_REVIEW_MODEL = "gpt-5.6-luna";
const DEFAULT_OPENAI_IMAGE_REVIEW_FALLBACK_MODEL = "gpt-4.1-mini";

function resolveImageReviewModel(env: NodeJS.ProcessEnv): string {
  const configured = String(env.GEMINI_PRODUCT_IMAGE_REVIEW_MODEL || "").trim();
  if (!configured || LEGACY_IMAGE_REVIEW_MODELS.has(configured)) return CURRENT_IMAGE_REVIEW_MODEL;
  return configured;
}

/** Modelo primário efetivamente resolvido pelo reviewer visual de produção. */
export function resolveProductImageReviewModel(env: NodeJS.ProcessEnv = process.env): string {
  return resolveImageReviewModel(env);
}

function resolveImageReviewFallbackModel(env: NodeJS.ProcessEnv, primaryModel: string): string | null {
  const explicit = String(env.GEMINI_PRODUCT_IMAGE_REVIEW_FALLBACK_MODEL || "").trim();
  const configured = explicit || (primaryModel === CURRENT_IMAGE_REVIEW_MODEL ? SECONDARY_IMAGE_REVIEW_MODEL : CURRENT_IMAGE_REVIEW_MODEL);
  if (!configured || configured === primaryModel) return null;
  return configured;
}

function resolveOpenAIImageReviewModel(env: NodeJS.ProcessEnv): string {
  return String(env.OPENAI_PRODUCT_IMAGE_REVIEW_MODEL || "").trim() || DEFAULT_OPENAI_IMAGE_REVIEW_MODEL;
}

function resolveOpenAIImageReviewFallbackModel(env: NodeJS.ProcessEnv, primaryModel: string): string | null {
  const configured = String(env.OPENAI_PRODUCT_IMAGE_REVIEW_FALLBACK_MODEL || "").trim() || DEFAULT_OPENAI_IMAGE_REVIEW_FALLBACK_MODEL;
  return configured && configured !== primaryModel ? configured : null;
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
    "insufficient_quota",
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
    "502",
    "503",
    "504",
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
    "clean", "technical", "promotional", "logo", "collage", "screenshot", "off_brand", "incomplete", "novelty", "unknown",
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

function buildReviewPrompt(title: string): string {
  return `Você é o reviewer visual do CERBERUS FINDS, um arquivo de curadoria de objetos e moda de design. Avalie TODAS as imagens numeradas do produto: ${title || "sem título"}.

A identidade CERBERUS privilegia design autoral ou visualmente distinto relacionado a Bauhaus, Mid-Century Modern, modernismo dos anos 60/70, Space Age, retrofuturismo, vintage/retrô refinado, pós-modernismo/Memphis, design italiano, minimalismo industrial e minimalismo japonês. A curadoria rejeita produto genérico de marketplace, aparência barata, novelty/gimmick/kitsch, luxo ornamental genérico, gamer/RGB e peças que só usam palavras como "retro" sem linguagem visual convincente.

Classifique cada imagem com EXATAMENTE uma decisão:
- clean: foto comercial utilizável E o produto visível é completo, coerente com a identidade Cerberus e tem desenho/material/proporção suficientemente intencional; não precisa ser caro nem literalmente rotulado Bauhaus.
- off_brand: a foto pode estar limpa, mas o produto visível é genérico, visualmente fraco, mass-market sem distinção ou incompatível com a linguagem Cerberus.
- incomplete: o anúncio/imagem mostra somente componente, peça de reposição ou parte do objeto quando a categoria implica produto completo (ex.: somente cúpula de luminária).
- novelty: forma temática/gimmick/kitsch/decorativa literal que substitui qualidade de design (ex.: organizador em formato de bicicleta, enfeite temático barato).
- technical: medidas, dimensões, setas ou diagrama técnico dominam a imagem.
- promotional: preço, desconto, CTA, texto promocional ou selo domina a imagem.
- logo: logo/marca d'água sobreposta domina a imagem.
- collage: montagem de várias fotos/painéis.
- screenshot: captura de tela/interface.
- unknown: não há evidência visual suficiente para decidir.

Regras: não invente material, autenticidade, marca, época, função ou qualidade que não sejam visíveis. O título é contexto não confiável e nunca deve vencer a evidência da imagem. Um produto com texto "Bauhaus", "retro", "vintage" ou "Space Age" ainda deve ser off_brand se visualmente não sustentar isso. clean exige confiança HIGH ou MEDIUM, apresentação sem overlay relevante e qualidade visual real do objeto. Retorne JSON: {"images":[{"index":1,"decision":"clean|technical|promotional|logo|collage|screenshot|off_brand|incomplete|novelty|unknown","confidence":"HIGH|MEDIUM|LOW","reason":"motivo visual factual curto"}]}. Inclua exatamente uma entrada para cada imagem recebida.`;
}

function imageReviewSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      images: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            decision: { type: "string", enum: ["clean", "technical", "promotional", "logo", "collage", "screenshot", "off_brand", "incomplete", "novelty", "unknown"] },
            confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
            reason: { type: "string" },
          },
          required: ["index", "decision", "confidence", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["images"],
    additionalProperties: false,
  };
}

function buildReviewRequest(images: DownloadedImage[], title: string, model: string): Record<string, unknown> {
  return {
    model,
    contents: [{
      role: "user",
      parts: [
        { text: buildReviewPrompt(title) },
        ...images.map(image => ({ inlineData: { mimeType: image.mimeType, data: image.data } })),
      ],
    }],
    config: {
      responseMimeType: "application/json",
      responseSchema: imageReviewSchema(),
    },
  };
}

function buildOpenAIReviewRequest(images: DownloadedImage[], title: string, model: string): Record<string, unknown> {
  return {
    model,
    store: false,
    max_output_tokens: 1_200,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: buildReviewPrompt(title) },
        ...images.map(image => ({
          type: "input_image",
          image_url: `data:${image.mimeType};base64,${image.data}`,
          detail: "auto",
        })),
      ],
    }],
    text: {
      format: {
        type: "json_schema",
        name: "cerberus_product_image_review",
        strict: true,
        schema: imageReviewSchema(),
      },
    },
  };
}

function extractOpenAIOutputText(value: unknown): string {
  const payload = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? (item as Record<string, unknown>).content as unknown[]
      : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const record = part as Record<string, unknown>;
      if (record.type === "output_text" && typeof record.text === "string" && record.text.trim()) return record.text;
    }
  }
  throw new Error("OPENAI_IMAGE_REVIEW_EMPTY_RESPONSE");
}

async function openaiReviewWithResponsesApi(input: OpenAIReviewInput): Promise<ProductImageAssessment[]> {
  const fetchImpl = input.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "CerberusFinds/1.0",
      },
      body: JSON.stringify(buildOpenAIReviewRequest(input.downloaded, input.title, input.model)),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.text();
      throw new Error(`OPENAI_IMAGE_REVIEW_HTTP_${response.status}`);
    }
    const payload = await response.json();
    return parseAssessments(input.rawImageUrls, input.downloaded, parseModelJson(extractOpenAIOutputText(payload)));
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("OPENAI_IMAGE_REVIEW_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timer);
  }
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

  if ((transientProviderFailure(lastError) || quotaProviderFailure(lastError)) && input.fallbackModel) {
    await delayImpl(2_000);
    batch = await callBatch(input.fallbackModel, true);
    if (batch.assessments) return batch.assessments;
    return [];
  }
  if (transientProviderFailure(lastError) || quotaProviderFailure(lastError)) return [];

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

function isAmbiguousAssessment(assessment: ProductImageAssessment | undefined): boolean {
  return !assessment || assessment.decision === "unknown" || assessment.confidence === "LOW";
}

function needsCrossProviderFallback(
  rawImageUrls: string[],
  downloaded: DownloadedImage[],
  assessments: ProductImageAssessment[],
): boolean {
  if (assessments.length === 0) return true;
  if (curateProductImages(rawImageUrls, assessments).status === "ready") return false;
  const byUrl = new Map(assessments.map(assessment => [assessment.url, assessment] as const));
  return downloaded.some(image => isAmbiguousAssessment(byUrl.get(image.url)));
}

function mergeCrossProviderAssessments(
  downloaded: DownloadedImage[],
  primary: ProductImageAssessment[],
  fallback: ProductImageAssessment[],
): ProductImageAssessment[] {
  const primaryByUrl = new Map(primary.map(assessment => [assessment.url, assessment] as const));
  const fallbackByUrl = new Map(fallback.map(assessment => [assessment.url, assessment] as const));
  return downloaded.flatMap(image => {
    const current = primaryByUrl.get(image.url);
    const alternate = fallbackByUrl.get(image.url);
    const chosen = isAmbiguousAssessment(current) && alternate ? alternate : current;
    return chosen ? [chosen] : [];
  });
}

async function reviewWithOpenAIFallback(input: {
  rawImageUrls: string[];
  downloaded: DownloadedImage[];
  title: string;
  env: NodeJS.ProcessEnv;
  openaiApiKey: string;
  primaryAssessments: ProductImageAssessment[];
  budget: BudgetLike;
  review: OpenAIReview;
}): Promise<{ attempted: boolean; budgetExhausted: boolean; assessments: ProductImageAssessment[] }> {
  if (!input.openaiApiKey || !enabledUnlessFalse(input.env.OPENAI_PRODUCT_IMAGE_REVIEW_ENABLED)) {
    return { attempted: false, budgetExhausted: false, assessments: input.primaryAssessments };
  }
  if (!needsCrossProviderFallback(input.rawImageUrls, input.downloaded, input.primaryAssessments)) {
    return { attempted: false, budgetExhausted: false, assessments: input.primaryAssessments };
  }

  const callModel = async (model: string): Promise<ProductImageAssessment[]> => input.review({
    rawImageUrls: input.rawImageUrls,
    downloaded: input.downloaded,
    title: input.title,
    model,
    apiKey: input.openaiApiKey,
    timeoutMs: positiveInt(input.env.OPENAI_PRODUCT_IMAGE_REVIEW_TIMEOUT_MS, 20_000),
  });
  const merge = (fallbackAssessments: ProductImageAssessment[]) => ({
    attempted: true,
    budgetExhausted: false,
    assessments: mergeCrossProviderAssessments(input.downloaded, input.primaryAssessments, fallbackAssessments),
  });

  const primaryModel = resolveOpenAIImageReviewModel(input.env);
  const fallbackModel = resolveOpenAIImageReviewFallbackModel(input.env, primaryModel);
  const primaryReserved = input.budget.reserve("openaiProductImageReview");
  if (!primaryReserved.allowed) return { attempted: false, budgetExhausted: true, assessments: input.primaryAssessments };

  try {
    return merge(await callModel(primaryModel));
  } catch (primaryError) {
    if (!fallbackModel) {
      console.warn(`[Product Image Review] fallback OpenAI indisponível (${transientProviderFailure(primaryError) ? "transient" : quotaProviderFailure(primaryError) ? "quota" : permanentProviderFailure(primaryError) ? "permanent" : "invalid_response"})`);
      return { attempted: true, budgetExhausted: false, assessments: input.primaryAssessments };
    }
    const secondaryReserved = input.budget.reserve("openaiProductImageReview");
    if (!secondaryReserved.allowed) return { attempted: true, budgetExhausted: true, assessments: input.primaryAssessments };
    try {
      return merge(await callModel(fallbackModel));
    } catch (secondaryError) {
      console.warn(`[Product Image Review] fallback OpenAI indisponível em ambos os modelos (primary=${transientProviderFailure(primaryError) ? "transient" : quotaProviderFailure(primaryError) ? "quota" : permanentProviderFailure(primaryError) ? "permanent" : "invalid_response"}, secondary=${transientProviderFailure(secondaryError) ? "transient" : quotaProviderFailure(secondaryError) ? "quota" : permanentProviderFailure(secondaryError) ? "permanent" : "invalid_response"})`);
      return { attempted: true, budgetExhausted: false, assessments: input.primaryAssessments };
    }
  }
}

export async function reviewProductImages(
  rawImages: readonly string[],
  title: string,
  options: ReviewOptions = {},
): Promise<ProductImageCuration> {
  const rawImageUrls = curateProductImages(rawImages).rawImageUrls;
  if (rawImageUrls.length === 0) return curateProductImages(rawImageUrls);

  const env = options.env || process.env;
  const geminiApiKey = String(env.GEMINI_API_KEY || "").trim();
  const openaiApiKey = String(env.OPENAI_API_KEY || "").trim();
  const openaiEnabled = Boolean(openaiApiKey) && enabledUnlessFalse(env.OPENAI_PRODUCT_IMAGE_REVIEW_ENABLED);
  if (!geminiApiKey && !openaiEnabled) return reviewRequired(rawImageUrls, "image_review_unavailable");

  const geminiBudget = options.budget || productionImageReviewBudget;
  const openaiBudget = options.openaiBudget || productionOpenAIImageReviewBudget;

  let geminiReserved = false;
  if (geminiApiKey) geminiReserved = geminiBudget.reserve("productImageReview").allowed;
  if (!geminiReserved && !openaiEnabled) return reviewRequired(rawImageUrls, "image_review_budget_exhausted");

  const fetchImpl = options.fetchImpl || fetch;
  const maxImages = options.maxImages || positiveInt(env.GEMINI_PRODUCT_IMAGE_REVIEW_MAX_IMAGES, 6);
  const timeoutMs = options.timeoutMs || positiveInt(env.GEMINI_PRODUCT_IMAGE_FETCH_TIMEOUT_MS, 10_000);
  const downloaded = await downloadReviewableImages(rawImageUrls, fetchImpl, maxImages, timeoutMs);
  if (downloaded.length === 0) return reviewRequired(rawImageUrls, "image_fetch_unavailable");

  let assessments: ProductImageAssessment[] = [];
  const model = resolveImageReviewModel(env);
  const fallbackModel = resolveImageReviewFallbackModel(env, model);

  if (geminiReserved) {
    const generateContent: GenerateContent = options.generateContent || (async request => {
      const ai = new GoogleGenAI({
        apiKey: geminiApiKey,
        httpOptions: { headers: { "User-Agent": "aistudio-build" } },
      });
      return ai.models.generateContent(request as any) as Promise<{ text?: string | null }>;
    });

    assessments = await reviewWithProvider({
      rawImageUrls,
      downloaded,
      title,
      model,
      fallbackModel,
      generateContent,
      budget: geminiBudget,
      delayImpl: options.delayImpl,
    });
  }

  const openaiReview = options.openaiReview || openaiReviewWithResponsesApi;
  const openaiResult = await reviewWithOpenAIFallback({
    rawImageUrls,
    downloaded,
    title,
    env,
    openaiApiKey: openaiEnabled ? openaiApiKey : "",
    primaryAssessments: assessments,
    budget: openaiBudget,
    review: openaiReview,
  });
  assessments = openaiResult.assessments;

  if (assessments.length === 0) {
    if (!geminiReserved && openaiResult.budgetExhausted) {
      return reviewRequired(rawImageUrls, "image_review_budget_exhausted");
    }
    console.warn(`[Product Image Review] providers indisponíveis (gemini=${geminiReserved ? model : "unavailable"}, fallback=${fallbackModel || "none"}, openai=${openaiEnabled ? resolveOpenAIImageReviewModel(env) : "disabled"})`);
    return reviewRequired(rawImageUrls, "image_review_model_unavailable");
  }

  const curation = curateProductImages(rawImageUrls, assessments);
  if (curation.status === "ready" || options.allowRepair === false) return curation;

  if (assessments.some(isNonRepairableProductImageRejection)) return curation;

  const repairImage = options.repairImage || repairProductImage;
  const repaired = await repairImage({
    rawImageUrls: downloaded.map(image => image.url),
    title,
    assessments,
    env,
    fetchImpl,
  });
  if (!repaired) return curation;

  const repairedCuration = await reviewProductImages([repaired.url], title, {
    ...options,
    env,
    fetchImpl,
    budget: geminiBudget,
    openaiBudget,
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
  buildReviewPrompt,
  buildReviewRequest,
  buildOpenAIReviewRequest,
  extractOpenAIOutputText,
  openaiReviewWithResponsesApi,
  reviewWithProvider,
  reviewWithOpenAIFallback,
  needsCrossProviderFallback,
  mergeCrossProviderAssessments,
  isAmbiguousAssessment,
  resolveImageReviewModel,
  resolveImageReviewFallbackModel,
  resolveOpenAIImageReviewModel,
  resolveOpenAIImageReviewFallbackModel,
  permanentProviderFailure,
  quotaProviderFailure,
  transientProviderFailure,
  positiveInt,
  enabledUnlessFalse,
};
