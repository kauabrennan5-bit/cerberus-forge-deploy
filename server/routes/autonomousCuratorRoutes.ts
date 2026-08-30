import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { authorizeWeeklyAutomationRequest } from "../services/newsletterWeeklyAutomationAuth";
import { runAutonomousCuratorDaily } from "../services/autonomousCurator";
import { runAutonomousCuratorContinuousV2 } from "../services/autonomousCuratorContinuousV2";
import { extractProductForReview } from "../services/productAutomation";
import { productImageReviewInternals, resolveProductImageReviewModel } from "../services/productImageReview";
import { getAutonomousCuratorConfig } from "../repositories/autonomousCuratorRepository";
import { requireSupabase } from "../repositories/productsRepository";

let activeExecution: Promise<void> | null = null;
let activeMode: "daily" | "continuous" | null = null;
let activeCycleId: string | null = null;

const DEFAULT_AUTONOMOUS_CURATOR_COPY_MODEL = "gemini-3.5-flash-lite";
const SATURATED_AUTONOMOUS_CURATOR_COPY_MODELS = new Set([
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
]);
const OPENAI_PROVIDER_PROBE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAACvklEQVR4nO3TMQEAIAzAMMC/2ElAxo4mCvr0zsyBqrcdAJsMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYC0D3dZBNBfrtGOAAAAAElFTkSuQmCC";

type OpenAIProviderProbeStatus =
  | "ok"
  | "not_configured"
  | "disabled"
  | "auth_error"
  | "quota_exhausted"
  | "rate_limited"
  | "model_unavailable"
  | "timeout"
  | "provider_unavailable"
  | "request_rejected"
  | "invalid_response";

function resolveAutonomousCuratorCopyModel(env: NodeJS.ProcessEnv): string {
  const explicit = String(env.GEMINI_AUTONOMOUS_CURATOR_COPY_MODEL || "").trim();
  if (explicit) return explicit;
  const configured = String(env.GEMINI_PRODUCT_CURATOR_MODEL || "").trim();
  if (!configured || SATURATED_AUTONOMOUS_CURATOR_COPY_MODELS.has(configured)) return DEFAULT_AUTONOMOUS_CURATOR_COPY_MODEL;
  return configured;
}

function safeProviderErrorCode(value: unknown): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9_.-]{1,80}$/.test(normalized) ? normalized : null;
}

function safeProviderErrorParam(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[a-zA-Z0-9_.\[\]-]{1,120}$/.test(normalized) ? normalized : null;
}

function classifyOpenAIProviderProbe(httpStatus: number, errorCode: string | null): OpenAIProviderProbeStatus {
  if (httpStatus === 401 || httpStatus === 403) return "auth_error";
  if (httpStatus === 404) return "model_unavailable";
  if (httpStatus === 408) return "timeout";
  if (httpStatus === 429) {
    return ["insufficient_quota", "quota_exceeded", "billing_hard_limit_reached"].includes(String(errorCode || ""))
      ? "quota_exhausted"
      : "rate_limited";
  }
  if (httpStatus >= 500) return "provider_unavailable";
  return "request_rejected";
}

