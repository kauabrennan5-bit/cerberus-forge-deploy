import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import { INITIAL_PRODUCTS, generateSlug } from "./src/data/initialProducts";
import * as productsRepository from "./server/repositories/productsRepository";
import { fetchProductDataFromUrl } from "./server/services/scraper";
import { handleTelegramWebhookUpdate, startTelegramPolling } from "./server/services/telegramBot";
import { processProductUrl } from "./server/services/productAutomation";
import * as cerberusOperator from "./server/services/cerberusOperator";
import { createProductionProductPipeline } from "./server/services/productPipeline";
import { InMemoryRateLimiter } from "./server/services/operationalGuards";
import { startNewsletterOutboxWorker } from "./server/services/newsletterOutboxScheduler";
import { startNewsletterCampaignWorker } from "./server/services/newsletterCampaignScheduler";
import { startNewsletterCampaignRetentionScheduler } from "./server/services/newsletterCampaignRetention";
import {
  buildUnsubscribeUpdate,
  hashUnsubscribeToken,
  isExplicitMarketingConsent,
  isValidNewsletterEmail,
  normalizeNewsletterEmail,
} from "./server/services/newsletterConsent";
import {
  buildNewsletterQ7RpcArgs,
  classifyNewsletterQ7Error,
  extractNewsletterQ7Row,
} from "./server/services/newsletterQ7";
import { getExpectedTelegramWebhookUrl, getTelegramWebhookDiagnostics } from "./server/services/telegramDiagnostics";
// FASE 25B (Commit 1) — Painel de leitura Telegram: registro do menu via setMyCommands.
import { registerTelegramCommands } from "./server/services/telegramPanel";
import { containsRawPayloadMarkers } from "./server/services/productLifecycle";
import { listPublicSocialLinks } from "./server/services/socialLinks";
import { setCommercialBrainClient } from "./server/repositories/commercialBrainRepository";
import { registerCommercialBrainRoutes } from "./server/routes/commercialBrainRoutes";
import { registerPolicyEngineRoutes } from "./server/routes/policyEngineRoutes";
import { setPolicyJournalClient } from "./server/repositories/policyJournalRepository";
import { setAgentExecutionClient } from "./server/repositories/agentExecutionsRepository";
import { registerAgentRuntimeRoutes } from "./server/routes/agentRuntimeRoutes";
import { registerExperimentRoutes } from "./server/routes/experimentRoutes";
import { setExperimentClient } from "./server/repositories/experimentRepository";
import { registerCandidateRoutes } from "./server/routes/candidateRoutes";
import { setupDiscoveryRoutes } from "./server/routes/discoveryRoutes";
import { registerResearchBatchRoutes } from "./server/routes/researchBatchRoutes";
import { registerResearchRoutes } from "./server/routes/researchRoutes";
import { registerAssessmentRoutes } from "./server/routes/assessmentRoutes";
import { registerPublicationRoutes } from "./server/routes/publicationRoutes";
import { setCandidatesClient } from "./server/repositories/candidatesRepository";
import { setCandidateEvidenceClient } from "./server/repositories/candidateEvidenceRepository";
import { getCandidateAssessmentClient, setCandidateAssessmentClient } from "./server/repositories/candidateAssessmentRepository";
import { registerAffiliateRoutes } from "./server/commercial/affiliate/affiliateRoutes";
import { registerCurationRoutes } from "./server/routes/curationRoutes";
import { registerCommercialBrainCandidatesRoutes } from "./server/routes/commercialBrainCandidatesRoutes";
import { registerGovernanceRoutes } from "./server/routes/governanceRoutes";
import { setAffiliateClient } from "./server/commercial/affiliate/affiliateRepository";
import {
  createN17RuntimeDeps,
  setN17RuntimeDeps,
} from "./server/commercial/affiliate/n17Runtime";
import { registerN17Routes } from "./server/commercial/affiliate/n17Routes";
import {
  getAffiliateApiSource,
  setAffiliateApiSource,
} from "./server/commercial/affiliate/acquisitionService";
import { createShopeeAffiliateProvider } from "./server/commercial/affiliate/shopeeAffiliateProvider";
import { registerCycleRoutes } from "./server/routes/cycleRoutes";
import diagRoutes from "./server/routes/diagRoutes";
// Fase 23 — PREVIEW != PUBLICATION: rota de preview manual Shopee Affiliate →
// Telegram com decisão humana registrada (approve_only), sem automação de publicação.
import { setupPreviewTelegramRoutes } from "./server/routes/previewTelegramRoutes";
import { setCycleClient } from "./server/commercial/cycle/cycleRepository";
import { registerN2SourceConnectors } from "./server/commercial/sourceConnector/registerN2SourceConnectors";
import { setPublicationExecutionsClient } from "./server/repositories/publicationExecutionsRepository";
import { registerPublicationN16Routes, setN16PublicationProvider } from "./server/routes/publicationN16Routes";
import { FakePublicationProvider, type FakePublicationProviderMode } from "./server/commercial/publication/n16Provider";

dotenv.config();

