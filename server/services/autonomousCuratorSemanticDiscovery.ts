import { GoogleGenAI, Type } from "@google/genai";
import type { AutonomousCuratorCategoryProfile } from "./autonomousCuratorProfiles";
import { ExternalCallBudget, type BudgetDecision } from "./operationalGuards";
import { callOpenAIResponses, OpenAIProviderError } from "./openAIProviderRuntime";

type BudgetLike = {
  reserve(name: string, amount?: number): BudgetDecision;
};

type GeminiGenerate = (request: Record<string, unknown>) => Promise<{ text?: string | null }>;

type SemanticOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  budget?: BudgetLike;
  geminiGenerate?: GeminiGenerate;
};

export type SemanticDiscoveryCandidate = {
  identityKey: string;
  name: string;
  query: string;
  page: number;
  price: number | null;
  imageUrl: string | null;
  lexicalScore: number;
};

export type SemanticDiscoveryDecision = {
  identityKey: string;
  fitScore: number;
  categoryFit: number;
  worthEnriching: boolean;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  signals: string[];
  reason: string;
};

export type SemanticDiscoveryRankingResult = {
  status: "ok" | "disabled" | "budget_exhausted" | "unavailable";
  model: string | null;
  decisions: SemanticDiscoveryDecision[];
};

const DEFAULT_MODEL = "gpt-5.6-luna";
const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_GEMINI_FALLBACK_MODEL = "gemini-3.5-flash-lite";
const QUERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const queryExpansionCache = new Map<string, { expiresAt: number; queries: string[] }>();

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

function enabledUnlessFalse(value: unknown): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return !["0", "false", "off", "no", "disabled"].includes(normalized);
}

function resolveModel(env: NodeJS.ProcessEnv): string {
  return String(env.OPENAI_AUTONOMOUS_DISCOVERY_MODEL || "").trim() || DEFAULT_MODEL;
}

function resolveGeminiModel(env: NodeJS.ProcessEnv): string {
  return String(env.GEMINI_AUTONOMOUS_DISCOVERY_MODEL || env.GEMINI_PRODUCT_IMAGE_REVIEW_MODEL || "").trim() || DEFAULT_GEMINI_MODEL;
}

function resolveGeminiModels(env: NodeJS.ProcessEnv): string[] {
  const primary = resolveGeminiModel(env);
  const fallback = String(
    env.GEMINI_AUTONOMOUS_DISCOVERY_FALLBACK_MODEL
    || env.GEMINI_PRODUCT_IMAGE_REVIEW_FALLBACK_MODEL
    || DEFAULT_GEMINI_FALLBACK_MODEL,
  ).trim();
  return [...new Set([primary, fallback].filter(Boolean))];
}

const productionBudget = new ExternalCallBudget(
  {
    openaiAutonomousDiscovery: positiveInt(process.env.OPENAI_AUTONOMOUS_DISCOVERY_HOURLY_BUDGET, 72, 240),
    geminiAutonomousDiscovery: positiveInt(process.env.GEMINI_AUTONOMOUS_DISCOVERY_HOURLY_BUDGET, 72, 240),
  },
  60 * 60 * 1000,
);

function extractOutputText(value: unknown): string {
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
  throw new Error("OPENAI_AUTONOMOUS_DISCOVERY_EMPTY_RESPONSE");
}

function parseJson(text: string): unknown {
  const value = text.trim();
  if (!value) throw new Error("OPENAI_AUTONOMOUS_DISCOVERY_EMPTY_RESPONSE");
  try {
    return JSON.parse(value);
  } catch {
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value);
    if (!fenced) throw new Error("OPENAI_AUTONOMOUS_DISCOVERY_INVALID_JSON");
    return JSON.parse(fenced[1]);
  }
}

async function callResponsesApi(input: {
  apiKey: string;
  model: string;
  timeoutMs: number;
  schemaName: string;
  schema: Record<string, unknown>;
  content: Array<Record<string, unknown>>;
  maxOutputTokens: number;
  fetchImpl: typeof fetch;
  env: NodeJS.ProcessEnv;
}): Promise<unknown> {
  const request = {
    model: input.model,
    store: false,
    reasoning: { effort: "none" },
    max_output_tokens: input.maxOutputTokens,
    input: [{ role: "user", content: input.content }],
    text: {
      format: {
        type: "json_schema",
        name: input.schemaName,
        strict: true,
        schema: input.schema,
      },
    },
  };
  const payload = await callOpenAIResponses({
    apiKey: input.apiKey,
    request,
    timeoutMs: input.timeoutMs,
    fetchImpl: input.fetchImpl,
    maxAttempts: positiveInt(input.env.OPENAI_AUTONOMOUS_DISCOVERY_MAX_ATTEMPTS, 4, 6),
    maxConcurrency: positiveInt(input.env.OPENAI_GLOBAL_MAX_CONCURRENCY, 2, 8),
  });
  return parseJson(extractOutputText(payload));
}

