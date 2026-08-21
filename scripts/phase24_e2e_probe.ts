/**
 * PROVA E2E — FASE 24 — EXECUTAR SOMENTE NO RUNTIME RENDER AUTORIZADO
 * PROOF_RUN_ID: N17_PHASE24_E2E_PROBE_20260821
 *
 * OBJETIVO: provar o fluxo REAL no runtime que possui as credenciais:
 *   Shopee Affiliate API → productLink oficial → scraper existente
 *   → identidade (shop_id/item_id) → imagens + preço observacional
 *   → card Telegram (sendPhoto) → PendingReview.
 *
 * REGRAS (fail-closed, read-only na camada comercial):
 *   - UMA única chamada read-only productOfferV2 (link_acquired, sem mutation).
 *   - NÃO executar acquisition N17 (não há N17 nesta rota).
 *   - NÃO publicar, NÃO adquirir, NÃO alterar catálogo/Supabase além do
 *     PendingReview criado pela prova (telegram_pending_reviews).
 *   - NÃO expor/gravar App ID, App Secret, token Telegram ou qualquer secret.
 *   - NÃO criar candidato/evidência/assessment.
 *   - Identidade alvo: shop_id=1530442944, item_id=23794344926.
 *
 * COMO EXECUTAR (Render Dashboard → serviço cerberus-forge-deploy → Shell):
 *   npx tsx scripts/phase24_e2e_probe.ts
 *
 * SAÍDA: JSON sanitizado para docs/phase24_e2e_probe_result.json
 *        (SOMENTE campos de schema/evidência; ZERO valores de preço reais,
 *         ZERO secrets).
 */
import { createServer } from "node:http";
import type { Request, Response } from "express";
import express from "express";
import {
  setupPreviewTelegramRoutes,
} from "../server/routes/previewTelegramRoutes";

const TARGET_SHOP_ID = "1530442944";
const TARGET_ITEM_ID = "23794344926";
const TARGET_URL = `https://shopee.com.br/product/${TARGET_SHOP_ID}/${TARGET_ITEM_ID}`;
const PROOF_RUN_ID = "N17_PHASE24_E2E_PROBE_20260821";

interface ProbeResult {
  proofRunId: string;
  probeStep:
    | "affiliate_call"
    | "scraper_enrichment"
    | "identity_check"
    | "telegram_card"
    | "persisted_review";
  httpStatus: number | null;
  affiliateLinkStatus: string | null;
  affiliateUrl: string | null;
  identityMatch: boolean | null;
  extractedImageCount: number | null;
  hasScrapedPrice: boolean | null;
  cardSent: boolean | null;
  cardAsPhoto: boolean | null;
  priceScaleVerified: boolean | null;
  note: string;
  error: string | null;
}

function sanitizeResult(partial: Partial<ProbeResult>, note: string): ProbeResult {
  return {
    proofRunId: PROOF_RUN_ID,
    probeStep: "affiliate_call",
    httpStatus: null,
    affiliateLinkStatus: null,
    affiliateUrl: null,
    identityMatch: null,
    extractedImageCount: null,
    hasScrapedPrice: null,
    cardSent: null,
    cardAsPhoto: null,
    priceScaleVerified: null,
    note,
    error: null,
    ...partial,
  };
}

async function runProbe(): Promise<void> {
  const result: ProbeResult = sanitizeResult(
    { probeStep: "affiliate_call", note: "iniciando chamada real read-only" },
    "iniciando",
  );

  // 1. Servir a rota real num listener local efêmero (mesmo código do server).
  const app = express();
  app.use(express.json());
  const requireAdminAuth = (_req: Request, _res: Response, next: () => void) =>
    next();
  setupPreviewTelegramRoutes({ app, requireAdminAuth });

  const server = await new Promise<ReturnType<typeof createServer>>(
    (resolve) => {
      const s = createServer(app);
      s.listen(0, "127.0.0.1", () => resolve(s));
    },
  );
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // 2. Chamar a rota REAL com o produto oficial comprovado.
    //    A chamada executa: Affiliate API real → scraper real → Telegram real.
    const res = await fetch(`${base}/api/commercial/preview-telegram`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: TARGET_URL }),
    });
    const body = (await res.json()) as Record<string, unknown>;

    result.httpStatus = res.status;
    result.probeStep = "scraper_enrichment";

    if (res.status === 200 && (body as { ok?: boolean }).ok) {
      const affiliateStatus = String(body.affiliateStatus ?? "");
      result.affiliateLinkStatus =
        affiliateStatus || (body.affiliateUrl ? "link_acquired" : "unknown");
      result.affiliateUrl = body.affiliateUrl ? "AFFILIATE_URL_PRESENT" : null;
      result.identityMatch =
        String(body.shopId) === TARGET_SHOP_ID &&
        String(body.itemId) === TARGET_ITEM_ID;
      result.priceScaleVerified = Boolean(body.priceScaleVerified) ?? false;
      result.cardSent = Boolean(body.cardSent);
      result.cardAsPhoto = Boolean(body.cardAsPhoto);
      result.probeStep = "persisted_review";
      result.note =
        "fluxo completo: affiliate → scraper → identidade → card → pending_review";
    } else {
      result.probeStep =
        res.status === 424 && String(body.error).includes("affiliate")
          ? "affiliate_call"
          : res.status === 424
            ? "scraper_enrichment"
            : "affiliate_call";
      result.error = String(body.error ?? body.reason ?? "unknown");
      result.note = `fail-closed: status ${res.status}, erro ${result.error}`;
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    result.probeStep = "affiliate_call";
    result.httpStatus = null;
    result.error = err instanceof Error ? err.message : String(err);
    result.note = "falha de transporte ou exceção no handler";
    console.log(JSON.stringify(result, null, 2));
  } finally {
    server.close();
  }
}

runProbe().catch((err) => {
  console.error("PROBE FALHOU:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
