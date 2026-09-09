import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { toPublicProductDTO } from "../../../src/lib/publicProductDto.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
};

const PUBLIC_PRODUCT_COLUMNS = [
  "id",
  "ref",
  "produto",
  "categoria",
  "preco",
  "imagens",
  "link",
  "ativo",
  "destaque",
  "status",
  "slug",
  "descricao",
  "pagina_ponte_url",
  "created_at",
  "oferta_promocional",
  "display_title",
].join(",");

const PUBLIC_ELIGIBILITY_COLUMNS = [
  PUBLIC_PRODUCT_COLUMNS,
  "display_title_status",
  "image_editorial_status",
  "image_curation",
  "image_review_model",
  "image_review_fingerprint",
  "created_by",
].join(",");

const PUBLIC_PRODUCT_CATEGORIES = new Set([
  "Iluminação",
  "Decoração",
  "Móveis",
  "Cozinha & Mesa",
  "Organização",
  "Vestuário",
  "Calçados & Acessórios",
  "Tecnologia",
  "Beleza & Bem-estar",
  "Infantil",
]);

const TELEGRAM_MANUAL_CREATED_BY = "telegram_manual";

function validHttpsUrl(value: unknown): boolean {
  try {
    return new URL(String(value || "").trim()).protocol === "https:";
  } catch {
    return false;
  }
}

function validShopeeAffiliateLink(value: unknown): boolean {
  try {
    const url = new URL(String(value || "").trim());
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "shopee.com.br" || host.endsWith(".shopee.com.br"));
  } catch {
    return false;
  }
}

function imageCurationRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function rowPrimaryImage(row: Record<string, unknown>): string | null {
  const imageCuration = imageCurationRecord(row.image_curation);
  if (validHttpsUrl(imageCuration?.primaryImageUrl)) return String(imageCuration?.primaryImageUrl);
  const images = Array.isArray(row.imagens) ? row.imagens : [];
  return validHttpsUrl(images[0]) ? String(images[0]) : null;
}

function isStrictEditorialRow(row: Record<string, unknown>): boolean {
  const imageCuration = imageCurationRecord(row.image_curation);
  return String(row.display_title_status || "") === "reviewed"
    && String(row.image_editorial_status || "") === "clean"
    && String(imageCuration?.status || "") === "ready";
}

function isTelegramManualPublicRow(row: Record<string, unknown>): boolean {
  const displayTitle = String(row.display_title || row.produto || "").trim();
  const price = Number(row.preco);
  return String(row.created_by || "") === TELEGRAM_MANUAL_CREATED_BY
    && displayTitle.length > 0
    && Boolean(rowPrimaryImage(row))
    && Number.isFinite(price)
    && price > 0
    && PUBLIC_PRODUCT_CATEGORIES.has(String(row.categoria || ""))
    && validShopeeAffiliateLink(row.link);
}

function adminClient() {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS") || "{}";
  let secret = "";
  try {
    secret = JSON.parse(secretKeysRaw)?.default || "";
  } catch {
    secret = "";
  }
  secret ||= Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !secret) throw new Error("SUPABASE_ADMIN_CONFIG_MISSING");
  return createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return json({ success: false, error: "METHOD_NOT_ALLOWED" }, 405);

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");

  try {
    if (path.endsWith("/health")) {
      return json({ status: "ok", service: "cerberus-public-api", runtime: "supabase-edge", timestamp: new Date().toISOString() });
    }

    if (path.endsWith("/products") || path.endsWith("/cerberus-public-api")) {
      const client = adminClient();
      const { data, error } = await client
        .from("products")
        .select(PUBLIC_ELIGIBILITY_COLUMNS)
        .eq("ativo", true)
        .eq("status", "published")
        .not("display_title", "is", null)
        .order("created_at", { ascending: false });
      if (error) throw new Error(`PRODUCTS_QUERY_FAILED:${error.code || "unknown"}`);

      const products = (Array.isArray(data) ? data : [])
        .filter((product: Record<string, unknown>) => isStrictEditorialRow(product) || isTelegramManualPublicRow(product))
        .map((product: Record<string, unknown>) => toPublicProductDTO(product))
        .filter((product): product is NonNullable<typeof product> => product !== null);

      return json({ success: true, products, data: products, source: "supabase-edge" });
    }

    return json({ success: false, error: "NOT_FOUND" }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "PUBLIC_API_ERROR";
    console.error("[cerberus-public-api]", message.slice(0, 160));
    return json({ success: false, error: "PUBLIC_API_UNAVAILABLE" }, 503);
  }
});