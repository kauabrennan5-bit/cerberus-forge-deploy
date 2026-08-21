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

router.get("/diag/discovery-test", async (req, res) => {
  const query = (req.query.q as string) || "organizador cozinha";
  const result = await discoverShopeeProducts(query, 3);
  res.json(result);
});

export default router;
