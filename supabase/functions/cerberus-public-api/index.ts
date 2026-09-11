import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { toPublicProductDTOs } from "../_shared/publicProductDTO.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
};

const PUBLIC_PRODUCT_COLUMNS = [
  "id", "ref", "produto", "categoria", "preco", "imagens", "link", "ativo",
  "destaque", "status", "slug", "descricao", "pagina_ponte_url", "created_at",
  "oferta_promocional", "display_title", "display_title_status",
  "image_editorial_status", "image_curation",
  "created_by", "human_editorial_approved_at", "human_editorial_image_url",
  "human_editorial_image_fingerprint", "human_editorial_review_id",
  "human_editorial_authorization_id",
].join(",");

function adminClient() {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS") || "{}";
  let secret = "";
  try { secret = JSON.parse(secretKeysRaw)?.default || ""; } catch { secret = ""; }
  secret ||= Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !secret) throw new Error("SUPABASE_ADMIN_CONFIG_MISSING");
  return createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isHumanGovernedCreator(value: unknown): boolean {
  const creator = text(value).toLowerCase();
  return creator === "telegram_manual"
    || creator === "telegram_rotation_candidate"
    || creator.includes("autonomous_curator");
}

function imageCurationReady(value: unknown): boolean {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && text((value as Record<string, unknown>).status) === "ready";
}

function strictEditorialReady(row: Record<string, unknown>): boolean {
  return text(row.display_title_status) === "reviewed"
    && text(row.image_editorial_status) === "clean"
    && Boolean(text(row.display_title))
    && imageCurationReady(row.image_curation);
}

function primaryImage(row: Record<string, unknown>): string {
  const curation = row.image_curation && typeof row.image_curation === "object" && !Array.isArray(row.image_curation)
    ? row.image_curation as Record<string, unknown>
    : null;
  const curated = text(curation?.primaryImageUrl);
  if (/^https:\/\//i.test(curated)) return curated;
  const images = Array.isArray(row.imagens) ? row.imagens : [];
  return images.map(text).find(image => /^https:\/\//i.test(image)) || "";
}

async function imageUrlFingerprint(url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url.trim()));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

async function currentHumanApproval(row: Record<string, unknown>): Promise<boolean> {
  const primary = primaryImage(row);
  const approvedAt = text(row.human_editorial_approved_at);
  if (!primary || text(row.human_editorial_image_url) !== primary) return false;
  if (!approvedAt || !Number.isFinite(Date.parse(approvedAt))) return false;
  if (!text(row.human_editorial_review_id) || !text(row.human_editorial_authorization_id)) return false;
  return text(row.human_editorial_image_fingerprint) === await imageUrlFingerprint(primary);
}

async function publicationGate(row: Record<string, unknown>): Promise<boolean> {
  if (row.ativo !== true || text(row.status) !== "published") return false;
  return isHumanGovernedCreator(row.created_by)
    ? currentHumanApproval(row)
    : strictEditorialReady(row);
}

async function eligibleProductsByIds(ids?: string[]): Promise<Record<string, unknown>[]> {
  const client = adminClient();
  let query = client
    .from("products")
    .select(PUBLIC_PRODUCT_COLUMNS)
    .eq("ativo", true)
    .eq("status", "published")
    .order("created_at", { ascending: false });
  if (ids) {
    if (ids.length === 0) return [];
    query = query.in("id", ids);
  }
  const { data, error } = await query;
  if (error) throw new Error(`PRODUCTS_QUERY_FAILED:${error.code || "unknown"}`);
  const rows = Array.isArray(data) ? data as Record<string, unknown>[] : [];
  const gate = await Promise.all(rows.map(publicationGate));
  return rows.filter((_, index) => gate[index]);
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
  const path = new URL(req.url).pathname.replace(/\/+$/, "");

  try {
    if (path.endsWith("/health")) {
      return json({
        status: "ok",
        service: "cerberus-public-api",
        runtime: "supabase-edge",
        publicationGate: "strict-or-human-v1",
        overlayContract: "catalog-overlay-v1",
        timestamp: new Date().toISOString(),
      });
    }

    if (path.endsWith("/catalog-overlay")) {
      const client = adminClient();
      const { data: entries, error } = await client
        .from("catalog_overlay_entries")
        .select("product_id,action,updated_at")
        .order("updated_at", { ascending: true });
      if (error) throw new Error(`CATALOG_OVERLAY_QUERY_FAILED:${error.code || "unknown"}`);
      const rows = Array.isArray(entries) ? entries as Array<{ product_id?: unknown; action?: unknown }> : [];
      const hiddenIds = [...new Set(rows.filter(row => row.action === "hide").map(row => text(row.product_id)).filter(Boolean))];
      const upsertIds = [...new Set(rows.filter(row => row.action === "upsert").map(row => text(row.product_id)).filter(Boolean))];
      const eligibleRows = await eligibleProductsByIds(upsertIds);
      const upserts = toPublicProductDTOs(eligibleRows);
      const eligibleIds = new Set(upserts.map((row: any) => String(row?.id || "")));
      // Fail closed: an overlay marked upsert but no longer eligible must disappear
      // from a legacy snapshot rather than silently resurrect there.
      const ineligibleUpsertIds = upsertIds.filter(id => !eligibleIds.has(id));
      return json({
        success: true,
        contract: "catalog-overlay-v1",
        upserts,
        hiddenIds: [...new Set([...hiddenIds, ...ineligibleUpsertIds])],
        source: "supabase-edge",
        publicationGate: "strict-or-human-v1",
      });
    }

    if (path.endsWith("/products") || path.endsWith("/cerberus-public-api")) {
      const eligibleRows = await eligibleProductsByIds();
      const products = toPublicProductDTOs(eligibleRows);
      return json({ success: true, products, data: products, source: "supabase-edge", publicationGate: "strict-or-human-v1" });
    }

    return json({ success: false, error: "NOT_FOUND" }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "PUBLIC_API_ERROR";
    console.error("[cerberus-public-api]", message.slice(0, 160));
    return json({ success: false, error: "PUBLIC_API_UNAVAILABLE" }, 503);
  }
});
