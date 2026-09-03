import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

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
  "curator_note",
].join(",");

const RAW_PAYLOAD_MARKERS = [
  "[url final]",
  "[titulo identificado]",
  "[preco identificado]",
  "[total imagens oficiais]",
  "[imagens extraidas]",
  "[conteudo da pagina]",
];

function containsRawPayloadMarkers(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return RAW_PAYLOAD_MARKERS.some((marker) => normalized.includes(marker));
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
        .select(PUBLIC_PRODUCT_COLUMNS)
        .eq("ativo", true)
        .eq("status", "published")
        .order("created_at", { ascending: false });
      if (error) throw new Error(`PRODUCTS_QUERY_FAILED:${error.code || "unknown"}`);

      const products = (Array.isArray(data) ? data : []).map((product: Record<string, unknown>) =>
        containsRawPayloadMarkers(product.descricao)
          ? { ...product, descricao: "" }
          : product
      );

      return json({ success: true, products, data: products, source: "supabase-edge" });
    }

    return json({ success: false, error: "NOT_FOUND" }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "PUBLIC_API_ERROR";
    console.error("[cerberus-public-api]", message.slice(0, 160));
    return json({ success: false, error: "PUBLIC_API_UNAVAILABLE" }, 503);
  }
});