function geminiGenerateFor(apiKey: string, injected?: GeminiGenerate): GeminiGenerate {
  if (injected) return injected;
  return async (request: Record<string, unknown>) => {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } },
    });
    return ai.models.generateContent(request as any) as Promise<{ text?: string | null }>;
  };
}

async function callGeminiQueryExpansion(input: {
  apiKey: string;
  model: string;
  prompt: string;
  maxQueries: number;
  generate?: GeminiGenerate;
}): Promise<unknown> {
  const response = await geminiGenerateFor(input.apiKey, input.generate)({
    model: input.model,
    contents: input.prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          queries: {
            type: Type.ARRAY,
            maxItems: input.maxQueries,
            items: { type: Type.STRING },
          },
        },
        required: ["queries"],
      },
    },
  });
  return parseJson(String(response.text || ""));
}

async function callGeminiSemanticRanking(input: {
  apiKey: string;
  model: string;
  prompt: string;
  identityKeys: string[];
  generate?: GeminiGenerate;
}): Promise<unknown> {
  const response = await geminiGenerateFor(input.apiKey, input.generate)({
    model: input.model,
    contents: input.prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          decisions: {
            type: Type.ARRAY,
            maxItems: input.identityKeys.length,
            items: {
              type: Type.OBJECT,
              properties: {
                // Keep the Gemini schema compact. Exact identity and semantic
                // value constraints are enforced after parsing by normalizeDecision.
                identityKey: { type: Type.STRING },
                fitScore: { type: Type.INTEGER, minimum: 0, maximum: 100 },
                categoryFit: { type: Type.INTEGER, minimum: 0, maximum: 100 },
                worthEnriching: { type: Type.BOOLEAN },
                confidence: { type: Type.STRING },
                signals: {
                  type: Type.ARRAY,
                  maxItems: 4,
                  items: { type: Type.STRING },
                },
                reason: { type: Type.STRING },
              },
              required: ["identityKey", "fitScore", "categoryFit", "worthEnriching", "confidence", "signals", "reason"],
            },
          },
        },
        required: ["decisions"],
      },
    },
  });
  return parseJson(String(response.text || ""));
}

function safeProviderReason(error: unknown): string {
  if (error instanceof OpenAIProviderError) return error.code;
  return error instanceof Error ? error.message.slice(0, 120) : "PROVIDER_UNAVAILABLE";
}

function sanitizeQuery(value: unknown): string | null {
  const query = String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
  const words = query.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 10) return null;
  return query;
}

function expansionCacheKey(profile: AutonomousCuratorCategoryProfile, existingQueries: readonly string[]): string {
  const normalized = existingQueries.map(query => query.toLowerCase().trim()).filter(Boolean).sort();
  return `${profile.category}|${normalized.join("|")}`;
}

function normalizeExpandedQueries(parsed: { queries?: unknown[] }, existingQueries: readonly string[], maxQueries: number): string[] {
  const existing = new Set(existingQueries.map(item => item.toLowerCase().trim()));
  return [...new Set((Array.isArray(parsed.queries) ? parsed.queries : [])
    .map(sanitizeQuery)
    .filter((item): item is string => Boolean(item))
    .filter(item => !existing.has(item.toLowerCase())))]
    .slice(0, maxQueries);
}

