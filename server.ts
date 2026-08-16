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
import { getExpectedTelegramWebhookUrl, getTelegramWebhookDiagnostics } from "./server/services/telegramDiagnostics";
import { containsRawPayloadMarkers } from "./server/services/productLifecycle";
import { setCommercialBrainClient } from "./server/repositories/commercialBrainRepository";
import { registerCommercialBrainRoutes } from "./server/routes/commercialBrainRoutes";
import { registerPolicyEngineRoutes } from "./server/routes/policyEngineRoutes";
import { setPolicyJournalClient } from "./server/repositories/policyJournalRepository";

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
  const expensiveOperationRateLimiter = new InMemoryRateLimiter(rateLimit("EXPENSIVE_RATE_LIMIT_PER_MINUTE", 10), 60_000);

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

  // Enable CORS headers for external forms or integrations
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-admin-password");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });

  // ==========================================
  // HELPER DE VALIDAÇÃO DE URL PARA PROXY CSV (PREVENÇÃO DE SSRF)
  // ==========================================
  const isValidCsvProxyUrl = (rawUrl: string): boolean => {
    try {
      const parsed = new URL(rawUrl);

      // Exige protocolo HTTPS estritamente
      if (parsed.protocol !== "https:") {
        return false;
      }

      const hostname = parsed.hostname.toLowerCase();

      // Bloqueio explícito de localhost, loopback, IPs de link-local e metadata
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

      // Bloqueio de faixas de IP privadas e reservadas (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, etc)
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

      // Domínios autorizados para exportação de planilhas do Google Sheets
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

    // Se ADMIN_PASSWORD não estiver configurada no ambiente, recusa todo acesso (Fail-Closed)
    if (!rawAdminPassEnv) {
      return res.status(401).json({
        success: false,
        error: "Acesso administrativo desativado: a variável ADMIN_PASSWORD não está configurada no ambiente do servidor."
      });
    }

    const authHeader = (req.headers["x-admin-password"] as string) || "";
    const bearerHeader = (req.headers["authorization"] as string) || "";
    const bearerPass = bearerHeader.startsWith("Bearer ") ? bearerHeader.slice(7).trim() : "";
    const bodyPass = (req.body && req.body.senha) ? String(req.body.senha) : "";
    const queryPass = (req.query && req.query.senha) ? String(req.query.senha) : "";

    const providedPass = (authHeader || bearerPass || bodyPass || queryPass).trim();

    if (!providedPass) {
      return res.status(401).json({
        success: false,
        error: "Acesso administrativo não autorizado. Senha ausente."
      });
    }

    // Verifica se a variável de ambiente já é um hash do bcrypt
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

  // POST /api/admin/verify - Endpoint para verificar senha de administrador
  app.post("/api/admin/verify", requireAdminAuth, (req, res) => {
    return res.json({ success: true, message: "Senha de administrador verificada com sucesso!" });
  });

  // POST /api/admin/rebuild-static-catalog - Endpoint para reconstrução manual do catálogo estático
  app.post("/api/admin/rebuild-static-catalog", requireAdminAuth, async (req, res) => {
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

  // ==========================================
  // 1. PRODUCTS REST API (DATABASE ENDPOINTS)
  // ==========================================

  // GET /api/products - Get all active products
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

  // GET /api/products/:idOrSlug - Get single product details
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

  // POST /api/products - Create new product with requireAdminAuth middleware
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

  // Handler comum para exclusão de produto
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

  // DELETE e POST /api/products/:id/delete - Suporte a DELETE nativo e POST fallback para desvios de proxy Nginx (405)
  app.delete("/api/products/:id", requireAdminAuth, handleDeleteRequest);
  app.post("/api/products/:id/delete", requireAdminAuth, handleDeleteRequest);
  app.post("/api/products/delete", requireAdminAuth, handleDeleteRequest);

  // Handler para edição/atualização de produto
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

  // PUT e POST para atualização de produto
  app.put("/api/products/:id", requireAdminAuth, handleUpdateRequest);
  app.post("/api/products/:id/edit", requireAdminAuth, handleUpdateRequest);
  app.post("/api/products/:id/update", requireAdminAuth, handleUpdateRequest);

  // ==========================================
  // 2. META CONVERSIONS API (CAPI) & FEED
  // ==========================================

  // POST /api/meta-capi - Server-Side Conversions API for Deduplication
  app.post("/api/meta-capi", async (req, res) => {
    if (!enforceRateLimit(analyticsRateLimiter, req, res)) return;
    try {
      const { event_name, event_id, product, metaPixelId, metaAccessToken } = req.body;

      const pixelId = metaPixelId || process.env.META_PIXEL_ID;
      const accessToken = metaAccessToken || process.env.META_ACCESS_TOKEN;

      const clientIp = (req.headers["x-forwarded-for"] as string || req.socket.remoteAddress || "").split(",")[0].trim();
      const userAgent = req.headers["user-agent"] || "";

      console.log(`📡 [CAPI Server Event] Event: ${event_name} | EventID: ${event_id} | Product: ${product?.produto}`);

      if (pixelId && accessToken) {
        const payload = {
          data: [
            {
              event_name: event_name || "InitiateCheckout",
              event_time: Math.floor(Date.now() / 1000),
              event_id: event_id,
              event_source_url: req.headers.referer || "",
              action_source: "website",
              user_data: {
                client_ip_address: clientIp,
                client_user_agent: userAgent
              },
              custom_data: {
                content_name: product?.produto || "Produto Cerberus",
                content_ids: [product?.id || "prod-001"],
                content_type: "product",
                value: product?.preco || 0,
                currency: "BRL"
              }
            }
          ]
        };

        const capiRes = await fetchWithTimeout(`https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${accessToken}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        const capiJson = await capiRes.json();
        console.log("Response Meta Graph API CAPI:", capiJson);
        return res.json({ success: true, metaResponse: capiJson, event_id, deduplicated: true });
      }

      // If token is missing, return success logged acknowledgement for deduplication architecture
      return res.json({
        success: true,
        message: "Evento CAPI registrado e formatado para deduplicação (Aguardando Meta Access Token nas Configurações)",
        event_id,
        deduplicated: true
      });
    } catch (err: any) {
      console.error("Erro no /api/meta-capi:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/track-click - Outbound Affiliate Click Analytics Tracker
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

      // Valida o produto no repositório oficial antes de registrar
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

      const clientIp = (req.headers["x-forwarded-for"] as string || req.socket.remoteAddress || "").split(",")[0].trim();
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


  // GET /api/meta-feed.csv - Meta Commerce Manager CSV Feed
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

  // GET /api/meta-feed.xml - Meta Commerce Manager RSS XML Feed
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

  // Legacy Proxy Submit to Google Apps Script
  app.post("/api/submit-product", requireAdminAuth, async (req, res) => {
    try {
      const { appsScriptUrl, senha, produto, categoria, preco, imagens, link, destaque } = req.body;

      if (!appsScriptUrl) {
        return res.status(400).json({ 
          success: false, 
          error: "A URL do Google Apps Script não foi informada." 
        });
      }

      if (!produto || !link) {
        return res.status(400).json({ 
          success: false, 
          error: "Nome do produto e Link são obrigatórios." 
        });
      }

      const payload = {
        senha,
        produto,
        categoria: categoria || "Geral",
        preco: Number(preco) || 0,
        imagens: Array.isArray(imagens) ? imagens.join(" | ") : (imagens || ""),
        link,
        destaque: Boolean(destaque)
      };

      const googleRes = await fetchWithTimeout(appsScriptUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });

      const responseText = await googleRes.text();
      let responseJson: any = {};
      try {
        responseJson = JSON.parse(responseText);
      } catch {
        responseJson = { result: "sucesso" };
      }

      if (responseJson.result === "sucesso" || responseJson.status === "ok" || googleRes.ok) {
        return res.json({ success: true, message: "Produto enviado para a planilha com sucesso!" });
      } else {
        return res.status(400).json({ 
          success: false, 
          error: responseJson.message || "Erro ao gravar na planilha do Google." 
        });
      }
    } catch (err: any) {
      console.error("Erro no proxy /api/submit-product:", err);
      return res.status(500).json({ 
        success: false, 
        error: "Erro de servidor ao enviar produto: " + (err?.message || String(err))
      });
    }
  });

  // AI Extraction endpoint (Nível 1 - Content Automation)
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

      // 1. Obter dados reais da URL e/ou texto bruto via Scraper no Backend
      const targetUrl = url ? url.trim() : "";
      console.log(`[Extraction] Executando scraper confiável para URL="${targetUrl}"`);

      const scraped = await fetchProductDataFromUrl(targetUrl, rawText || "");
      const scrapedTitle = scraped.title;
      const scrapedPrice = scraped.price;
      const scrapedImages = scraped.images;
      const scrapedContent = scraped.rawContent;

      // Validação 1: Registrar aviso em log se preço não for encontrado, sem cancelar a extração
      if (scrapedPrice === null || scrapedPrice <= 0) {
        console.warn(`[Extraction Notice] Preço não identificado automaticamente no anúncio: ${targetUrl}. Extração de título e imagens prossegue normalmente.`);
      }

      // Validação 2: Se existirem menos de duas imagens, registrar em log
      if (scrapedImages.length < 2) {
        console.warn(`[Extraction Warning] Anúncio possui menos de duas imagens (${scrapedImages.length} obtida(s)).`);
      }

      // Validação 3: Somente retornar erro 422 quando TODAS as estratégias falharem
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
          details: "Cole o texto da página do produto no campo abaixo para continuar."
        });
      }

      // 3. Prompt para o Gemini responsável APENAS por limpar o título, gerar descrição e sugerir categoria
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
          preco: scrapedPrice, // Preço strictly extraído do Scraper
          imagens: scrapedImages, // Imagens strictly extraídas do Scraper
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

  // Automation process endpoint (Direct REST trigger for product automation)
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

  // ==========================================
  // 3. TELEGRAM BOT INTEGRATION (FASE 2)
  // ==========================================

  // GET /api/telegram-status - Diagnóstico seguro do bot, webhook e Operator.
  app.get(["/api/telegram-status", "/api/telegram/status"], async (_req, res) => {
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
      return res.status(200).json({
        configured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
        tokenConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
        webhookConfigured: false,
        webhookMatchesExpectedUrl: null,
        apiHealthy: false,
        backendReady: false,
        operatorState: cerberusOperator.getOperatorPersistenceState().status,
        webhookLastError: "Falha ao consultar diagnóstico do Telegram: " + (error?.message || "erro desconhecido"),
        lastWebhookCheck: new Date().toISOString(),
        backendSha: process.env.RENDER_GIT_COMMIT || process.env.RENDER_GIT_COMMIT_SHA || undefined,
      });
    }
  });

  // POST /api/telegram-set-webhook - Configuração automática do Webhook via API oficial
  app.post(["/api/telegram-set-webhook", "/api/telegram/set-webhook"], requireAdminAuth, async (req, res) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      return res.status(400).json({ success: false, error: "TELEGRAM_BOT_TOKEN é necessário para configurar o Webhook." });
    }

    const webhookUrl = getExpectedTelegramWebhookUrl();
    const requestedUrl = typeof req.body?.webhookUrl === "string" ? req.body.webhookUrl.replace(/\/+$/, "") : undefined;
    if (requestedUrl && requestedUrl !== webhookUrl) {
      return res.status(400).json({ success: false, error: "A URL enviada diverge da URL canônica do backend; nenhuma alteração foi feita.", expectedWebhookUrl: webhookUrl });
    }
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const tgRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhookUrl, ...(webhookSecret ? { secret_token: webhookSecret } : {}) }),
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

  // POST /api/telegram/webhook e /api/telegram-webhook - Webhook Assíncrono com Resposta 200 Imediata
  app.post(["/api/telegram/webhook", "/api/telegram-webhook"], (req, res) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.warn("⚠️ [Telegram Webhook Warning] Requisição recebida, mas TELEGRAM_BOT_TOKEN não está definido nas variáveis de ambiente.");
    }

    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (webhookSecret && req.headers["x-telegram-bot-api-secret-token"] !== webhookSecret) {
      return res.status(403).json({ ok: false, error: "Webhook Telegram não autorizado." });
    }

    // 1. Resposta HTTP 200 imediata ao Telegram para evitar timeout de 5 segundos
    res.status(200).json({ ok: true, status: "Update recebido e enfileirado assincronamente" });

    // 2. Processamento assíncrono em background
    setImmediate(() => {
      handleTelegramWebhookUpdate(req.body).catch((err) => {
        console.error("❌ [Telegram Async Error] Erro ao processar update assíncrono:", err);
      });
    });
  });

  // API Route: Proxy Google Sheets CSV (Protegido contra SSRF e Acesso Não Autorizado)
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

      // Requisita com redirect: "manual" para inspecionar redirecionamentos e evitar SSRF via 301/302
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

  // Fonte única do cliente Supabase para o Cérebro Comercial (MEMORY, não autoridade). O repositório segue o padrão injetável do Bloco 13; em produção o cliente real vem de productsRepository (mesma credencial administrativa do catálogo). Testes continuam injetando cliente falso via setCommercialBrainClientForTests.
  if (productsRepository.supabase) {
    setCommercialBrainClient(productsRepository.supabase as any);
    setPolicyJournalClient(productsRepository.supabase as any);
  }
  registerCommercialBrainRoutes({ app, requireAdminAuth });
  // Bloco 15 — Fase D: superfície read-only de avaliação de política.
  // POLICY != EXECUTION — nenhuma rota write de execução é criada aqui.
  registerPolicyEngineRoutes({ app, requireAdminAuth });

  // Vite Middleware for development
  if (process.env.NODE_ENV !== "production") {
    // In dev, serve public first
    app.use(express.static(path.join(process.cwd(), "public")));
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    
    // 1. Explicit route for static data (Highest Priority)
    app.get("/data/*", (req, res) => {
      const dataRoot = path.resolve(distPath, "data");
      const filePath = path.resolve(distPath, `.${req.path}`);
      if (!filePath.startsWith(`${dataRoot}${path.sep}`)) {
        return res.status(400).json({ error: "Caminho de arquivo inválido." });
      }
      return res.sendFile(filePath);
    });

    // 2. Serve static assets
    app.use(express.static(distPath, { index: false }));
    
    // 3. Fallback to public folder
    app.use(express.static(path.join(process.cwd(), "public")));

    // 4. SPA Fallback
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server Cerberus Finds rodando na porta ${PORT}`);

    // O Telegram é um caminho crítico de entrada e não pode depender do Operator, Supabase ou scheduler.
    void startTelegramPolling().catch((error) => {
      console.error("[Telegram] Falha não tratada na inicialização independente:", error?.message || error);
    });

    // A recuperação do Operator é isolada: falhas entram em SAFE_MODE e não derrubam HTTP/Telegram.
    void cerberusOperator.initializeOperatorState()
      .then((boot) => {
        console.log(`[OPERATOR] Boot recovery: ${boot.ready ? "READY" : "SAFE_MODE"} — ${boot.reason}`);
      })
      .catch((error) => {
        console.error("[OPERATOR] Falha não tratada no boot recovery; processo mantido operacional em SAFE_MODE:", error?.message || error);
      });

    // O scheduler é secundário e inicia independentemente da recuperação persistida.
    try {
      cerberusOperator.startOperatorScheduler();
    } catch (error: any) {
      console.error("[OPERATOR SCHEDULER] Falha ao iniciar scheduler; HTTP e Telegram continuam disponíveis:", error?.message || error);
    }
  });
}

startServer();
