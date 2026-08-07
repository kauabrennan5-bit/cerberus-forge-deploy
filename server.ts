import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import { INITIAL_PRODUCTS, generateSlug } from "./src/data/initialProducts";
import * as productsRepository from "./server/repositories/productsRepository";
import { fetchProductDataFromUrl } from "./server/services/scraper";
import { handleTelegramWebhookUpdate } from "./server/services/telegramBot";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "25mb" }));

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
  // MIDDLEWARE DE AUTENTICAÇÃO ADMINISTRATIVA
  // ==========================================
  const getAdminPassword = (): string => (process.env.ADMIN_PASSWORD || "").trim();

  const requireAdminAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const adminPass = getAdminPassword();

    if (!adminPass) {
      console.error("[Security] ADMIN_PASSWORD não está configurada. Operação administrativa bloqueada.");
      return res.status(503).json({
        success: false,
        error: "A autenticação administrativa não está configurada no servidor. Defina ADMIN_PASSWORD no ambiente."
      });
    }
    const authHeader = (req.headers["x-admin-password"] as string) || "";
    const bearerHeader = (req.headers["authorization"] as string) || "";
    const bearerPass = bearerHeader.startsWith("Bearer ") ? bearerHeader.slice(7).trim() : "";
    const bodyPass = (req.body && req.body.senha) ? String(req.body.senha) : "";
    const queryPass = (req.query && req.query.senha) ? String(req.query.senha) : "";

    const providedPass = authHeader || bearerPass || bodyPass || queryPass;

    if (!providedPass || providedPass !== adminPass) {
      return res.status(401).json({
        success: false,
        error: "Acesso administrativo não autorizado. Senha inválida ou ausente."
      });
    }

    next();
  };

  // Verificação de credencial para o login da interface administrativa.
  // A senha nunca é armazenada nem comparada no frontend.
  app.post("/api/admin/verify", (req, res) => {
    const adminPass = getAdminPassword();
    const providedPass = String(req.body?.password || "");

    if (!adminPass) {
      return res.status(503).json({
        success: false,
        error: "A autenticação administrativa não está configurada no servidor."
      });
    }

    if (!providedPass || providedPass !== adminPass) {
      return res.status(401).json({ success: false, error: "Senha administrativa inválida." });
    }

    return res.json({ success: true });
  });

  // ==========================================
  // 1. PRODUCTS REST API (DATABASE ENDPOINTS)
  // ==========================================

  // GET /api/products - Get all active products
  app.get("/api/products", async (req, res) => {
    const products = await productsRepository.getProducts();
    return res.json({ success: true, products, data: products });
  });

  // GET /api/products/:idOrSlug - Get single product details
  app.get("/api/products/:idOrSlug", async (req, res) => {
    const { idOrSlug } = req.params;
    const product = await productsRepository.getProductByIdOrSlug(idOrSlug);
    if (!product) {
      return res.status(404).json({ success: false, error: "Produto não encontrado" });
    }
    return res.json({ success: true, product });
  });

  // POST /api/products - Create new product with requireAdminAuth middleware
  app.post("/api/products", requireAdminAuth, async (req, res) => {
    try {
      const { produto, categoria, preco, imagens, link, destaque, descricao, paginaPonteUrl } = req.body;

      if (!produto || !link || !categoria || !preco) {
        return res.status(400).json({ success: false, error: "Nome, categoria, preço e link são obrigatórios." });
      }

      const newProduct = await productsRepository.createProduct({
        produto,
        categoria,
        preco,
        imagens,
        link,
        destaque,
        descricao,
        paginaPonteUrl
      });

      return res.status(201).json({
        success: true,
        message: "Produto criado com sucesso no banco de dados!",
        product: newProduct
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

  // ==========================================
  // 2. META CONVERSIONS API (CAPI) & FEED
  // ==========================================

  // POST /api/meta-capi - Server-Side Conversions API for Deduplication
  app.post("/api/meta-capi", async (req, res) => {
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

        const capiRes = await fetch(`https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${accessToken}`, {
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
        const descEscaped = `"${(p.descricao || `Peça curada Cerberus Finds em ${p.categoria}`).replace(/"/g, '""')}"`;
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
        xml += `      <g:description><![CDATA[${p.descricao || `Peça curada Cerberus Finds em ${p.categoria}`}]]></g:description>\n`;
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

      const googleRes = await fetch(appsScriptUrl, {
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

  // ==========================================
  // 3. TELEGRAM BOT INTEGRATION (FASE 4.1)
  // ==========================================

  // GET /api/telegram-status - Status da configuração e healthcheck do Telegram Bot
  app.get(["/api/telegram-status", "/api/telegram/status"], (req, res) => {
    const token = process.env.TELEGRAM_BOT_TOKEN || "";
    const allowed = process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_ALLOWED_USERS || "";
    const host = req.headers.host || "localhost:3000";
    const protocol = req.headers["x-forwarded-proto"] || "https";
    const webhookUrl = `${protocol}://${host}/api/telegram/webhook`;

    return res.json({
      configured: Boolean(token),
      hasToken: Boolean(token),
      allowedUsers: allowed.split(",").map((u) => u.trim()).filter(Boolean),
      webhookUrl: webhookUrl,
      phase: "4.1 - Infraestrutura & Assincronismo"
    });
  });

  // POST /api/telegram-set-webhook - Configuração automática do Webhook via API oficial
  app.post(["/api/telegram-set-webhook", "/api/telegram/set-webhook"], requireAdminAuth, async (req, res) => {
    const token = process.env.TELEGRAM_BOT_TOKEN || req.body.token;
    if (!token) {
      return res.status(400).json({ success: false, error: "TELEGRAM_BOT_TOKEN é necessário para configurar o Webhook." });
    }

    const host = req.headers.host || "localhost:3000";
    const protocol = req.headers["x-forwarded-proto"] || "https";
    const webhookUrl = req.body.webhookUrl || `${protocol}://${host}/api/telegram/webhook`;

    try {
      const tgRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
      const tgData = await tgRes.json();
      return res.json({ success: tgData.ok, telegramResult: tgData, webhookUrl });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/telegram/webhook e /api/telegram-webhook - Webhook Assíncrono com Resposta 200 Imediata
  app.post(["/api/telegram/webhook", "/api/telegram-webhook"], (req, res) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.warn("⚠️ [Telegram Webhook Warning] Requisição recebida, mas TELEGRAM_BOT_TOKEN não está definido nas variáveis de ambiente.");
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

  // API Route: Proxy Google Sheets CSV
  app.get("/api/proxy-csv", async (req, res) => {
    try {
      const csvUrl = req.query.url as string;
      if (!csvUrl) {
        return res.status(400).json({ error: "URL do CSV não informada" });
      }
      const fetchRes = await fetch(csvUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        }
      });
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

  // Vite Middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server Cerberus Finds rodando na porta ${PORT}`);
  });
}

startServer();
