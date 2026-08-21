import { Router } from "express";
import axios from "axios";
import { GoogleGenAI } from "@google/genai";
import { searchShopeeProductsDDG } from "../services/shopeeSearchProvider";
import { discoverShopeeProducts } from "../services/shopeeDiscovery";

const router = Router();

router.get("/diag/search-test", async (req, res) => {
  const query = (req.query.q as string) || "organizador cozinha";
  const results = await searchShopeeProductsDDG(query, 5);
  res.json({
    source: "DuckDuckGo Lite",
    query,
    count: results.length,
    results
  });
});

router.get("/diag/search-raw", async (req, res) => {
  const query = (req.query.q as string) || "organizador cozinha";
  const searchUrl = "https://duckduckgo.com/lite/";
  try {
    const response = await axios.get(searchUrl, {
      params: { q: `site:shopee.com.br/product ${query}` },
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
      }
    });
    // Teste de descoberta Gemini 3.6 Flash com Grounding
    const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
    let geminiDiscovery: any = null;
    try {
      const result = await (genAI as any).models.generateContent({
        model: "gemini-3.6-flash",
        contents: [{ role: "user", parts: [{ text: `Encontre 3 links de produtos reais da Shopee Brasil para "${query}". Retorne apenas os links no formato https://shopee.com.br/product/SHOPID/ITEMID` }] }],
        tools: [{ googleSearchRetrieval: {} }]
      });
      geminiDiscovery = {
        text: result.text,
        grounding: result.candidates?.[0]?.groundingMetadata
      };
    } catch (e: any) {
      geminiDiscovery = { error: e.message };
    }

    res.send({
      status: response.status,
      headers: response.headers,
      geminiDiscovery,
      html: response.data
    });
  } catch (error: any) {
    res.status(500).json({
      error: error.message,
      status: error.response?.status,
      data: error.response?.data?.substring(0, 1000)
    });
  }
});

router.get("/diag/discovery-test", async (req, res) => {
  const query = (req.query.q as string) || "organizador cozinha";
  const result = await discoverShopeeProducts(query, 3);
  res.json(result);
});

export default router;