export async function expandAutonomousCuratorQueries(
  profile: AutonomousCuratorCategoryProfile,
  existingQueries: readonly string[],
  options: SemanticOptions = {},
): Promise<string[]> {
  const env = options.env || process.env;
  if (!enabledUnlessFalse(env.OPENAI_AUTONOMOUS_QUERY_EXPANSION_ENABLED)) return [];
  const openAIApiKey = String(env.OPENAI_API_KEY || "").trim();
  const geminiApiKey = String(env.GEMINI_API_KEY || "").trim();
  const openAIEnabled = enabledUnlessFalse(env.OPENAI_AUTONOMOUS_DISCOVERY_ENABLED);
  const geminiEnabled = enabledUnlessFalse(env.GEMINI_AUTONOMOUS_DISCOVERY_ENABLED);
  if ((!openAIApiKey || !openAIEnabled) && (!geminiApiKey || !geminiEnabled)) return [];

  const key = expansionCacheKey(profile, existingQueries);
  const cached = queryExpansionCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return [...cached.queries];

  const budget = options.budget || productionBudget;
  const maxQueries = positiveInt(env.OPENAI_AUTONOMOUS_QUERY_EXPANSION_COUNT, 4, 8);
  const schema = {
    type: "object",
    properties: {
      queries: {
        type: "array",
        maxItems: maxQueries,
        items: { type: "string" },
      },
    },
    required: ["queries"],
    additionalProperties: false,
  };
  const prompt = `Você expande buscas REAIS da Shopee Brasil para o CERBERUS FINDS. Categoria: ${profile.category}.

Objetivo estético: Bauhaus, Mid-Century Modern, modernismo 60/70, Space Age, retrofuturismo, vintage/retrô refinado, pós-modernismo/Memphis, design italiano, minimalismo industrial e japonês. Gere buscas concretas que vendedores brasileiros realmente poderiam usar, privilegiando ARQUÉTIPOS, FORMAS e MATERIAIS em vez de depender apenas dos nomes dos estilos.

Buscas já existentes: ${existingQueries.join(" | ")}
Sinais fortes: ${profile.strongStyleTerms.join(", ")}
Sinais de forma/material: ${profile.signatureTerms.join(", ")}
Bloqueios: ${profile.blockedTerms.join(", ")}

Regras: retorne no máximo ${maxQueries} consultas em português do Brasil; 2 a 10 palavras por consulta; não repita as buscas existentes; não invente URLs, IDs, marcas, autenticidade ou disponibilidade; não use termos bloqueados; prefira consultas com alta chance de encontrar produtos visualmente Cerberus mesmo quando o anúncio não usa a palavra Bauhaus/Space Age/vintage.`;

  if (openAIApiKey && openAIEnabled && budget.reserve("openaiAutonomousDiscovery").allowed) {
    try {
      const parsed = await callResponsesApi({
        apiKey: openAIApiKey,
        model: resolveModel(env),
        timeoutMs: positiveInt(env.OPENAI_AUTONOMOUS_DISCOVERY_TIMEOUT_MS, 20_000, 60_000),
        schemaName: "cerberus_shopee_query_expansion",
        schema,
        content: [{ type: "input_text", text: prompt }],
        maxOutputTokens: 500,
        fetchImpl: options.fetchImpl || fetch,
        env,
      }) as { queries?: unknown[] };
      const queries = normalizeExpandedQueries(parsed, existingQueries, maxQueries);
      queryExpansionCache.set(key, { expiresAt: Date.now() + QUERY_CACHE_TTL_MS, queries });
      return queries;
    } catch (error) {
      console.warn(`[Autonomous Curator] OpenAI query expansion indisponível: ${safeProviderReason(error)}`);
    }
  }

  if (geminiApiKey && geminiEnabled) {
    for (const model of resolveGeminiModels(env)) {
      if (!budget.reserve("geminiAutonomousDiscovery").allowed) break;
      try {
        const parsed = await callGeminiQueryExpansion({
          apiKey: geminiApiKey,
          model,
          prompt,
          maxQueries,
          generate: options.geminiGenerate,
        }) as { queries?: unknown[] };
        const queries = normalizeExpandedQueries(parsed, existingQueries, maxQueries);
        queryExpansionCache.set(key, { expiresAt: Date.now() + QUERY_CACHE_TTL_MS, queries });
        console.info(`[Autonomous Curator] Gemini query expansion fallback ativo: ${model}`);
        return queries;
      } catch (error) {
        console.warn(`[Autonomous Curator] Gemini query expansion indisponível (${model}): ${safeProviderReason(error)}`);
      }
    }
  }
  return [];
}