async function probeAutonomousCuratorProviders(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
) {
  const geminiConfigured = Boolean(String(env.GEMINI_API_KEY || "").trim());
  const openaiApiKey = String(env.OPENAI_API_KEY || "").trim();
  const openaiConfigured = Boolean(openaiApiKey);
  const openaiEnabled = openaiConfigured && productImageReviewInternals.enabledUnlessFalse(env.OPENAI_PRODUCT_IMAGE_REVIEW_ENABLED);
  const openaiModel = productImageReviewInternals.resolveOpenAIImageReviewModel(env);
  const openaiFallbackModel = productImageReviewInternals.resolveOpenAIImageReviewFallbackModel(env, openaiModel);
  const base = {
    gemini: {
      configured: geminiConfigured,
      model: resolveProductImageReviewModel(env),
    },
    openai: {
      configured: openaiConfigured,
      enabled: openaiEnabled,
      model: openaiModel,
      fallbackModel: openaiFallbackModel,
    },
  };

  if (!openaiConfigured) return { ...base, openai: { ...base.openai, status: "not_configured" as const } };
  if (!openaiEnabled) return { ...base, openai: { ...base.openai, status: "disabled" as const } };

  const rawUrl = "probe://cerberus-openai-image-review";
  const request = productImageReviewInternals.buildOpenAIReviewRequest([
    { url: rawUrl, mimeType: "image/png", data: OPENAI_PROVIDER_PROBE_PNG_BASE64 },
  ], "Cerberus provider health probe. Do not infer product facts from this diagnostic image.", openaiModel);
  const controller = new AbortController();
  const timeoutMs = Math.min(15_000, Math.max(3_000, productImageReviewInternals.positiveInt(env.OPENAI_PRODUCT_IMAGE_REVIEW_TIMEOUT_MS, 10_000)));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "CerberusFinds/1.0",
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const responseText = await response.text();
    if (!response.ok) {
      let errorCode: string | null = null;
      let errorParam: string | null = null;
      try {
        const parsed = JSON.parse(responseText) as { error?: { code?: unknown; type?: unknown; param?: unknown } };
        errorCode = safeProviderErrorCode(parsed?.error?.code) || safeProviderErrorCode(parsed?.error?.type);
        errorParam = safeProviderErrorParam(parsed?.error?.param);
      } catch {
        // HTTP status remains sufficient for a safe classification.
      }
      return {
        ...base,
        openai: {
          ...base.openai,
          status: classifyOpenAIProviderProbe(response.status, errorCode),
          httpStatus: response.status,
          errorCode,
          errorParam,
        },
      };
    }

    try {
      const payload = JSON.parse(responseText);
      const parsed = productImageReviewInternals.parseModelJson(productImageReviewInternals.extractOpenAIOutputText(payload)) as { images?: unknown[] };
      if (!Array.isArray(parsed.images) || parsed.images.length === 0) {
        return { ...base, openai: { ...base.openai, status: "invalid_response" as const, httpStatus: response.status } };
      }
    } catch {
      return { ...base, openai: { ...base.openai, status: "invalid_response" as const, httpStatus: response.status } };
    }
    return { ...base, openai: { ...base.openai, status: "ok" as const, httpStatus: response.status } };
  } catch (error) {
    const isTimeout = error instanceof Error && (error.name === "AbortError" || /timeout|timed out/i.test(error.message));
    return { ...base, openai: { ...base.openai, status: isTimeout ? "timeout" as const : "provider_unavailable" as const } };
  } finally {
    clearTimeout(timer);
  }
}

async function extractForAutonomousCurator(rawUrl: string, rawTextOverride?: string) {
  const previousModel = process.env.GEMINI_PRODUCT_CURATOR_MODEL;
  process.env.GEMINI_PRODUCT_CURATOR_MODEL = resolveAutonomousCuratorCopyModel(process.env);
  try {
    return await extractProductForReview(rawUrl, rawTextOverride);
  } finally {
    if (previousModel === undefined) delete process.env.GEMINI_PRODUCT_CURATOR_MODEL;
    else process.env.GEMINI_PRODUCT_CURATOR_MODEL = previousModel;
  }
}

async function authorize(req: Request, res: Response): Promise<boolean> {
  const auth = await authorizeWeeklyAutomationRequest({ headers: req.headers as Record<string, string | string[] | undefined> });
  if (auth.authorized) return true;
  res.status(401).json({ ok: false, code: "AUTOMATION_UNAUTHORIZED" });
  return false;
}

function safeCode(error: unknown): string {
  return error instanceof Error && /^[A-Z0-9_:.-]{1,160}$/.test(error.message) ? error.message : "AUTONOMOUS_CURATOR_FAILED";
}

function alreadyRunning(res: Response) {
  return res.status(202).json({ ok: true, accepted: true, status: "already_running", mode: activeMode, cycleId: activeCycleId });
}

