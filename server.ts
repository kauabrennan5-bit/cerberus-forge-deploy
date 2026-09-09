import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import { INITIAL_PRODUCTS, generateSlug } from "./src/data/initialProducts";
import { toPublicProductDTO, toPublicProductList } from "./src/lib/publicProductDto";
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
import { startTelegramPublicationReconciler } from "./server/services/telegramPublicationReconciler";
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
import { registerTelegramCommands } from "./server/services/telegramPanel";
import { containsRawPayloadMarkers } from "./server/services/productLifecycle";
import { listPublicSocialLinks } from "./server/services/socialLinks";
import { setCommercialBrainClient } from "./server/repositories/commercialBrainRepository";
import { registerCommercialBrainRoutes } from "./server/routes/commercialBrainRoutes";
import { registerNewsletterWeeklyRoutes } from "./server/routes/newsletterWeeklyRoutes";
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
import { createN17RuntimeDeps, setN17RuntimeDeps } from "./server/commercial/affiliate/n17Runtime";
import { registerN17Routes } from "./server/commercial/affiliate/n17Routes";
import { getAffiliateApiSource, setAffiliateApiSource } from "./server/commercial/affiliate/acquisitionService";
import { createShopeeAffiliateProvider } from "./server/commercial/affiliate/shopeeAffiliateProvider";
import { registerCycleRoutes } from "./server/commercial/cycle/cycleRepository";
import diagRoutes from "./server/routes/diagRoutes";
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
    try { return await fetch(url, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timeout); }
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
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const isSocialCrawler = (userAgent: unknown): boolean => /facebookexternalhit|facebot|twitterbot|slackbot|discordbot|linkedinbot|whatsapp|telegrambot|pinterestbot|embedly/i.test(String(userAgent || ""));

  const enforceRateLimit = (limiter: InMemoryRateLimiter, req: express.Request, res: express.Response): boolean => {
    const decision = limiter.check(requestKey(req));
    res.setHeader("X-RateLimit-Remaining", String(decision.remaining));
    if (decision.allowed) return true;
    res.setHeader("Retry-After", String(decision.retryAfterSeconds));
    res.status(429).json({ success: false, code: "RATE_LIMITED", error: "Limite temporário atingido. Aguarde antes de tentar novamente.", retryAfterSeconds: decision.retryAfterSeconds });
    return false;
  };

  app.get("/health", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ status: "ok", service: "cerberus-forge-deploy", version: process.env.RENDER_GIT_COMMIT || process.env.RENDER_GIT_COMMIT_SHA || "unknown", timestamp: new Date().toISOString() });
  });

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } });

  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-admin-password");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
  });

  const isValidCsvProxyUrl = (rawUrl: string): boolean => {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "https:") return false;
      const hostname = parsed.hostname.toLowerCase();
      const forbiddenHostnames = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "169.254.169.254", "metadata.google.internal"];
      if (forbiddenHostnames.includes(hostname)) return false;
      if (/^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname) || /^0\./.test(hostname) || /^169\.254\./.test(hostname)) return false;
      const allowedDomains = ["docs.google.com", "drive.google.com", "googleusercontent.com", "sheets.googleapis.com"];
      return allowedDomains.some(domain => hostname === domain || hostname.endsWith("." + domain));
    } catch { return false; }
  };

  const requireAdminAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!enforceRateLimit(adminRateLimiter, req, res)) return;
    const rawAdminPassEnv = (process.env.ADMIN_PASSWORD || "").trim();
    if (!rawAdminPassEnv) return res.status(401).json({ success: false, error: "Acesso administrativo desativado: a variável ADMIN_PASSWORD não está configurada no ambiente do servidor." });
    const authHeader = (req.headers["x-admin-password"] as string) || "";
    const bearerHeader = (req.headers["authorization"] as string) || "";
    const bearerPass = bearerHeader.startsWith("Bearer ") ? bearerHeader.slice(7).trim() : "";
    const bodyPass = (req.body && req.body.senha) ? String(req.body.senha) : "";
    const queryPass = (req.query && req.query.senha) ? String(req.query.senha) : "";
    const providedPass = (authHeader || bearerPass || bodyPass || queryPass).trim();
    if (!providedPass) return res.status(401).json({ success: false, error: "Acesso administrativo não autorizado. Senha ausente." });
    const isEnvHashed = rawAdminPassEnv.startsWith("$2a$") || rawAdminPassEnv.startsWith("$2b$") || rawAdminPassEnv.startsWith("$2y$");
    const targetHash = isEnvHashed ? rawAdminPassEnv : bcrypt.hashSync(rawAdminPassEnv, 10);
    if (!bcrypt.compareSync(providedPass, targetHash)) return res.status(401).json({ success: false, error: "Acesso administrativo não autorizado. Senha incorreta." });
    next();
  };

  app.post("/api/admin/verify", requireAdminAuth, (_req, res) => res.json({ success: true, message: "Senha de administrador verificada com sucesso!" }));

  app.post("/api/newsletter", async (req, res) => {
    if (!enforceRateLimit(newsletterRateLimiter, req, res)) return;
    const email = normalizeNewsletterEmail(req.body?.email);
    if (!isValidNewsletterEmail(email)) return res.status(400).json({ success: false, code: "INVALID_EMAIL", error: "Informe um e-mail válido." });
    if (!isExplicitMarketingConsent(req.body?.marketingConsent)) return res.status(400).json({ success: false, code: "CONSENT_REQUIRED", error: "É necessário confirmar o consentimento para receber comunicações por e-mail." });
    try {
      const client = productsRepository.requireSupabase();
      const q7Args = buildNewsletterQ7RpcArgs(email, req.body?.marketingConsent);
      const { data, error } = await client.rpc("confirm_newsletter_consent_with_outbox", q7Args);
      if (error) {
        const q7Code = classifyNewsletterQ7Error(error);
        if (q7Code === "NEWSLETTER_RECONSENT_REQUIRED") return res.status(409).json({ success: false, code: "RECONSENT_REQUIRED", error: "Este contato exige um fluxo explícito de reativação." });
        if (q7Code === "CONSENT_REQUIRED") return res.status(400).json({ success: false, code: "CONSENT_REQUIRED", error: "É necessário confirmar o consentimento para receber comunicações por e-mail." });
        if (q7Code === "OUTBOX_IDEMPOTENCY_COLLISION") return res.status(409).json({ success: false, code: "IDEMPOTENCY_COLLISION", error: "A intenção de inscrição não coincide com a intenção já registrada." });
        throw error;
      }
      const q7Row = extractNewsletterQ7Row(data);
      if (!q7Row) throw new Error("NEWSLETTER_Q7_INVALID_RESPONSE");
      return res.status(q7Row.replayed ? 200 : 201).json({ success: true, message: q7Row.replayed ? "Inscrição já registrada." : "Inscrição registrada.", result: q7Row.result, replayed: q7Row.replayed });
    } catch (error: any) {
      const q7Code = classifyNewsletterQ7Error(error);
      console.error("[Newsletter] Falha ao registrar inscrição:", q7Code);
      return res.status(503).json({ success: false, code: "NEWSLETTER_UNAVAILABLE", error: "Cadastro temporariamente indisponível." });
    }
  });

  const applyUnsubscribe = async (token: string): Promise<void> => {
    if (token.length < 32 || token.length > 256) throw new Error("INVALID_UNSUBSCRIBE_TOKEN");
    const client = productsRepository.requireSupabase();
    const { error } = await client.from("newsletter_subscribers").update(buildUnsubscribeUpdate()).eq("unsubscribe_token_hash", hashUnsubscribeToken(token)).eq("status", "subscribed").gt("unsubscribe_token_expires_at", new Date().toISOString()).select("status").limit(1);
    if (error) throw error;
  };

  app.get("/api/institutional/social-links", async (req, res) => {
    if (!enforceRateLimit(newsletterRateLimiter, req, res)) return;
    try { res.setHeader("Cache-Control", "no-store"); return res.status(200).json({ success: true, links: await listPublicSocialLinks() }); }
    catch (error: any) { console.error("[Institutional] Falha ao carregar links sociais:", error?.code || error?.message || "unknown_error"); return res.status(503).json({ success: false, error: "Links sociais temporariamente indisponíveis." }); }
  });

  app.get("/api/newsletter/unsubscribe", async (req, res) => {
    const token = typeof req.query?.token === "string" ? req.query.token.trim() : "";
    try { await applyUnsubscribe(token); return res.status(200).type("html").send("<!doctype html><html lang=\"pt-BR\"><meta charset=\"utf-8\"><title>Descadastro concluído</title><p>Seu descadastro foi concluído. Você não receberá novas campanhas de marketing.</p></html>"); }
    catch (error: any) { if (error?.message === "INVALID_UNSUBSCRIBE_TOKEN") return res.status(400).type("html").send("<!doctype html><html lang=\"pt-BR\"><meta charset=\"utf-8\"><title>Link inválido</title><p>O link de descadastro é inválido ou expirou.</p></html>"); return res.status(503).type("html").send("<!doctype html><html lang=\"pt-BR\"><meta charset=\"utf-8\"><title>Indisponível</title><p>Descadastro temporariamente indisponível.</p></html>"); }
  });
  app.post("/api/newsletter/unsubscribe", async (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    try { await applyUnsubscribe(token); return res.status(204).send(); }
    catch (error: any) { if (error?.message === "INVALID_UNSUBSCRIBE_TOKEN") return res.status(400).json({ success: false, code: "INVALID_UNSUBSCRIBE_TOKEN", error: "Token de descadastro inválido." }); return res.status(503).json({ success: false, code: "NEWSLETTER_UNAVAILABLE", error: "Descadastro temporariamente indisponível." }); }
  });

  app.post("/api/admin/rebuild-static-catalog", requireAdminAuth, async (_req, res) => {
    try { const { syncCatalogAndDeploy } = await import("./server/services/catalogSync"); const result = await syncCatalogAndDeploy("Rebuild Administrativo Manual"); return res.json({ success: result.success, message: result.success ? "Catálogo estático reconstruído e sincronizado com sucesso!" : "Falha na sincronização do catálogo estático.", data: result }); }
    catch (err: any) { return res.status(500).json({ success: false, error: "Erro interno no rebuild: " + err.message }); }
  });

  app.get("/api/products", async (req, res) => {
    if (!enforceRateLimit(catalogRateLimiter, req, res)) return;
    try {
      const publicProducts = toPublicProductList(await productsRepository.getProducts());
      return res.json({ success: true, products: publicProducts, data: publicProducts });
    } catch (err: any) {
      console.error("❌ [/api/products] Erro de repositório:", err.message);
      return res.status(503).json({ success: false, code: "SUPABASE_PERSISTENCE_ERROR", error: "Não foi possível carregar o catálogo canônico no momento." });
    }
  });

  app.get("/api/products/:idOrSlug", async (req, res) => {
    try {
      const product = await productsRepository.getProductByIdOrSlug(req.params.idOrSlug);
      const publicProduct = product ? toPublicProductDTO(product) : null;
      if (!publicProduct) return res.status(404).json({ success: false, error: "Produto não encontrado" });
      return res.json({ success: true, product: publicProduct });
    } catch (err: any) { return res.status(500).json({ success: false, error: err.message || "Erro ao buscar produto." }); }
  });

  app.post("/api/products", requireAdminAuth, async (req, res) => {
    try {
      const { produto, categoria, preco, imagens, link, descricao } = req.body;
      if (!produto || !link || !categoria || !preco) return res.status(400).json({ success: false, error: "Nome, categoria, preço e link são obrigatórios." });
      const lifecycle = await createProductionProductPipeline().evaluate({ produto, categoria, preco: Number(preco), imagens: Array.isArray(imagens) ? imagens : [], normalizedUrl: link, descricao });
      if (lifecycle.state === "ERROR" || lifecycle.state === "REJECTED") return res.status(400).json({ success: false, error: lifecycle.error || "VALIDATION_ERROR", lifecycle });
      return res.status(202).json({ success: true, message: "Produto avaliado e aguardando aprovação humana no Telegram; nenhuma publicação foi executada por este endpoint.", lifecycle });
    } catch (err: any) { return res.status(500).json({ success: false, error: "Erro de servidor ao cadastrar produto: " + err.message }); }
  });

  const handleDeleteRequest = async (req: express.Request, res: express.Response) => {
    try { const id = req.params.id || req.body?.id; if (!id) return res.status(400).json({ success: false, error: "ID do produto é obrigatório." }); const deleted = await productsRepository.deleteProduct(id); if (!deleted) return res.status(404).json({ success: false, error: "Produto não encontrado." }); return res.json({ success: true, message: "Produto removido com sucesso." }); }
    catch (err: any) { return res.status(500).json({ success: false, error: err.message }); }
  };
  app.delete("/api/products/:id", requireAdminAuth, handleDeleteRequest);
  app.post("/api/products/:id/delete", requireAdminAuth, handleDeleteRequest);
  app.post("/api/products/delete", requireAdminAuth, handleDeleteRequest);

  const handleUpdateRequest = async (req: express.Request, res: express.Response) => {
    try {
      const id = req.params.id || req.body?.id;
      if (!id) return res.status(400).json({ success: false, error: "ID do produto é obrigatório." });
      const { produto, categoria, preco, imagens, link, destaque, descricao, paginaPonteUrl, ativo } = req.body;
      let imagesArray: string[] | undefined;
      if (Array.isArray(imagens)) imagesArray = imagens;
      else if (typeof imagens === "string" && imagens.trim()) imagesArray = imagens.split(" | ").map((s) => s.trim()).filter(Boolean);
      const updatePayload: any = {};
      if (produto !== undefined) updatePayload.produto = String(produto).trim();
      if (categoria !== undefined) updatePayload.categoria = String(categoria).trim();
      if (preco !== undefined) updatePayload.preco = Number(preco) || 0;
      if (imagesArray !== undefined) updatePayload.imagens = imagesArray;
      if (link !== undefined) updatePayload.link = String(link).trim();
      if (destaque !== undefined) updatePayload.destaque = Boolean(destaque);
      if (descricao !== undefined) { const normalizedDescription = String(descricao).trim(); if (containsRawPayloadMarkers(normalizedDescription)) return res.status(400).json({ success: false, code: "RAW_PAYLOAD_DESCRIPTION_REJECTED", error: "Descrição técnica do scraper não pode ser gravada como conteúdo editorial." }); updatePayload.descricao = normalizedDescription; }
      if (paginaPonteUrl !== undefined) updatePayload.paginaPonteUrl = String(paginaPonteUrl).trim();
      if (ativo !== undefined) updatePayload.ativo = Boolean(ativo);
      const updated = await productsRepository.updateProduct(id, updatePayload);
      if (!updated) return res.status(404).json({ success: false, error: "Produto não encontrado para atualização." });
      return res.json({ success: true, message: "Produto atualizado com sucesso!", product: updated });
    } catch (err: any) { return res.status(500).json({ success: false, error: "Erro no servidor ao atualizar produto: " + err.message }); }
  };
  app.put("/api/products/:id", requireAdminAuth, handleUpdateRequest);
  app.post("/api/products/:id/edit", requireAdminAuth, handleUpdateRequest);
  app.post("/api/products/:id/update", requireAdminAuth, handleUpdateRequest);

  app.post("/api/meta-capi", async (req, res) => {
    if (!enforceRateLimit(analyticsRateLimiter, req, res)) return;
    try {
      const { event_name, event_id, product, metaPixelId, metaAccessToken } = req.body;
      const pixelId = metaPixelId || process.env.META_PIXEL_ID;
      const accessToken = metaAccessToken || process.env.META_ACCESS_TOKEN;
      const clientIp = (req.headers["x-forwarded-for"] as string || req.socket.remoteAddress || "").split(",")[0].trim();
      const userAgent = req.headers["user-agent"] || "";
      if (pixelId && accessToken) {
        const payload = { data: [{ event_name: event_name || "InitiateCheckout", event_time: Math.floor(Date.now() / 1000), event_id, event_source_url: req.headers.referer || "", action_source: "website", user_data: { client_ip_address: clientIp, client_user_agent: userAgent }, custom_data: { content_name: product?.produto || "Produto Cerberus", content_ids: [product?.id || "prod-001"], content_type: "product", value: product?.preco || 0, currency: "BRL" } }] };
        const capiRes = await fetchWithTimeout(`https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${accessToken}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        return res.json({ success: true, metaResponse: await capiRes.json(), event_id, deduplicated: true });
      }
      return res.json({ success: true, message: "Evento CAPI registrado e formatado para deduplicação (Aguardando Meta Access Token nas Configurações)", event_id, deduplicated: true });
    } catch (err: any) { return res.status(500).json({ success: false, error: err.message }); }
  });

  app.post("/api/track-click", async (req, res) => {
    if (!enforceRateLimit(analyticsRateLimiter, req, res)) return;
    try {
      const { productId, productSlug, productName, productPrice, utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, gclid, ttclid, referrer, landingPage } = req.body || {};
      if (!productId) return res.status(400).json({ success: false, error: "productId é obrigatório" });
      const realProduct = await productsRepository.getProductByIdOrSlug(productId);
      if (!realProduct) return res.status(404).json({ success: false, code: "PRODUCT_NOT_FOUND", error: "Produto não localizado na fonte canônica." });
      const clientIp = (req.headers["x-forwarded-for"] as string || req.socket.remoteAddress || "").split(",")[0].trim();
      await productsRepository.recordProductClick({ productId, productSlug: realProduct.slug || productSlug || productId, productName: realProduct.produto || productName || productId, productPrice: realProduct.preco ?? Number(productPrice) ?? 0, utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, gclid, ttclid, referrer, landingPage, userAgent: req.headers["user-agent"] || "", ipAddress: clientIp });
      return res.json({ success: true, message: "Clique de produto registrado com sucesso" });
    } catch (err: any) { const errorMessage = err?.message || "Erro ao registrar clique"; return /supabase|product_clicks/i.test(errorMessage) ? res.status(503).json({ success: false, code: "ANALYTICS_PERSISTENCE_ERROR", error: "Não foi possível registrar o clique no Supabase." }) : res.status(500).json({ success: false, error: "Erro interno ao registrar clique" }); }
  });

  app.get(["/api/meta-feed.csv", "/feed.csv"], async (req, res) => {
    try {
      const products = toPublicProductList(await productsRepository.getProducts());
      const host = req.headers.host || "localhost:3000";
      const protocol = req.headers["x-forwarded-proto"] || "https";
      const baseUrl = `${protocol}://${host}`;
      const rows = [["id", "title", "description", "availability", "condition", "price", "link", "image_link", "brand"].join(",")];
      for (const p of products) {
        const slug = p.slug || generateSlug(p.produto);
        const titleEscaped = `"${p.produto.replace(/"/g, '""')}"`;
        const descEscaped = `"${(p.descricao || `Peça curada Cerberus Finds em ${p.categoria}`).replace(/"/g, '""')}"`;
        rows.push([`"${p.id}"`, titleEscaped, descEscaped, '"in stock"', '"new"', `"${Number(p.preco).toFixed(2)} BRL"`, `"${baseUrl}/produto/${slug}"`, `"${p.imagens?.[0] || ""}"`, '"Cerberus Finds"'].join(","));
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8"); res.setHeader("Content-Disposition", 'attachment; filename="meta-catalog-feed.csv"'); return res.send(rows.join("\n"));
    } catch (err: any) { return res.status(500).send("Erro ao gerar feed Meta: " + err.message); }
  });

  app.get(["/api/meta-feed.xml", "/feed.xml"], async (req, res) => {
    try {
      const products = toPublicProductList(await productsRepository.getProducts());
      const host = req.headers.host || "localhost:3000";
      const protocol = req.headers["x-forwarded-proto"] || "https";
      const baseUrl = `${protocol}://${host}`;
      let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n  <channel>\n    <title>Cerberus Finds Catalog Feed</title>\n    <link>${baseUrl}</link>\n    <description>Catálogo Curatorial de Produtos Afiliados Cerberus Finds</description>\n`;
      for (const p of products) {
        const slug = p.slug || generateSlug(p.produto);
        xml += `    <item>\n      <g:id>${p.id}</g:id>\n      <g:title><![CDATA[${p.produto}]]></g:title>\n      <g:description><![CDATA[${p.descricao || `Peça curada Cerberus Finds em ${p.categoria}`}]]></g:description>\n      <g:link>${baseUrl}/produto/${slug}</g:link>\n      <g:image_link>${p.imagens?.[0] || ""}</g:image_link>\n      <g:brand>Cerberus Finds</g:brand>\n      <g:condition>new</g:condition>\n      <g:availability>in stock</g:availability>\n      <g:price>${Number(p.preco).toFixed(2)} BRL</g:price>\n    </item>\n`;
      }
      xml += `  </channel>\n</rss>`;
      res.setHeader("Content-Type", "application/xml; charset=utf-8"); return res.send(xml);
    } catch (err: any) { return res.status(500).send("Erro ao gerar feed XML Meta: " + err.message); }
  });

  app.post("/api/submit-product", requireAdminAuth, async (req, res) => {
    try {
      const { appsScriptUrl, senha, produto, categoria, preco, imagens, link, destaque } = req.body;
      if (!appsScriptUrl) return res.status(400).json({ success: false, error: "A URL do Google Apps Script não foi informada." });
      if (!produto || !link) return res.status(400).json({ success: false, error: "Nome do produto e Link são obrigatórios." });
      const payload = { senha, produto, categoria: categoria || "Geral", preco: Number(preco) || 0, imagens: Array.isArray(imagens) ? imagens.join(" | ") : (imagens || ""), link, destaque: Boolean(destaque) };
      const googleRes = await fetchWithTimeout(appsScriptUrl, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(payload) });
      const responseText = await googleRes.text(); let responseJson: any = {}; try { responseJson = JSON.parse(responseText); } catch { responseJson = { result: "sucesso" }; }
      return responseJson.result === "sucesso" || responseJson.status === "ok" || googleRes.ok ? res.json({ success: true, message: "Produto enviado para a planilha com sucesso!" }) : res.status(400).json({ success: false, error: responseJson.message || "Erro ao gravar na planilha do Google." });
    } catch (err: any) { return res.status(500).json({ success: false, error: "Erro de servidor ao enviar produto: " + (err?.message || String(err)) }); }
  });

  app.post("/api/extract", requireAdminAuth, async (req, res) => {
    if (!enforceRateLimit(expensiveOperationRateLimiter, req, res)) return;
    try {
      const { url, rawText } = req.body;
      if (!url && !rawText) return res.status(400).json({ success: false, error: "É necessário fornecer a URL do produto ou o texto copiado." });
      const products = await productsRepository.getProducts();
      const nextRef = `REF-${(products.length + 1).toString().padStart(3, "0")}`;
      const targetUrl = url ? url.trim() : "";
      const scraped = await fetchProductDataFromUrl(targetUrl, rawText || "");
      const scrapedTitle = scraped.title, scrapedPrice = scraped.price, scrapedImages = scraped.images, scrapedContent = scraped.rawContent;
      const hasAnyContent = Boolean(scrapedTitle || scrapedImages.length > 0 || (scrapedContent && scrapedContent.trim().length > 30) || (rawText && rawText.trim().length > 10));
      if (!hasAnyContent) return res.status(422).json({ success: false, error: "Erro de extração: Não foi possível obter informações da URL fornecida.", details: "Cole o texto da página do produto no campo abaixo para continuar." });
      const prompt = `DADOS EXTRAÍDOS DO SCRAPER:\n- Título Bruto: "${scrapedTitle || 'Extrair do texto abaixo'}"\n- Preço Real Detectado: ${scrapedPrice !== null ? `R$ ${scrapedPrice.toFixed(2)}` : 'NÃO ENCONTRADO (Manter null, NUNCA inventar preço)'}\n- Imagens Oficiais Extraídas: ${scrapedImages.length} imagens\n\nTEXTO COMPLETO DO ANÚNCIO:\n"""\n${scrapedContent.slice(0, 3000)}\n"""\n\nTAREFAS DO GEMINI:\n1. "produto": Limpe e formate o título real em Português no estilo editorial e curatorial Cerberus.\n2. "descricao": Escreva uma descrição curta de no máximo 2 frases no tom cru, direto e curatorial da marca Cerberus.\n3. "categoria": Sugira uma categoria pública válida.`;
      const response = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt, config: { systemInstruction: `Você é o assistente de IA curador da marca "Cerberus Finds". NUNCA modifique ou invente preços ou imagens.`, responseMimeType: "application/json", responseSchema: { type: Type.OBJECT, properties: { produto: { type: Type.STRING }, descricao: { type: Type.STRING }, categoria: { type: Type.STRING } }, required: ["produto", "descricao", "categoria"] } } });
      let data: any = {}; try { data = JSON.parse(response.text || "{}"); } catch { data = { produto: "" }; }
      const finalTitle = data.produto || scrapedTitle || "Produto Cerberus";
      if (!finalTitle?.trim()) return res.status(422).json({ success: false, error: "Erro de extração: Não foi possível obter o título real do produto." });
      return res.json({ success: true, data: { produto: finalTitle, preco: scrapedPrice, imagens: scrapedImages, descricao: data.descricao || "", categoria: data.categoria || "Acessórios", ref: nextRef, slug: generateSlug(finalTitle) } });
    } catch (err: any) { return res.status(500).json({ success: false, error: "Erro na extração por IA. Preencha os campos manualmente ou cole o texto da página.", details: err?.message || String(err) }); }
  });

  app.post(["/api/automation/process", "/api/process-url"], requireAdminAuth, async (req, res) => {
    if (!enforceRateLimit(expensiveOperationRateLimiter, req, res)) return;
    try { if (!req.body?.url) return res.status(400).json({ success: false, error: "URL do produto é obrigatória" }); return res.json(await processProductUrl(req.body.url, { source: "REST API" })); }
    catch (err: any) { return res.status(500).json({ success: false, error: err?.message || String(err) }); }
  });

  app.get(["/api/telegram-status", "/api/telegram/status"], async (_req, res) => {
    try { const telegram = await getTelegramWebhookDiagnostics(); const operatorState = cerberusOperator.getOperatorPersistenceState(); return res.json({ ...telegram, operatorState: operatorState.status, operatorStateReason: operatorState.reason, backendSha: process.env.RENDER_GIT_COMMIT || process.env.RENDER_GIT_COMMIT_SHA || undefined }); }
    catch (error: any) { return res.status(200).json({ configured: Boolean(process.env.TELEGRAM_BOT_TOKEN), tokenConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN), webhookConfigured: false, webhookMatchesExpectedUrl: null, apiHealthy: false, backendReady: false, operatorState: cerberusOperator.getOperatorPersistenceState().status, webhookLastError: "Falha ao consultar diagnóstico do Telegram: " + (error?.message || "erro desconhecido"), lastWebhookCheck: new Date().toISOString(), backendSha: process.env.RENDER_GIT_COMMIT || process.env.RENDER_GIT_COMMIT_SHA || undefined }); }
  });

  app.post(["/api/telegram-set-webhook", "/api/telegram/set-webhook"], requireAdminAuth, async (req, res) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return res.status(400).json({ success: false, error: "TELEGRAM_BOT_TOKEN é necessário para configurar o Webhook." });
    const webhookUrl = getExpectedTelegramWebhookUrl();
    const requestedUrl = typeof req.body?.webhookUrl === "string" ? req.body.webhookUrl.replace(/\/+$/, "") : undefined;
    if (requestedUrl && requestedUrl !== webhookUrl) return res.status(400).json({ success: false, error: "A URL enviada diverge da URL canônica do backend; nenhuma alteração foi feita.", expectedWebhookUrl: webhookUrl });
    try {
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15_000);
      const tgRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: webhookUrl, ...(process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ? { secret_token: process.env.TELEGRAM_WEBHOOK_SECRET.trim() } : {}) }), signal: controller.signal }); clearTimeout(timeout);
      const tgData = await tgRes.json().catch(() => ({})); return res.status(tgData?.ok ? 200 : 502).json({ success: Boolean(tgData?.ok), description: typeof tgData?.description === "string" ? tgData.description.slice(0, 240) : undefined, webhookUrl, diagnostics: tgData?.ok ? await getTelegramWebhookDiagnostics() : undefined });
    } catch (err: any) { return res.status(502).json({ success: false, error: "Falha ao comunicar com a API do Telegram: " + (err?.message || "erro desconhecido") }); }
  });

  app.post(["/api/telegram/webhook", "/api/telegram-webhook"], (req, res) => {
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (webhookSecret && req.headers["x-telegram-bot-api-secret-token"] !== webhookSecret) return res.status(403).json({ ok: false, error: "Webhook Telegram não autorizado." });
    res.status(200).json({ ok: true, status: "Update recebido e enfileirado assincronamente" });
    setImmediate(() => { handleTelegramWebhookUpdate(req.body).catch((err) => console.error("❌ [Telegram Async Error]", err)); });
  });

  app.get("/api/proxy-csv", requireAdminAuth, async (req, res) => {
    try {
      const csvUrl = req.query.url as string;
      if (!csvUrl) return res.status(400).json({ error: "URL do CSV não informada" });
      if (!isValidCsvProxyUrl(csvUrl)) return res.status(400).json({ error: "Acesso negado: URL inválida ou não autorizada. Apenas URLs HTTPS oficiais do Google Sheets são permitidas." });
      let fetchRes = await fetchWithTimeout(csvUrl, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, redirect: "manual" });
      if (fetchRes.status >= 300 && fetchRes.status < 400) { const redirectUrl = fetchRes.headers.get("location"); if (!redirectUrl || !isValidCsvProxyUrl(redirectUrl)) return res.status(400).json({ error: "Acesso negado: O redirecionamento aponta para um destino não autorizado." }); fetchRes = await fetchWithTimeout(redirectUrl, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, redirect: "error" }); }
      if (!fetchRes.ok) throw new Error(`HTTP Status ${fetchRes.status}`);
      res.setHeader("Content-Type", "text/csv; charset=utf-8"); return res.send(await fetchRes.text());
    } catch (err: any) { return res.status(500).json({ error: "Erro ao buscar planilha CSV: " + err.message }); }
  });

  if (productsRepository.supabase) { setCommercialBrainClient(productsRepository.supabase as any); setPolicyJournalClient(productsRepository.supabase as any); }
  registerCommercialBrainRoutes({ app, requireAdminAuth });
  registerNewsletterWeeklyRoutes(app);
  setupPreviewTelegramRoutes({ app, requireAdminAuth });
  registerPolicyEngineRoutes({ app, requireAdminAuth });
  if (productsRepository.supabase) setAgentExecutionClient(productsRepository.supabase as any);
  registerAgentRuntimeRoutes({ app, requireAdminAuth });
  if (productsRepository.supabase) setExperimentClient(productsRepository.supabase as any);
  registerExperimentRoutes({ app, requireAdminAuth });
  if (productsRepository.supabase) setCandidatesClient(productsRepository.supabase as any);
  registerCandidateRoutes({ app, requireAdminAuth });
  setupDiscoveryRoutes({ app, requireAdminAuth });
  registerResearchBatchRoutes({ app, requireAdminAuth });
  const n2SourceConnectorsRegistered = registerN2SourceConnectors();
  if (!n2SourceConnectorsRegistered) console.error("[N10] Falha ao registrar Source Connectors N2 — discovery por URL permanecerá indisponível.");
  if (productsRepository.supabase) setCandidateEvidenceClient(productsRepository.supabase as any);
  registerResearchRoutes({ app, requireAdminAuth });
  if (productsRepository.supabase) setCandidateAssessmentClient(productsRepository.supabase as any);
  registerAssessmentRoutes(app, requireAdminAuth);
  registerPublicationRoutes(app, requireAdminAuth);
  if (productsRepository.supabase) setAffiliateClient(productsRepository.supabase as any);
  const shopeeAppId = (process.env.SHOPEE_APP_ID?.trim() || process.env.SHOPEE_AFFILIATE_APP_ID?.trim()) ?? "";
  const shopeeSecret = (process.env.SHOPEE_APP_SECRET?.trim() || process.env.SHOPEE_AFFILIATE_APP_SECRET?.trim()) ?? "";
  if (shopeeAppId && shopeeSecret) {
    try { setAffiliateApiSource(createShopeeAffiliateProvider({ providerId: "affprv-shopee", appId: shopeeAppId, secret: shopeeSecret, baseUrl: process.env.SHOPEE_AFFILIATE_API_BASE_URL?.trim() || undefined }).apiSource()); }
    catch { setAffiliateApiSource(null); }
  } else setAffiliateApiSource(null);
  registerAffiliateRoutes(app, requireAdminAuth);
  if (productsRepository.supabase) setN17RuntimeDeps(createN17RuntimeDeps(productsRepository.supabase as any, getAffiliateApiSource())); else setN17RuntimeDeps(null);
  registerN17Routes(app, requireAdminAuth);
  registerCurationRoutes(app, requireAdminAuth);
  registerCommercialBrainCandidatesRoutes(app, requireAdminAuth);
  registerGovernanceRoutes(app, requireAdminAuth);
  const n16AssessmentClient = getCandidateAssessmentClient();
  if (n16AssessmentClient) setPublicationExecutionsClient(n16AssessmentClient as any);
  const n16FakeMode = process.env.N16_PHASE4_FAKE_PROVIDER_MODE || process.env.N16_PHASE2_FAKE_PROVIDER_MODE;
  if (n16FakeMode === "success" || n16FakeMode === "failure" || n16FakeMode === "ambiguous") setN16PublicationProvider(new FakePublicationProvider(n16FakeMode as FakePublicationProviderMode)); else setN16PublicationProvider(null);
  registerPublicationN16Routes(app, requireAdminAuth);
  if (productsRepository.supabase) setCycleClient(productsRepository.supabase as any);
  registerCycleRoutes(app, requireAdminAuth, productsRepository.supabase);
  app.use("/api", diagRoutes);

  if (process.env.NODE_ENV !== "production") {
    app.use(express.static(path.join(process.cwd(), "public")));
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const publicSiteBase = (process.env.PUBLIC_SITE_URL || "https://cerberus-design-static.onrender.com").replace(/\/+$/, "");
    const publicDataRoot = path.resolve(process.cwd(), "public", "data");
    const redirectToPublicSite = (req: express.Request, res: express.Response) => { const target = new URL(req.originalUrl || req.url || "/", `${publicSiteBase}/`); return res.redirect(302, target.toString()); };

    app.get("/produto/:slug", async (req, res) => {
      if (!isSocialCrawler(req.headers["user-agent"])) return redirectToPublicSite(req, res);
      try {
        const internalProduct = await productsRepository.getProductByIdOrSlug(req.params.slug);
        const product = internalProduct ? toPublicProductDTO(internalProduct) : null;
        if (!product) return res.status(404).type("html").send("<!doctype html><html lang=\"pt-BR\"><meta charset=\"utf-8\"><title>Produto não encontrado</title><p>Produto não encontrado.</p></html>");
        const title = product.displayTitle || product.produto;
        const description = (product.descricao || "Peça selecionada pela curadoria Cerberus Finds.").replace(/\s+/g, " ").trim().slice(0, 180);
        const image = product.imagens?.[0] || "";
        const canonicalUrl = `${publicSiteBase}/produto/${encodeURIComponent(product.slug || product.id)}`;
        const imageTag = image ? `<meta property="og:image" content="${escapeHtml(image)}"><meta name="twitter:image" content="${escapeHtml(image)}">` : "";
        return res.type("html").send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><link rel="canonical" href="${escapeHtml(canonicalUrl)}"><meta property="og:type" content="product"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(canonicalUrl)}">${imageTag}<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"></head><body><p>${escapeHtml(title)}</p></body></html>`);
      } catch { return res.status(503).type("html").send("<!doctype html><html lang=\"pt-BR\"><meta charset=\"utf-8\"><title>Prévia indisponível</title><p>Prévia temporariamente indisponível.</p></html>"); }
    });

    app.get("/data/*", (req, res) => {
      const relativeDataPath = req.path.replace(/^\/data\/?/, "");
      const filePath = path.resolve(publicDataRoot, relativeDataPath);
      if (!relativeDataPath || !filePath.startsWith(`${publicDataRoot}${path.sep}`)) return res.status(400).json({ error: "Caminho de arquivo inválido." });
      return res.sendFile(filePath);
    });
    app.all(["/api", "/api/*"], (_req, res) => res.status(404).json({ success: false, code: "API_ROUTE_NOT_FOUND", error: "Rota de API não encontrada." }));
    app.get("*", redirectToPublicSite);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server Cerberus Finds rodando na porta ${PORT}`);
    void startTelegramPolling().catch((error) => console.error("[Telegram] Falha não tratada na inicialização independente:", error?.message || error));
    void registerTelegramCommands().catch((error) => console.warn("[Telegram] setMyCommands falhou:", error?.message || error));
    try { startTelegramPublicationReconciler(); } catch { console.error("[TELEGRAM-PUBLICATION-RECONCILER] scheduler.failed_to_start"); }
    void cerberusOperator.initializeOperatorState().catch((error) => console.error("[OPERATOR] Falha no boot recovery:", error?.message || error));
    try { cerberusOperator.startOperatorScheduler(); } catch (error: any) { console.error("[OPERATOR SCHEDULER] Falha ao iniciar scheduler:", error?.message || error); }
    try { startNewsletterOutboxWorker(); } catch { console.error("[NEWSLETTER-OUTBOX] worker.failed_to_start"); }
    try { startNewsletterCampaignWorker(); } catch { console.error("[NEWSLETTER-CAMPAIGN] worker.failed_to_start"); }
    try { startNewsletterCampaignRetentionScheduler(); } catch { console.error("[NEWSLETTER-RETENTION] scheduler.failed_to_start"); }
  });
}

startServer();