async function startServer() {
  const app = express();
  app.set("trust proxy", 1);
  const PORT = Number.parseInt(process.env.PORT || "3000", 10);

  const fetchWithTimeout = async (url: string | URL, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  };

  app.use(express.json({ limit: "25mb" }));

  const requestKey = (req: express.Request): string => req.ip || req.socket.remoteAddress || "unknown";
  const rateLimit = (name: string, fallback: number): number => Math.max(1, Number.parseInt(process.env[name] || String(fallback), 10));
  const adminRateLimiter = new InMemoryRateLimiter(rateLimit("ADMIN_RATE_LIMIT_PER_MINUTE", 30), 60_000);
  const catalogRateLimiter = new InMemoryRateLimiter(rateLimit("CATALOG_RATE_LIMIT_PER_MINUTE", 120), 60_000);
  const analyticsRateLimiter = new InMemoryRateLimiter(rateLimit("ANALYTICS_RATE_LIMIT_PER_MINUTE", 30), 60_000);
  const newsletterRateLimiter = new InMemoryRateLimiter(rateLimit("NEWSLETTER_RATE_LIMIT_PER_MINUTE", 10), 60_000);
  const expensiveOperationRateLimiter = new InMemoryRateLimiter(rateLimit("EXPENSIVE_RATE_LIMIT_PER_MINUTE", 10), 60_000);

  const escapeHtml = (value: unknown): string => String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  const isSocialCrawler = (userAgent: unknown): boolean => /facebookexternalhit|facebot|twitterbot|slackbot|discordbot|linkedinbot|whatsapp|telegrambot|pinterestbot|embedly/i.test(String(userAgent || ""));

  const enforceRateLimit = (limiter: InMemoryRateLimiter, req: express.Request, res: express.Response): boolean => {
    const decision = limiter.check(requestKey(req));
    res.setHeader("X-RateLimit-Remaining", String(decision.remaining));
    if (decision.allowed) return true;
    res.setHeader("Retry-After", String(decision.retryAfterSeconds));
    res.status(429).json({
      success: false,
      code: "RATE_LIMITED",
      error: "Limite temporário atingido. Aguarde antes de tentar novamente.",
      retryAfterSeconds: decision.retryAfterSeconds,
    });
    return false;
  };

  // Liveness mínimo: não consulta banco, não dispara auto-heal e não modifica estado.
  // O watchdog externo usa exclusivamente esta rota para separar processo vivo de dependências.
  app.get("/health", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      status: "ok",
      service: "cerberus-forge-deploy",
      version: process.env.RENDER_GIT_COMMIT || process.env.RENDER_GIT_COMMIT_SHA || "unknown",
      timestamp: new Date().toISOString(),
    });
  });

  // Initialize Gemini AI client
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });

  // CORS: fail-closed for browser origins. Requests without Origin (server-to-server,
  // health checks, Telegram) continue to work normally.
  const normalizeOrigin = (value: unknown): string => String(value || "").trim().replace(/\/+$/, "");
  const configuredCorsOrigins = new Set(
    [
      "https://cerberusfinds.com",
      process.env.PUBLIC_SITE_URL,
      process.env.STATIC_CATALOG_URL,
      process.env.APP_URL,
      ...(process.env.CORS_ALLOWED_ORIGINS || "").split(","),
    ]
      .map(normalizeOrigin)
      .filter(Boolean),
  );
  const isAllowedCorsOrigin = (origin: string): boolean => {
    const normalized = normalizeOrigin(origin);
    if (configuredCorsOrigins.has(normalized)) return true;
    return process.env.NODE_ENV !== "production" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalized);
  };

  app.use((req, res, next) => {
    const origin = typeof req.headers.origin === "string" ? normalizeOrigin(req.headers.origin) : "";
    if (origin) {
      if (!isAllowedCorsOrigin(origin)) {
        if (req.method === "OPTIONS") return res.sendStatus(403);
      } else {
        res.header("Access-Control-Allow-Origin", origin);
        res.header("Vary", "Origin");
      }
    }
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-admin-password, x-diagnostics-token");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // ==========================================
  // HELPER DE VALIDAÇÃO DE URL PARA PROXY CSV (PREVENÇÃO DE SSRF)
  // ==========================================
  const isValidCsvProxyUrl = (rawUrl: string): boolean => {
    try {
      const parsed = new URL(rawUrl);

      if (parsed.protocol !== "https:") {
        return false;
      }

      const hostname = parsed.hostname.toLowerCase();

      const forbiddenHostnames = [
        "localhost",
        "127.0.0.1",
        "0.0.0.0",
        "::1",
        "169.254.169.254",
        "metadata.google.internal"
      ];

      if (forbiddenHostnames.includes(hostname)) {
        return false;
      }

      if (
        /^127\./.test(hostname) ||
        /^10\./.test(hostname) ||
        /^192\.168\./.test(hostname) ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname) ||
        /^0\./.test(hostname) ||
        /^169\.254\./.test(hostname)
      ) {
        return false;
      }

      const allowedDomains = [
        "docs.google.com",
        "drive.google.com",
        "googleusercontent.com",
        "sheets.googleapis.com"
      ];

      const isAllowedDomain = allowedDomains.some(domain =>
        hostname === domain || hostname.endsWith("." + domain)
      );

      return isAllowedDomain;
    } catch {
      return false;
    }
  };

  // ==========================================
  // MIDDLEWARE DE AUTENTICAÇÃO ADMINISTRATIVA (FAIL-CLOSED + BCRYPT)
  // ==========================================
  const requireAdminAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!enforceRateLimit(adminRateLimiter, req, res)) return;
    const rawAdminPassEnv = (process.env.ADMIN_PASSWORD || "").trim();

    if (!rawAdminPassEnv) {
      return res.status(401).json({
        success: false,
        error: "Acesso administrativo desativado: a variável ADMIN_PASSWORD não está configurada no ambiente do servidor."
      });
    }

    const authHeader = (req.headers["x-admin-password"] as string) || "";
    const bearerHeader = (req.headers["authorization"] as string) || "";
    const bearerPass = bearerHeader.startsWith("Bearer ") ? bearerHeader.slice(7).trim() : "";
    const providedPass = (authHeader || bearerPass).trim();

    if (!providedPass) {
      return res.status(401).json({
        success: false,
        error: "Acesso administrativo não autorizado. Senha ausente."
      });
    }

    const isEnvHashed = rawAdminPassEnv.startsWith("$2a$") || rawAdminPassEnv.startsWith("$2b$") || rawAdminPassEnv.startsWith("$2y$");
    const targetHash = isEnvHashed ? rawAdminPassEnv : bcrypt.hashSync(rawAdminPassEnv, 10);

    const isValid = bcrypt.compareSync(providedPass, targetHash);

    if (!isValid) {
      return res.status(401).json({
        success: false,
        error: "Acesso administrativo não autorizado. Senha incorreta."
      });
    }

    next();
  };

  app.post("/api/admin/verify", requireAdminAuth, (_req, res) => {
    return res.json({ success: true, message: "Senha de administrador verificada com sucesso!" });
  });

  app.post("/api/newsletter", async (req, res) => {
    if (!enforceRateLimit(newsletterRateLimiter, req, res)) return;
    const email = normalizeNewsletterEmail(req.body?.email);
    if (!isValidNewsletterEmail(email)) {
      return res.status(400).json({ success: false, code: "INVALID_EMAIL", error: "Informe um e-mail válido." });
    }
    if (!isExplicitMarketingConsent(req.body?.marketingConsent)) {
      return res.status(400).json({
        success: false,
        code: "CONSENT_REQUIRED",
        error: "É necessário confirmar o consentimento para receber comunicações por e-mail.",
      });
    }
    try {
      const client = productsRepository.requireSupabase();
      const q7Args = buildNewsletterQ7RpcArgs(email, req.body?.marketingConsent);
      const { data, error } = await client.rpc("confirm_newsletter_consent_with_outbox", q7Args);
      if (error) {
        const q7Code = classifyNewsletterQ7Error(error);
        if (q7Code === "NEWSLETTER_RECONSENT_REQUIRED") {
          return res.status(409).json({
            success: false,
            code: "RECONSENT_REQUIRED",
            error: "Este contato exige um fluxo explícito de reativação.",
          });
        }
        if (q7Code === "CONSENT_REQUIRED") {
          return res.status(400).json({
            success: false,
            code: "CONSENT_REQUIRED",
            error: "É necessário confirmar o consentimento para receber comunicações por e-mail.",
          });
        }
        if (q7Code === "OUTBOX_IDEMPOTENCY_COLLISION") {
          return res.status(409).json({
            success: false,
            code: "IDEMPOTENCY_COLLISION",
            error: "A intenção de inscrição não coincide com a intenção já registrada.",
          });
        }
        throw error;
      }

      const q7Row = extractNewsletterQ7Row(data);
      if (!q7Row) throw new Error("NEWSLETTER_Q7_INVALID_RESPONSE");
      return res.status(q7Row.replayed ? 200 : 201).json({
        success: true,
        message: q7Row.replayed ? "Inscrição já registrada." : "Inscrição registrada.",
        result: q7Row.result,
        replayed: q7Row.replayed,
      });
    } catch (error: any) {
      const q7Code = classifyNewsletterQ7Error(error);
      console.error("[Newsletter] Falha ao registrar inscrição:", q7Code);
      return res.status(503).json({ success: false, code: "NEWSLETTER_UNAVAILABLE", error: "Cadastro temporariamente indisponível." });
    }
  });

  const applyUnsubscribe = async (token: string): Promise<void> => {
    if (token.length < 32 || token.length > 256) throw new Error("INVALID_UNSUBSCRIBE_TOKEN");
    const client = productsRepository.requireSupabase();
    const { error } = await client
      .from("newsletter_subscribers")
      .update(buildUnsubscribeUpdate())
      .eq("unsubscribe_token_hash", hashUnsubscribeToken(token))
      .eq("status", "subscribed")
      .gt("unsubscribe_token_expires_at", new Date().toISOString())
      .select("status")
      .limit(1);
    if (error) throw error;
  };

  app.get("/api/institutional/social-links", async (req, res) => {
    if (!enforceRateLimit(newsletterRateLimiter, req, res)) return;
    try {
      const links = await listPublicSocialLinks();
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ success: true, links });
    } catch (error: any) {
      console.error("[Institutional] Falha ao carregar links sociais:", error?.code || error?.message || "unknown_error");
      return res.status(503).json({ success: false, error: "Links sociais temporariamente indisponíveis." });
    }
  });

  app.get("/api/newsletter/unsubscribe", async (req, res) => {
    const token = typeof req.query?.token === "string" ? req.query.token.trim() : "";
    try {
      await applyUnsubscribe(token);
      return res.status(200).type("html").send("<!doctype html><html lang=\"pt-BR\"><meta charset=\"utf-8\"><title>Descadastro concluído</title><p>Seu descadastro foi concluído. Você não receberá novas campanhas de marketing.</p></html>");
    } catch (error: any) {
      if (error?.message === "INVALID_UNSUBSCRIBE_TOKEN") {
        return res.status(400).type("html").send("<!doctype html><html lang=\"pt-BR\"><meta charset=\"utf-8\"><title>Link inválido</title><p>O link de descadastro é inválido ou expirou.</p></html>");
      }
      console.error("[Newsletter] Falha ao processar descadastro GET:", error?.message || error);
      return res.status(503).type("html").send("<!doctype html><html lang=\"pt-BR\"><meta charset=\"utf-8\"><title>Indisponível</title><p>Descadastro temporariamente indisponível.</p></html>");
    }
  });

  app.post("/api/newsletter/unsubscribe", async (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    try {
      await applyUnsubscribe(token);
      return res.status(204).send();
    } catch (error: any) {
      if (error?.message === "INVALID_UNSUBSCRIBE_TOKEN") {
        return res.status(400).json({ success: false, code: "INVALID_UNSUBSCRIBE_TOKEN", error: "Token de descadastro inválido." });
      }
      console.error("[Newsletter] Falha ao processar descadastro POST:", error?.message || error);
      return res.status(503).json({ success: false, code: "NEWSLETTER_UNAVAILABLE", error: "Descadastro temporariamente indisponível." });
    }
  });

  app.post("/api/admin/rebuild-static-catalog", requireAdminAuth, async (_req, res) => {
    try {
      const { syncCatalogAndDeploy } = await import("./server/services/catalogSync");
      const result = await syncCatalogAndDeploy("Rebuild Administrativo Manual");
      return res.json({
        success: result.success,
        message: result.success ? "Catálogo estático reconstruído e sincronizado com sucesso!" : "Falha na sincronização do catálogo estático.",
        data: result
      });
    } catch (err: any) {
      console.error("Erro no rebuild estático:", err);
      return res.status(500).json({ success: false, error: "Erro interno no rebuild: " + err.message });
    }
  });

  app.get("/api/products", async (req, res) => {
    if (!enforceRateLimit(catalogRateLimiter, req, res)) return;
    try {
      const products = await productsRepository.getProducts();
      const publicProducts = products.map(product => containsRawPayloadMarkers(product.descricao)
        ? { ...product, descricao: "" }
        : product);
      return res.json({ success: true, products: publicProducts, data: publicProducts });
    } catch (err: any) {
      console.error("❌ [/api/products] Erro de repositório:", err.message);
      return res.status(503).json({
        success: false,
        code: "SUPABASE_PERSISTENCE_ERROR",
        error: "Não foi possível carregar o catálogo canônico no momento."
      });
    }
  });

  app.get("/api/products/:idOrSlug", async (req, res) => {
    try {
      const { idOrSlug } = req.params;
      const product = await productsRepository.getProductByIdOrSlug(idOrSlug);
      if (!product) {
        return res.status(404).json({ success: false, error: "Produto não encontrado" });
      }
      const publicProduct = containsRawPayloadMarkers(product.descricao)
        ? { ...product, descricao: "" }
        : product;
      return res.json({ success: true, product: publicProduct });
    } catch (err: any) {
      console.error("❌ [/api/products/:idOrSlug] Erro de repositório:", err.message);
      return res.status(500).json({ success: false, error: err.message || "Erro ao buscar produto." });
    }
  });

  app.post("/api/products", requireAdminAuth, async (req, res) => {
    try {
      const { produto, categoria, preco, imagens, link, destaque, descricao, paginaPonteUrl } = req.body;

      if (!produto || !link || !categoria || !preco) {
        return res.status(400).json({ success: false, error: "Nome, categoria, preço e link são obrigatórios." });
      }

      const lifecycle = await createProductionProductPipeline().evaluate({
        produto,
        categoria,
        preco: Number(preco),
        imagens: Array.isArray(imagens) ? imagens : [],
        normalizedUrl: link,
        descricao,
      });
      if (lifecycle.state === "ERROR" || lifecycle.state === "REJECTED") {
        return res.status(400).json({ success: false, error: lifecycle.error || "VALIDATION_ERROR", lifecycle });
      }
      return res.status(202).json({
        success: true,
        message: "Produto avaliado e aguardando aprovação humana no Telegram; nenhuma publicação foi executada por este endpoint.",
        lifecycle,
      });
    } catch (err: any) {
      console.error("Erro ao criar produto:", err);
      return res.status(500).json({ success: false, error: "Erro de servidor ao cadastrar produto: " + err.message });
    }
  });

  const handleDeleteRequest = async (req: express.Request, res: express.Response) => {
    try {
      const id = req.params.id || req.body?.id;
      console.log("[DELETE LOG 7] Entrada na rota de exclusão de produto. ID recebido:", id);
      if (!id) {
        return res.status(400).json({ success: false, error: "ID do produto é obrigatório." });
      }

      const deleted = await productsRepository.deleteProduct(id);

      if (!deleted) {
        console.log("[DELETE LOG 7] Produto não encontrado no repositório. Retornando 404.");
        return res.status(404).json({ success: false, error: "Produto não encontrado." });
      }

      console.log("[DELETE LOG 7] Exclusão realizada com sucesso no repositório. Retornando 200.");
      return res.json({ success: true, message: "Produto removido com sucesso." });
    } catch (err: any) {
      console.error("[DELETE LOG 7] Erro na rota de exclusão:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  };

  app.delete("/api/products/:id", requireAdminAuth, handleDeleteRequest);
  app.post("/api/products/:id/delete", requireAdminAuth, handleDeleteRequest);
  app.post("/api/products/delete", requireAdminAuth, handleDeleteRequest);

  const handleUpdateRequest = async (req: express.Request, res: express.Response) => {
    try {
      const id = req.params.id || req.body?.id;
      console.log("[UPDATE LOG] Entrada na rota de atualização de produto. ID recebido:", id);
      if (!id) {
        return res.status(400).json({ success: false, error: "ID do produto é obrigatório." });
      }

      const { produto, categoria, preco, imagens, link, destaque, descricao, paginaPonteUrl, ativo } = req.body;

      let imagesArray: string[] | undefined = undefined;
      if (Array.isArray(imagens)) {
        imagesArray = imagens;
      } else if (typeof imagens === "string" && imagens.trim()) {
        imagesArray = imagens.split(" | ").map((s) => s.trim()).filter(Boolean);
      }

      const updatePayload: any = {};
      if (produto !== undefined) updatePayload.produto = String(produto).trim();
      if (categoria !== undefined) updatePayload.categoria = String(categoria).trim();
      if (preco !== undefined) updatePayload.preco = Number(preco) || 0;
      if (imagesArray !== undefined) updatePayload.imagens = imagesArray;
      if (link !== undefined) updatePayload.link = String(link).trim();
      if (destaque !== undefined) updatePayload.destaque = Boolean(destaque);
      if (descricao !== undefined) {
        const normalizedDescription = String(descricao).trim();
        if (containsRawPayloadMarkers(normalizedDescription)) {
          return res.status(400).json({
            success: false,
            code: "RAW_PAYLOAD_DESCRIPTION_REJECTED",
            error: "Descrição técnica do scraper não pode ser gravada como conteúdo editorial.",
          });
        }
        updatePayload.descricao = normalizedDescription;
      }
      if (paginaPonteUrl !== undefined) updatePayload.paginaPonteUrl = String(paginaPonteUrl).trim();
      if (ativo !== undefined) updatePayload.ativo = Boolean(ativo);

      const updated = await productsRepository.updateProduct(id, updatePayload);

      if (!updated) {
        return res.status(404).json({ success: false, error: "Produto não encontrado para atualização." });
      }

      console.log(`[UPDATE LOG] Produto "${updated.produto}" (ID: ${updated.id}) atualizado com sucesso.`);
      return res.json({
        success: true,
        message: "Produto atualizado com sucesso!",
        product: updated
      });
    } catch (err: any) {
      console.error("[UPDATE LOG Error]", err);
      return res.status(500).json({ success: false, error: "Erro no servidor ao atualizar produto: " + err.message });
    }
  };

  app.put("/api/products/:id", requireAdminAuth, handleUpdateRequest);
  app.post("/api/products/:id/edit", requireAdminAuth, handleUpdateRequest);
  app.post("/api/products/:id/update", requireAdminAuth, handleUpdateRequest);

  // Meta CAPI uses server-owned credentials only and validates event/product.
  app.post("/api/meta-capi", async (req, res) => {
    if (!enforceRateLimit(analyticsRateLimiter, req, res)) return;
    try {
      const eventName = String(req.body?.event_name || "").trim();
      const eventId = String(req.body?.event_id || "").trim();
      const productId = String(req.body?.product?.id || "").trim();
      const allowedEvents = new Set(["InitiateCheckout"]);

      if (!allowedEvents.has(eventName)) {
        return res.status(400).json({ success: false, code: "INVALID_CAPI_EVENT", error: "Evento CAPI não permitido." });
      }
      if (!/^[A-Za-z0-9._:-]{8,128}$/.test(eventId)) {
        return res.status(400).json({ success: false, code: "INVALID_EVENT_ID", error: "event_id inválido." });
      }
      if (!productId) {
        return res.status(400).json({ success: false, code: "PRODUCT_ID_REQUIRED", error: "product.id é obrigatório." });
      }

      const realProduct = await productsRepository.getProductByIdOrSlug(productId);
      if (!realProduct || realProduct.ativo === false) {
        return res.status(404).json({ success: false, code: "PRODUCT_NOT_FOUND", error: "Produto não localizado na fonte canônica." });
      }

      const pixelId = String(process.env.META_PIXEL_ID || "").trim();
      const accessToken = String(process.env.META_ACCESS_TOKEN || "").trim();
      if (!pixelId || !accessToken) {
        return res.status(503).json({
          success: false,
          code: "META_CAPI_NOT_CONFIGURED",
          error: "Meta CAPI não está configurada no ambiente do servidor."
        });
      }

      const clientIp = ((req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "").split(",")[0].trim();
      const userAgent = req.headers["user-agent"] || "";
      const payload = {
        data: [
          {
            event_name: eventName,
            event_time: Math.floor(Date.now() / 1000),
            event_id: eventId,
            event_source_url: req.headers.referer || "",
            action_source: "website",
            user_data: {
              client_ip_address: clientIp,
              client_user_agent: userAgent
            },
            custom_data: {
              content_name: realProduct.produto,
              content_ids: [realProduct.id],
              content_type: "product",
              value: Number(realProduct.preco) || 0,
              currency: "BRL"
            }
          }
        ]
      };

      const capiRes = await fetchWithTimeout(`https://graph.facebook.com/v19.0/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(accessToken)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const capiJson = await capiRes.json().catch(() => ({}));
      if (!capiRes.ok) {
        console.error("[Meta CAPI] Graph API rejected event:", capiRes.status);
        return res.status(502).json({ success: false, code: "META_CAPI_UPSTREAM_ERROR", error: "Meta CAPI rejeitou o evento." });
      }

      return res.json({ success: true, event_id: eventId, deduplicated: true, events_received: capiJson?.events_received });
    } catch (err: any) {
      console.error("Erro no /api/meta-capi:", err?.message || err);
      return res.status(500).json({ success: false, error: "Erro interno ao registrar evento CAPI." });
    }
  });

  app.post("/api/track-click", async (req, res) => {
    if (!enforceRateLimit(analyticsRateLimiter, req, res)) return;
    try {
      const {
        productId,
        productSlug,
        productName,
        productPrice,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content,
        utm_term,
        fbclid,
        gclid,
        ttclid,
        referrer,
        landingPage
      } = req.body || {};

      if (!productId) {
        return res.status(400).json({ success: false, error: "productId é obrigatório" });
      }

      const realProduct = await productsRepository.getProductByIdOrSlug(productId);
      if (!realProduct) {
        return res.status(404).json({
          success: false,
          code: "PRODUCT_NOT_FOUND",
          error: "Produto não localizado na fonte canônica."
        });
      }
      const verifiedName = realProduct?.produto || productName || productId;
      const verifiedPrice = realProduct?.preco ?? Number(productPrice) ?? 0;
      const verifiedSlug = realProduct?.slug || productSlug || productId;

      const clientIp = ((req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "").split(",")[0].trim();
      const userAgent = req.headers["user-agent"] || "";

      await productsRepository.recordProductClick({
        productId,
        productSlug: verifiedSlug,
        productName: verifiedName,
        productPrice: verifiedPrice,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content,
        utm_term,
        fbclid,
        gclid,
        ttclid,
        referrer,
        landingPage,
        userAgent,
        ipAddress: clientIp
      });

      return res.json({ success: true, message: "Clique de produto registrado com sucesso" });
    } catch (err: any) {
      const errorMessage = err?.message || "Erro ao registrar clique";
      const isPersistenceFailure = /supabase|product_clicks/i.test(errorMessage);

      console.error("Erro no POST /api/track-click:", errorMessage);

      if (isPersistenceFailure) {
        return res.status(503).json({
          success: false,
          code: "ANALYTICS_PERSISTENCE_ERROR",
          error: "Não foi possível registrar o clique no Supabase."
        });
      }

      return res.status(500).json({ success: false, error: "Erro interno ao registrar clique" });
    }
  });

  app.get(["/api/meta-feed.csv", "/feed.csv"], async (req, res) => {
    try {
      const allProducts = await productsRepository.getProducts();
      const products = allProducts.filter((p: any) => p.ativo !== false);
      const host = req.headers.host || "localhost:3000";
      const protocol = req.headers["x-forwarded-proto"] || "https";
      const baseUrl = `${protocol}://${host}`;

      const headers = ["id", "title", "description", "availability", "condition", "price", "link", "image_link", "brand"];
      const rows = [headers.join(",")];

      for (const p of products) {
        const slug = p.slug || generateSlug(p.produto);
        const prodLink = `${baseUrl}/produto/${slug}`;
        const mainImage = p.imagens?.[0] || "";
        const titleEscaped = `"${(p.produto || "").replace(/"/g, '""')}"`;
        const descEscaped = `"${((containsRawPayloadMarkers(p.descricao) ? "" : p.descricao) || `Peça curada Cerberus Finds em ${p.categoria}`).replace(/"/g, '""')}"`;
        const priceFormatted = `${Number(p.preco || 0).toFixed(2)} BRL`;

        const row = [
          `"${p.id}"`,
          titleEscaped,
          descEscaped,
          '"in stock"',
          '"new"',
          `"${priceFormatted}"`,
          `"${prodLink}"`,
          `"${mainImage}"`,
          '"Cerberus Finds"'
        ];
        rows.push(row.join(","));
      }

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="meta-catalog-feed.csv"');
      return res.send(rows.join("\n"));
    } catch (err: any) {
      return res.status(500).send("Erro ao gerar feed Meta: " + err.message);
    }
  });

  app.get(["/api/meta-feed.xml", "/feed.xml"], async (req, res) => {
    try {
      const allProducts = await productsRepository.getProducts();
      const products = allProducts.filter((p: any) => p.ativo !== false);
      const host = req.headers.host || "localhost:3000";
      const protocol = req.headers["x-forwarded-proto"] || "https";
      const baseUrl = `${protocol}://${host}`;

      let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
      xml += `<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n`;
      xml += `  <channel>\n`;
      xml += `    <title>Cerberus Finds Catalog Feed</title>\n`;
      xml += `    <link>${baseUrl}</link>\n`;
      xml += `    <description>Catálogo Curatorial de Produtos Afiliados Cerberus Finds</description>\n`;

      for (const p of products) {
        const slug = p.slug || generateSlug(p.produto);
        const prodLink = `${baseUrl}/produto/${slug}`;
        const mainImage = p.imagens?.[0] || "";
        const priceFormatted = `${Number(p.preco || 0).toFixed(2)} BRL`;

        xml += `    <item>\n`;
        xml += `      <g:id>${p.id}</g:id>\n`;
        xml += `      <g:title><![CDATA[${p.produto}]]></g:title>\n`;
        const publicDescription = (containsRawPayloadMarkers(p.descricao) ? "" : p.descricao) || `Peça curada Cerberus Finds em ${p.categoria}`;
        xml += `      <g:description><![CDATA[${publicDescription}]]></g:description>\n`;
        xml += `      <g:link>${prodLink}</g:link>\n`;
        xml += `      <g:image_link>${mainImage}</g:image_link>\n`;
        xml += `      <g:brand>Cerberus Finds</g:brand>\n`;
        xml += `      <g:condition>new</g:condition>\n`;
        xml += `      <g:availability>in stock</g:availability>\n`;
        xml += `      <g:price>${priceFormatted}</g:price>\n`;
        xml += `    </item>\n`;
      }

      xml += `  </channel>\n`;
      xml += `</rss>`;

      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      return res.send(xml);
    } catch (err: any) {
      return res.status(500).send("Erro ao gerar feed XML Meta: " + err.message);
    }
  });

  // Legacy arbitrary Apps Script proxy is intentionally retired. It accepted a
  // caller-controlled URL and therefore cannot safely remain as a generic fetch proxy.
  app.post("/api/submit-product", requireAdminAuth, (_req, res) => {
    return res.status(410).json({
      success: false,
      code: "LEGACY_APPS_SCRIPT_DISABLED",
      error: "Fluxo legado de Apps Script desativado. Use /api/products."
    });
  });

  app.post("/api/extract", requireAdminAuth, async (req, res) => {
    if (!enforceRateLimit(expensiveOperationRateLimiter, req, res)) return;
    try {
      const { url, rawText } = req.body;
      if (!url && !rawText) {
        return res.status(400).json({
          success: false,
          error: "É necessário fornecer a URL do produto ou o texto copiado."
        });
      }

      const products = await productsRepository.getProducts();
      const nextRef = `REF-${(products.length + 1).toString().padStart(3, "0")}`;

      const targetUrl = url ? url.trim() : "";
      console.log(`[Extraction] Executando scraper confiável para URL="${targetUrl}"`);

      const scraped = await fetchProductDataFromUrl(targetUrl, rawText || "");
      const scrapedTitle = scraped.title;
      const scrapedPrice = scraped.price;
      const scrapedImages = scraped.images;
      const scrapedContent = scraped.rawContent;

      if (scrapedPrice === null || scrapedPrice <= 0) {
        console.warn(`[Extraction Notice] Preço não identificado automaticamente no anúncio: ${targetUrl}. Extração de título e imagens prossegue normalmente.`);
      }

      if (scrapedImages.length < 2) {
        console.warn(`[Extraction Warning] Anúncio possui menos de duas imagens (${scrapedImages.length} obtida(s)).`);
      }

      const hasAnyContent = Boolean(
        scrapedTitle ||
        scrapedImages.length > 0 ||
        (scrapedContent && scrapedContent.trim().length > 30) ||
        (rawText && rawText.trim().length > 10)
      );

      if (!hasAnyContent) {
        console.warn(`[Extraction Failed] Nenhuma informação pôde ser extraída da URL ou texto: ${targetUrl}`);
        return res.status(422).json({
          success: false,
          error: "Erro de extração: Não foi possível obter informações da URL fornecida.",
          details: "Cole o texto da página manualmente para continuar."
        });
      }

      const prompt = `DADOS EXTRAÍDOS DO SCRAPER:
- Título Bruto: "${scrapedTitle || 'Extrair do texto abaixo'}"
- Preço Real Detectado: ${scrapedPrice !== null ? `R$ ${scrapedPrice.toFixed(2)}` : 'NÃO ENCONTRADO (Manter null, NUNCA inventar preço)'}
- Imagens Oficiais Extraídas: ${scrapedImages.length} imagens

TEXTO COMPLETO DO ANÚNCIO:
"""
${scrapedContent.slice(0, 3000)}
"""

TAREFAS DO GEMINI:
1. "produto": Limpe e formate o título real em Português no estilo editorial e curatorial Cerberus. Remova jargões de marketplace como "PROMOÇÃO IMPERDÍVEL", "TOP SELLER", "ENVIO GRÁTIS", "FRETE GRÁTIS", "SHOPEE", "MERCADO LIVRE", "100% ORIGINAL". (Exemplo: "Camiseta Heavy Cotton Oversized").
2. "descricao": Escreva uma descrição curta de no máximo 2 frases no tom cru, direto e curatorial da marca Cerberus (foco em tecido, corte e caimento).
3. "categoria": Sugira uma das seguintes categorias: "Camisetas", "Calças", "Acessórios", "Calçados", "Jaquetas", "Moletons".`;

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
          systemInstruction: `Você é o assistente de IA curador da marca "Cerberus Finds".
Sua função é APENAS formatar o título do produto, gerar a descrição de 2 frases e sugerir a categoria.
NUNCA modifique ou invente preços ou imagens.`,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              produto: { type: Type.STRING, description: "Nome limpo e editorial do produto" },
              descricao: { type: Type.STRING, description: "Descrição de no máximo 2 frases no tom cru e curatorial" },
              categoria: { type: Type.STRING, description: "Categoria sugerida" }
            },
            required: ["produto", "descricao", "categoria"]
          }
        }
      });

      const text = response.text || "{}";
      let data: any = {};
      try {
        data = JSON.parse(text);
      } catch {
        data = { produto: "" };
      }

      const finalTitle = data.produto || scrapedTitle || "Produto Cerberus";
      if (!finalTitle || finalTitle.trim().length === 0) {
        return res.status(422).json({
          success: false,
          error: "Erro de extração: Não foi possível obter o título real do produto.",
          details: "Cole o texto da página manualmente para continuar."
        });
      }

      const generatedSlug = generateSlug(finalTitle);

      return res.json({
        success: true,
        data: {
          produto: finalTitle,
          preco: scrapedPrice,
          imagens: scrapedImages,
          descricao: data.descricao || "",
          categoria: data.categoria || "Acessórios",
          ref: nextRef,
          slug: generatedSlug
        }
      });
    } catch (err: any) {
      console.error("Erro no Gemini extraction:", err);
      return res.status(500).json({
        success: false,
        error: "Erro na extração por IA. Preencha os campos manualmente ou cole o texto da página.",
        details: err?.message || String(err)
      });
    }
  });

  app.post(["/api/automation/process", "/api/process-url"], requireAdminAuth, async (req, res) => {
    if (!enforceRateLimit(expensiveOperationRateLimiter, req, res)) return;
    try {
      const { url } = req.body;
      if (!url) {
        return res.status(400).json({ success: false, error: "URL do produto é obrigatória" });
      }
      const result = await processProductUrl(url, { source: "REST API" });
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  // Operational Telegram diagnostics are admin-only.
  app.get(["/api/telegram-status", "/api/telegram/status"], requireAdminAuth, async (_req, res) => {
    try {
      const telegram = await getTelegramWebhookDiagnostics();
      const operatorState = cerberusOperator.getOperatorPersistenceState();
      const backendSha = process.env.RENDER_GIT_COMMIT || process.env.RENDER_GIT_COMMIT_SHA || undefined;
      return res.json({
        configured: telegram.configured,
        tokenConfigured: telegram.tokenConfigured,
        whitelistConfigured: telegram.whitelistConfigured,
        effectiveWhitelistConfigured: telegram.effectiveWhitelistConfigured,
        webhookConfigured: telegram.webhookConfigured,
        webhookMatchesExpectedUrl: telegram.webhookMatchesExpectedUrl,
        webhookUrl: telegram.webhookUrl,
        expectedWebhookUrl: telegram.expectedWebhookUrl,
        webhookLastError: telegram.webhookLastError,
        pendingUpdates: telegram.pendingUpdates,
        allowedUpdates: telegram.allowedUpdates,
        apiHealthy: telegram.apiHealthy,
        backendReady: telegram.backendReady,
        secretConfigured: telegram.secretConfigured,
        lastWebhookCheck: telegram.lastWebhookCheck,
        operatorState: operatorState.status,
        operatorStateReason: operatorState.reason,
        backendSha,
      });
    } catch (error: any) {
      return res.status(503).json({
        success: false,
        error: "Falha ao consultar diagnóstico do Telegram: " + (error?.message || "erro desconhecido"),
      });
    }
  });

  app.post(["/api/telegram-set-webhook", "/api/telegram/set-webhook"], requireAdminAuth, async (req, res) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      return res.status(400).json({ success: false, error: "TELEGRAM_BOT_TOKEN é necessário para configurar o Webhook." });
    }

    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    if (!webhookSecret) {
      return res.status(503).json({
        success: false,
        code: "TELEGRAM_WEBHOOK_SECRET_REQUIRED",
        error: "TELEGRAM_WEBHOOK_SECRET deve estar configurado antes de registrar o webhook."
      });
    }

    const webhookUrl = getExpectedTelegramWebhookUrl();
    const requestedUrl = typeof req.body?.webhookUrl === "string" ? req.body.webhookUrl.replace(/\/+$/, "") : undefined;
    if (requestedUrl && requestedUrl !== webhookUrl) {
      return res.status(400).json({ success: false, error: "A URL enviada diverge da URL canônica do backend; nenhuma alteração foi feita.", expectedWebhookUrl: webhookUrl });
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const tgRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhookUrl, secret_token: webhookSecret }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const tgData = await tgRes.json().catch(() => ({}));
      const diagnostics = tgData?.ok ? await getTelegramWebhookDiagnostics() : undefined;
      return res.status(tgData?.ok ? 200 : 502).json({
        success: Boolean(tgData?.ok),
        description: typeof tgData?.description === "string" ? tgData.description.slice(0, 240) : undefined,
        webhookUrl,
        diagnostics,
      });
    } catch (err: any) {
      return res.status(502).json({ success: false, error: "Falha ao comunicar com a API do Telegram: " + (err?.message || "erro desconhecido") });
    }
  });

  app.post(["/api/telegram/webhook", "/api/telegram-webhook"], (req, res) => {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    if (!token || !webhookSecret) {
      return res.status(503).json({ ok: false, error: "Webhook Telegram não configurado de forma segura." });
    }

    const providedSecret = String(req.headers["x-telegram-bot-api-secret-token"] || "").trim();
    if (providedSecret !== webhookSecret) {
      return res.status(403).json({ ok: false, error: "Webhook Telegram não autorizado." });
    }

    res.status(200).json({ ok: true, status: "Update recebido e enfileirado assincronamente" });

    setImmediate(() => {
      handleTelegramWebhookUpdate(req.body).catch((err) => {
        console.error("❌ [Telegram Async Error] Erro ao processar update assíncrono:", err);
      });
    });
  });

  app.get("/api/proxy-csv", requireAdminAuth, async (req, res) => {
    try {
      const csvUrl = req.query.url as string;
      if (!csvUrl) {
        return res.status(400).json({ error: "URL do CSV não informada" });
      }

      if (!isValidCsvProxyUrl(csvUrl)) {
        return res.status(400).json({
          error: "Acesso negado: URL inválida ou não autorizada. Apenas URLs HTTPS oficiais do Google Sheets são permitidas."
        });
      }

      let fetchRes = await fetchWithTimeout(csvUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        },
        redirect: "manual"
      });

      if (fetchRes.status >= 300 && fetchRes.status < 400) {
        const redirectUrl = fetchRes.headers.get("location");
        if (!redirectUrl || !isValidCsvProxyUrl(redirectUrl)) {
          return res.status(400).json({
            error: "Acesso negado: O redirecionamento aponta para um destino não autorizado."
          });
        }
        fetchRes = await fetchWithTimeout(redirectUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
          },
          redirect: "error"
        });
      }

      if (!fetchRes.ok) {
        throw new Error(`HTTP Status ${fetchRes.status}`);
      }
      const csvText = await fetchRes.text();
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      return res.send(csvText);
    } catch (err: any) {
      return res.status(500).json({ error: "Erro ao buscar planilha CSV: " + err.message });
    }
  });

  if (productsRepository.supabase) {
    setCommercialBrainClient(productsRepository.supabase as any);
    setPolicyJournalClient(productsRepository.supabase as any);
  }
  registerCommercialBrainRoutes({ app, requireAdminAuth });
  setupPreviewTelegramRoutes({ app, requireAdminAuth });
  registerPolicyEngineRoutes({ app, requireAdminAuth });

  if (productsRepository.supabase) {
    setAgentExecutionClient(productsRepository.supabase as any);
  }
  registerAgentRuntimeRoutes({ app, requireAdminAuth });

  if (productsRepository.supabase) {
    setExperimentClient(productsRepository.supabase as any);
  }
  registerExperimentRoutes({ app, requireAdminAuth });

  if (productsRepository.supabase) {
    setCandidatesClient(productsRepository.supabase as any);
  }
  registerCandidateRoutes({ app, requireAdminAuth });
  setupDiscoveryRoutes({ app, requireAdminAuth });
  registerResearchBatchRoutes({ app, requireAdminAuth });

  const n2SourceConnectorsRegistered = registerN2SourceConnectors();
  if (!n2SourceConnectorsRegistered) {
    console.error("[N10] Falha ao registrar Source Connectors N2 — discovery por URL permanecerá indisponível.");
  }

  if (productsRepository.supabase) {
    setCandidateEvidenceClient(productsRepository.supabase as any);
  }
  registerResearchRoutes({ app, requireAdminAuth });

  if (productsRepository.supabase) {
    setCandidateAssessmentClient(productsRepository.supabase as any);
  }
  registerAssessmentRoutes(app, requireAdminAuth);
  registerPublicationRoutes(app, requireAdminAuth);

  if (productsRepository.supabase) {
    setAffiliateClient(productsRepository.supabase as any);
  }

  const shopeeAppId = (process.env.SHOPEE_APP_ID?.trim() || process.env.SHOPEE_AFFILIATE_APP_ID?.trim()) ?? "";
  const shopeeSecret = (process.env.SHOPEE_APP_SECRET?.trim() || process.env.SHOPEE_AFFILIATE_APP_SECRET?.trim()) ?? "";
  if (shopeeAppId && shopeeSecret) {
    try {
      setAffiliateApiSource(
        createShopeeAffiliateProvider({
          providerId: "affprv-shopee",
          appId: shopeeAppId,
          secret: shopeeSecret,
          baseUrl: process.env.SHOPEE_AFFILIATE_API_BASE_URL?.trim() || undefined,
        }).apiSource(),
      );
      console.log(
        "[N8] fonte oficial Shopee afiliados inicializada (endpoint: " +
          (process.env.SHOPEE_AFFILIATE_API_BASE_URL || "default BR") + ")",
      );
    } catch (err) {
      console.warn(
        "[N8] fonte oficial Shopee afiliados NÃO inicializada (falha fechada): " +
          ((err as Error)?.message || String(err)),
      );
      setAffiliateApiSource(null);
    }
  } else {
    setAffiliateApiSource(null);
  }
  registerAffiliateRoutes(app, requireAdminAuth);

  if (productsRepository.supabase) {
    setN17RuntimeDeps(
      createN17RuntimeDeps(
        productsRepository.supabase as any,
        getAffiliateApiSource(),
      ),
    );
  } else {
    setN17RuntimeDeps(null);
  }
  registerN17Routes(app, requireAdminAuth);
  registerCurationRoutes(app, requireAdminAuth);
  registerCommercialBrainCandidatesRoutes(app, requireAdminAuth);
  registerGovernanceRoutes(app, requireAdminAuth);

  const n16AssessmentClient = getCandidateAssessmentClient();
  if (n16AssessmentClient) setPublicationExecutionsClient(n16AssessmentClient as any);
  const n16FakeMode = process.env.N16_PHASE4_FAKE_PROVIDER_MODE || process.env.N16_PHASE2_FAKE_PROVIDER_MODE;
  if (n16FakeMode === "success" || n16FakeMode === "failure" || n16FakeMode === "ambiguous") {
    setN16PublicationProvider(new FakePublicationProvider(n16FakeMode as FakePublicationProviderMode));
  } else {
    setN16PublicationProvider(null);
  }
  registerPublicationN16Routes(app, requireAdminAuth);

  if (productsRepository.supabase) {
    setCycleClient(productsRepository.supabase as any);
  }
  registerCycleRoutes(app, requireAdminAuth, productsRepository.supabase);

  app.use("/api", diagRoutes);

  if (process.env.NODE_ENV !== "production") {
    app.use(express.static(path.join(process.cwd(), "public")));
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");

    app.get("/produto/:slug", async (req, res, next) => {
      if (!isSocialCrawler(req.headers["user-agent"])) return next();
      try {
        const product = await productsRepository.getProductByIdOrSlug(req.params.slug);
        if (!product || product.ativo === false || product.status !== "published") return next();
        const publicOrigin = (process.env.PUBLIC_SITE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
        const title = product.displayTitle || product.produto;
        const description = (product.curatorNote || product.descricao || "Peça selecionada pela curadoria Cerberus Finds.").replace(/\s+/g, " ").trim().slice(0, 180);
        const image = Array.isArray(product.imagens) ? product.imagens[0] : "";
        const canonicalUrl = `${publicOrigin}/produto/${encodeURIComponent(product.slug || product.id)}`;
        const imageTag = image ? `<meta property="og:image" content="${escapeHtml(image)}"><meta name="twitter:image" content="${escapeHtml(image)}">` : "";
        res.type("html").send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><link rel="canonical" href="${escapeHtml(canonicalUrl)}"><meta property="og:type" content="product"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(canonicalUrl)}">${imageTag}<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"></head><body><p>${escapeHtml(title)}</p></body></html>`);
      } catch (error: any) {
        console.error("[OpenGraph] Falha ao montar prévia social:", error?.message || error);
        next();
      }
    });

    app.get("/data/*", (req, res) => {
      const dataRoot = path.resolve(distPath, "data");
      const filePath = path.resolve(distPath, `.${req.path}`);
      if (!filePath.startsWith(`${dataRoot}${path.sep}`)) {
        return res.status(400).json({ error: "Caminho de arquivo inválido." });
      }
      return res.sendFile(filePath);
    });

    app.use(express.static(distPath, { index: false }));
    app.use(express.static(path.join(process.cwd(), "public")));

    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server Cerberus Finds rodando na porta ${PORT}`);

    void startTelegramPolling().catch((error) => {
      console.error("[Telegram] Falha não tratada na inicialização independente:", error?.message || error);
    });

    void registerTelegramCommands()
      .then((result) => {
        if (result.ok) {
          console.log("[Telegram] Menu de comandos registrado (setMyCommands).");
        } else {
          console.warn(`[Telegram] setMyCommands não registrado: ${result.reason || "erro desconhecido"}`);
        }
      })
      .catch((error) => {
        console.warn("[Telegram] setMyCommands falhou na inicialização (processo mantido operacional):", error?.message || error);
      });

    void cerberusOperator.initializeOperatorState()
      .then((boot) => {
        console.log(`[OPERATOR] Boot recovery: ${boot.ready ? "READY" : "SAFE_MODE"} — ${boot.reason}`);
      })
      .catch((error) => {
        console.error("[OPERATOR] Falha não tratada no boot recovery; processo mantido operacional em SAFE_MODE:", error?.message || error);
      });

    // Scheduler is opt-in until Supabase persistence is demonstrably healthy.
    if (process.env.OPERATOR_SCHEDULER_ENABLED === "true") {
      try {
        cerberusOperator.startOperatorScheduler();
      } catch (error: any) {
        console.error("[OPERATOR SCHEDULER] Falha ao iniciar scheduler; HTTP e Telegram continuam disponíveis:", error?.message || error);
      }
    } else {
      console.log("[OPERATOR SCHEDULER] disabled (set OPERATOR_SCHEDULER_ENABLED=true only after persistence validation)");
    }

    try {
      startNewsletterOutboxWorker();
    } catch {
      console.error("[NEWSLETTER-OUTBOX] worker.failed_to_start");
    }

    try {
      startNewsletterCampaignWorker();
    } catch {
      console.error("[NEWSLETTER-CAMPAIGN] worker.failed_to_start");
    }

    try {
      startNewsletterCampaignRetentionScheduler();
    } catch {
      console.error("[NEWSLETTER-RETENTION] scheduler.failed_to_start");
    }
  });
}

startServer();