export function registerAutonomousCuratorRoutes(app: Express): void {
  app.post("/api/internal/autonomous-curator/provider-health", async (req, res) => {
    if (!(await authorize(req, res))) return;
    try {
      const providers = await probeAutonomousCuratorProviders(process.env);
      return res.status(200).json({ ok: true, providers });
    } catch {
      return res.status(503).json({ ok: false, code: "AUTONOMOUS_CURATOR_PROVIDER_HEALTH_UNAVAILABLE" });
    }
  });

  app.post("/api/internal/autonomous-curator/daily", async (req, res) => {
    if (!(await authorize(req, res))) return;
    const dryRun = req.body?.dryRun === true;
    const notify = req.body?.notify !== false;
    const wait = req.body?.wait === true;
    try {
      const config = await getAutonomousCuratorConfig();
      if (!dryRun && !config.enabled) return res.status(200).json({ ok: true, accepted: false, status: "disabled" });
      if (activeExecution) return alreadyRunning(res);
      if (wait) {
        const result = await runAutonomousCuratorDaily({ dryRun, notify }, { extractor: extractForAutonomousCurator });
        return res.status(200).json({ ok: true, accepted: true, result });
      }
      activeMode = "daily";
      activeCycleId = null;
      activeExecution = runAutonomousCuratorDaily({ dryRun, notify }, { extractor: extractForAutonomousCurator })
        .then(result => console.info(`[AUTONOMOUS-CURATOR] background_complete status=${result.status} run=${result.runId || "none"}`))
        .catch(error => console.error(`[AUTONOMOUS-CURATOR] background_failed code=${safeCode(error)}`))
        .finally(() => { activeExecution = null; activeMode = null; activeCycleId = null; });
      return res.status(202).json({ ok: true, accepted: true, status: "started", dryRun });
    } catch (error) {
      const code = safeCode(error);
      console.error(`[AUTONOMOUS-CURATOR] daily_start_failed code=${code}`);
      return res.status(500).json({ ok: false, code });
    }
  });

  app.post("/api/internal/autonomous-curator/continuous", async (req, res) => {
    if (!(await authorize(req, res))) return;
    const notify = req.body?.notify !== false;
    const wait = req.body?.wait === true;
    try {
      const config = await getAutonomousCuratorConfig();
      if (!config.enabled) return res.status(200).json({ ok: true, accepted: false, status: "disabled" });
      if (activeExecution) return alreadyRunning(res);
      const cycleId = `continuous-${randomUUID()}`;
      if (wait) {
        const result = await runAutonomousCuratorContinuousV2({ cycleId, notify, extractor: extractForAutonomousCurator });
        return res.status(200).json({ ok: true, accepted: true, cycleId, result });
      }
      activeMode = "continuous";
      activeCycleId = cycleId;
      activeExecution = runAutonomousCuratorContinuousV2({ cycleId, notify, extractor: extractForAutonomousCurator })
        .then(result => console.info(`[AUTONOMOUS-CURATOR] continuous_v2_complete status=${result.status} run=${result.runId || "none"} cycle=${cycleId}`))
        .catch(error => console.error(`[AUTONOMOUS-CURATOR] continuous_v2_failed cycle=${cycleId} code=${safeCode(error)}`))
        .finally(() => { activeExecution = null; activeMode = null; activeCycleId = null; });
      return res.status(202).json({ ok: true, accepted: true, status: "started", mode: "continuous", cycleId });
    } catch (error) {
      const code = safeCode(error);
      console.error(`[AUTONOMOUS-CURATOR] continuous_start_failed code=${code}`);
      return res.status(500).json({ ok: false, code });
    }
  });

  app.get("/api/internal/autonomous-curator/status", async (req, res) => {
    if (!(await authorize(req, res))) return;
    try {
      const config = await getAutonomousCuratorConfig();
      const dryRunFilter = String(req.query.dryRun ?? "").trim();
      const client = requireSupabase();
      let query = client.from("autonomous_curator_runs")
        .select("id,run_date,status,dry_run,profile_version,started_at,completed_at,categories_total,categories_processed,auto_published,review_required,rejected,failed,metadata")
        .order("started_at", { ascending: false }).limit(1);
      if (dryRunFilter === "true") query = query.eq("dry_run", true);
      if (dryRunFilter === "false") query = query.eq("dry_run", false);
      const { data: runs, error } = await query;
      if (error) throw error;
      const latest = Array.isArray(runs) && runs.length > 0 ? runs[0] : null;
      let categories: unknown[] = [];
      if (latest?.id) {
        const { data, error: categoryError } = await client.from("autonomous_curator_candidates")
          .select("category,decision,score,display_title,reason,product_id,review_id,updated_at")
          .eq("run_id", latest.id).order("category", { ascending: true });
        if (categoryError) throw categoryError;
        categories = data || [];
      }
      const { data: queued, error: queueError } = await client.from("products")
        .select("id,categoria,produto,preco,status,created_at")
        .eq("created_by", "autonomous_curator_queue").eq("status", "paused").eq("ativo", false)
        .order("created_at", { ascending: true });
      if (queueError) throw queueError;
      const queueByCategory: Record<string, number> = {};
      for (const product of queued || []) {
        const category = String(product.categoria || "unknown");
        queueByCategory[category] = (queueByCategory[category] || 0) + 1;
      }
      return res.status(200).json({
        ok: true,
        running: Boolean(activeExecution),
        activeMode,
        activeCycleId,
        enabled: config.enabled,
        autoPublishEnabled: config.autoPublishEnabled,
        autoPublishThreshold: config.autoPublishThreshold,
        reviewThreshold: config.reviewThreshold,
        maxDailyPerCategory: config.maxDailyPerCategory,
        maxSearchCandidates: config.maxSearchCandidates,
        maxEnrichPerCategory: config.maxEnrichPerCategory,
        queueCount: Array.isArray(queued) ? queued.length : 0,
        queueByCategory,
        latestRun: latest,
        latestContinuousCycle: latest?.metadata && typeof latest.metadata === "object" ? latest.metadata.continuous_cycles?.slice?.(-1)?.[0] || null : null,
        categories,
      });
    } catch {
      return res.status(503).json({ ok: false, code: "AUTONOMOUS_CURATOR_STATUS_UNAVAILABLE" });
    }
  });
}

export const autonomousCuratorRouteInternals = {
  resolveAutonomousCuratorCopyModel,
  safeProviderErrorCode,
  safeProviderErrorParam,
  classifyOpenAIProviderProbe,
  probeAutonomousCuratorProviders,
};
