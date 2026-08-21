import { Router } from "express";
import axios from "axios";
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
    res.send({
      status: response.status,
      headers: response.headers,
      htmlSample: response.data.substring(0, 2000)
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