function semanticRankingSchema(identityKeys: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      decisions: {
        type: "array",
        maxItems: identityKeys.length,
        items: {
          type: "object",
          properties: {
            identityKey: { type: "string", enum: identityKeys },
            fitScore: { type: "integer", minimum: 0, maximum: 100 },
            categoryFit: { type: "integer", minimum: 0, maximum: 100 },
            worthEnriching: { type: "boolean" },
            confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
            signals: {
              type: "array",
              maxItems: 4,
              items: { type: "string" },
            },
            reason: { type: "string" },
          },
          required: ["identityKey", "fitScore", "categoryFit", "worthEnriching", "confidence", "signals", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["decisions"],
    additionalProperties: false,
  };
}

function validImageUrl(value: string | null): string | null {
  const url = String(value || "").trim();
  return /^https:\/\//i.test(url) && url.length <= 2_000 ? url : null;
}

function normalizeDecision(value: unknown, allowed: Set<string>): SemanticDiscoveryDecision | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const identityKey = String(record.identityKey || "");
  if (!allowed.has(identityKey)) return null;
  const fitScore = Math.max(0, Math.min(100, Math.round(Number(record.fitScore) || 0)));
  const categoryFit = Math.max(0, Math.min(100, Math.round(Number(record.categoryFit) || 0)));
  const confidenceRaw = String(record.confidence || "LOW");
  const confidence: SemanticDiscoveryDecision["confidence"] = confidenceRaw === "HIGH" || confidenceRaw === "MEDIUM" ? confidenceRaw : "LOW";
  const signals = Array.isArray(record.signals)
    ? record.signals.map(item => String(item).replace(/\s+/g, " ").trim().slice(0, 60)).filter(Boolean).slice(0, 4)
    : [];
  return {
    identityKey,
    fitScore,
    categoryFit,
    worthEnriching: record.worthEnriching === true,
    confidence,
    signals,
    reason: String(record.reason || "").replace(/\s+/g, " ").trim().slice(0, 180),
  };
}

function normalizeDecisions(parsed: { decisions?: unknown[] }, identityKeys: string[]): SemanticDiscoveryDecision[] {
  const allowed = new Set(identityKeys);
  const seen = new Set<string>();
  return (Array.isArray(parsed.decisions) ? parsed.decisions : [])
    .map(item => normalizeDecision(item, allowed))
    .filter((item): item is SemanticDiscoveryDecision => Boolean(item))
    .filter(item => {
      if (seen.has(item.identityKey)) return false;
      seen.add(item.identityKey);
      return true;
    });
}

export async function rankAutonomousCuratorCandidates(
  profile: AutonomousCuratorCategoryProfile,
  candidates: readonly SemanticDiscoveryCandidate[],
  options: SemanticOptions = {},
): Promise<SemanticDiscoveryRankingResult> {
  const env = options.env || process.env;
  const openAIApiKey = String(env.OPENAI_API_KEY || "").trim();
  const geminiApiKey = String(env.GEMINI_API_KEY || "").trim();
  const rerankEnabled = enabledUnlessFalse(env.OPENAI_AUTONOMOUS_RERANK_ENABLED);
  const openAIEnabled = rerankEnabled && enabledUnlessFalse(env.OPENAI_AUTONOMOUS_DISCOVERY_ENABLED);
  const geminiEnabled = rerankEnabled && enabledUnlessFalse(env.GEMINI_AUTONOMOUS_DISCOVERY_ENABLED);
  if ((!openAIApiKey || !openAIEnabled) && (!geminiApiKey || !geminiEnabled)) {
    return { status: "disabled", model: null, decisions: [] };
  }

  const preferredModel = openAIApiKey && openAIEnabled ? resolveModel(env) : resolveGeminiModels(env)[0] || null;
  if (candidates.length === 0) return { status: "ok", model: preferredModel, decisions: [] };

  const budget = options.budget || productionBudget;
  const maxCandidates = positiveInt(env.OPENAI_AUTONOMOUS_DISCOVERY_MAX_CANDIDATES, 48, 80);
  const selected = candidates.slice(0, maxCandidates);
  const identityKeys = selected.map(item => item.identityKey);
  const maxImages = positiveInt(env.OPENAI_AUTONOMOUS_DISCOVERY_MAX_IMAGES, 12, 24);
  const visualCandidates = selected
    .filter(item => item.lexicalScore <= -1000 && validImageUrl(item.imageUrl))
    .slice(0, maxImages);
  const rows = selected.map(item => ({
    id: item.identityKey,
    title: item.name.slice(0, 220),
    price: item.price,
    query: item.query.slice(0, 100),
    page: item.page,
    lexicalScore: item.lexicalScore,
  }));
  const prompt = `Você é a camada de DESCOBERTA SEMÂNTICA do CERBERUS FINDS. Sua função NÃO é publicar nada. Você só decide quais produtos REAIS já retornados pela Shopee merecem o enrichment caro posterior.

Categoria alvo: ${profile.category}.
Identidade Cerberus: Bauhaus, Mid-Century Modern, modernismo 60/70, Space Age, retrofuturismo, vintage/retrô refinado, pós-modernismo/Memphis, design italiano, minimalismo industrial e japonês. Valorize forma, proporção, material aparente e desenho intencional. Rejeite mass-market genérico, kits/atacado, gimmick/kitsch/novelty, RGB/gamer e incompatibilidade clara de categoria.

IMPORTANTE: títulos de marketplace são pouco confiáveis e podem ser genéricos. Um item com lexicalScore=-1000 pode ser um ótimo find se a miniatura ou o contexto da busca mostra linguagem visual forte. O inverso também vale: palavras como "Bauhaus", "retro" e "vintage" não tornam um produto bom por si só.

Não invente material, marca, autenticidade, época, função, disponibilidade ou IDs. Analise somente os IDs fornecidos. worthEnriching=true significa apenas "vale gastar as próximas chamadas para validar", nunca aprovação final. Os gates posteriores de identidade, preço, imagem, categoria, deduplicação, pipeline e score continuam soberanos.

Candidatos JSON:\n${JSON.stringify(rows)}`;
  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: prompt }];
  for (const item of visualCandidates) {
    const imageUrl = validImageUrl(item.imageUrl);
    if (!imageUrl) continue;
    content.push({ type: "input_text", text: `Miniatura do candidato ${item.identityKey}. Use somente como evidência visual auxiliar.` });
    content.push({ type: "input_image", image_url: imageUrl, detail: "auto" });
  }

  let attemptedProvider = false;
  let budgetDenied = false;
  const openAIModel = resolveModel(env);
  if (openAIApiKey && openAIEnabled) {
    const reservation = budget.reserve("openaiAutonomousDiscovery");
    if (reservation.allowed) {
      attemptedProvider = true;
      try {
        const parsed = await callResponsesApi({
          apiKey: openAIApiKey,
          model: openAIModel,
          timeoutMs: positiveInt(env.OPENAI_AUTONOMOUS_DISCOVERY_TIMEOUT_MS, 20_000, 60_000),
          schemaName: "cerberus_shopee_semantic_ranking",
          schema: semanticRankingSchema(identityKeys),
          content,
          maxOutputTokens: Math.min(5_000, 500 + selected.length * 90),
          fetchImpl: options.fetchImpl || fetch,
          env,
        }) as { decisions?: unknown[] };
        return { status: "ok", model: openAIModel, decisions: normalizeDecisions(parsed, identityKeys) };
      } catch (error) {
        console.warn(`[Autonomous Curator] OpenAI semantic ranking indisponível: ${safeProviderReason(error)}`);
      }
    } else {
      budgetDenied = true;
    }
  }

  if (geminiApiKey && geminiEnabled) {
    for (const model of resolveGeminiModels(env)) {
      const reservation = budget.reserve("geminiAutonomousDiscovery");
      if (!reservation.allowed) {
        budgetDenied = true;
        break;
      }
      attemptedProvider = true;
      try {
        const parsed = await callGeminiSemanticRanking({
          apiKey: geminiApiKey,
          model,
          prompt,
          identityKeys,
          generate: options.geminiGenerate,
        }) as { decisions?: unknown[] };
        const decisions = normalizeDecisions(parsed, identityKeys);
        console.info(`[Autonomous Curator] Gemini semantic ranking success model=${model} input=${selected.length} accepted=${decisions.length}`);
        return { status: "ok", model, decisions };
      } catch (error) {
        console.warn(`[Autonomous Curator] Gemini semantic ranking indisponível (${model}): ${safeProviderReason(error)}`);
      }
    }
  }

  if (attemptedProvider) return { status: "unavailable", model: preferredModel, decisions: [] };
  if (budgetDenied) return { status: "budget_exhausted", model: preferredModel, decisions: [] };
  return { status: "disabled", model: null, decisions: [] };
}

export const autonomousCuratorSemanticDiscoveryInternals = {
  positiveInt,
  enabledUnlessFalse,
  resolveModel,
  resolveGeminiModel,
  resolveGeminiModels,
  extractOutputText,
  parseJson,
  callResponsesApi,
  callGeminiQueryExpansion,
  callGeminiSemanticRanking,
  safeProviderReason,
  sanitizeQuery,
  expansionCacheKey,
  normalizeExpandedQueries,
  semanticRankingSchema,
  validImageUrl,
  normalizeDecision,
  normalizeDecisions,
  clearQueryExpansionCache: () => queryExpansionCache.clear(),
};
