import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://cerberus-finds.pages.dev",
  "https://cerberusfinds.com",
  "https://www.cerberusfinds.com",
]);
const SOCIAL_LABELS: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  facebook: "Facebook",
  youtube: "YouTube",
  x: "X",
  pinterest: "Pinterest",
};
const MAX_BODY_BYTES = 128_000;

function text(value: unknown, max = 1000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://cerberus-finds.pages.dev",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-password",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
}

function json(req: Request, body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), ...extra, "Content-Type": "application/json; charset=utf-8" },
  });
}

function adminClient() {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS") || "{}";
  let secret = "";
  try { secret = JSON.parse(secretKeysRaw)?.default || ""; } catch { secret = ""; }
  secret ||= Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !secret) throw new Error("SUPABASE_ADMIN_CONFIG_MISSING");
  return createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function requestJson(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (!raw || raw.length > MAX_BODY_BYTES) throw new Error("INVALID_BODY");
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_BODY");
  return value as Record<string, unknown>;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function clientIp(req: Request): string {
  return text(req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown", 128) || "unknown";
}

async function consumeRateLimit(req: Request, scope: string, windowSeconds: number, limit: number): Promise<{ allowed: boolean; remaining: number; resetAt: string | null }> {
  const keyHash = await sha256(`${scope}:${clientIp(req)}`);
  const { data, error } = await adminClient().rpc("cerberus_consume_edge_rate_limit", {
    p_scope: scope,
    p_key_hash: keyHash,
    p_window_seconds: windowSeconds,
    p_limit: limit,
  });
  if (error) throw new Error(`EDGE_RATE_LIMIT_UNAVAILABLE:${error.code || "unknown"}`);
  const row = Array.isArray(data) ? data[0] : data;
  return {
    allowed: row?.allowed === true,
    remaining: Number(row?.remaining || 0),
    resetAt: typeof row?.reset_at === "string" ? row.reset_at : null,
  };
}

async function rateLimited(req: Request, scope: string, windowSeconds: number, limit: number): Promise<Response | null> {
  const state = await consumeRateLimit(req, scope, windowSeconds, limit);
  if (state.allowed) return null;
  return json(req, { success: false, code: "RATE_LIMITED", error: "Muitas solicitações. Tente novamente em instantes." }, 429, {
    "Retry-After": String(Math.max(1, windowSeconds)),
    "X-RateLimit-Remaining": "0",
  });
}

function normalizeEmail(value: unknown): string {
  return text(value, 320).toLowerCase();
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function newsletterError(error: unknown): { status: number; code: string; message: string } {
  const e = error as { message?: unknown; code?: unknown } | null;
  const source = `${text(e?.message, 500)} ${text(e?.code, 100)}`;
  if (source.includes("NEWSLETTER_RECONSENT_REQUIRED")) return { status: 409, code: "RECONSENT_REQUIRED", message: "Este contato exige um fluxo explícito de reativação." };
  if (source.includes("OUTBOX_IDEMPOTENCY_COLLISION")) return { status: 409, code: "IDEMPOTENCY_COLLISION", message: "A intenção de inscrição não coincide com a intenção já registrada." };
  if (source.includes("CONSENT_REQUIRED")) return { status: 400, code: "CONSENT_REQUIRED", message: "Consentimento de marketing obrigatório." };
  if (source.includes("INVALID_EMAIL")) return { status: 400, code: "INVALID_EMAIL", message: "E-mail inválido." };
  return { status: 503, code: "NEWSLETTER_UNAVAILABLE", message: "Serviço temporariamente indisponível." };
}

async function newsletter(req: Request): Promise<Response> {
  const blocked = await rateLimited(req, "newsletter", 60, 8);
  if (blocked) return blocked;
  let body: Record<string, unknown>;
  try { body = await requestJson(req); } catch { return json(req, { success: false, code: "INVALID_BODY", error: "Corpo inválido." }, 400); }
  const email = normalizeEmail(body.email);
  if (!validEmail(email)) return json(req, { success: false, code: "INVALID_EMAIL", error: "E-mail inválido." }, 400);
  if (body.marketingConsent !== true) return json(req, { success: false, code: "CONSENT_REQUIRED", error: "Consentimento de marketing obrigatório." }, 400);
  const intentDigest = await sha256(`newsletter-signup-v1:${email}`);
  const args = {
    p_email: email,
    p_marketing_consent: true,
    p_correlation_id: `newsletter-http-${intentDigest}`,
    p_causation_id: null,
    p_idempotency_key: `newsletter-signup-v1:${intentDigest}`,
    p_payload_version: "1.0",
    p_payload: {
      template_key: "cerberus-newsletter-signup",
      locale: "pt-BR",
      campaign_id: "newsletter-signup",
      content_variant: "default",
    },
  };
  const { data, error } = await adminClient().rpc("confirm_newsletter_consent_with_outbox", args);
  if (error) {
    const mapped = newsletterError(error);
    return json(req, { success: false, code: mapped.code, error: mapped.message }, mapped.status);
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || (row.result !== "created" && row.result !== "replayed") || row.subscriber_status !== "subscribed") {
    return json(req, { success: false, code: "NEWSLETTER_UNAVAILABLE", error: "Resposta de inscrição inválida." }, 503);
  }
  return json(req, { success: true, result: row.result, replayed: row.replayed === true }, row.result === "created" ? 201 : 200);
}

async function socialLinks(req: Request): Promise<Response> {
  const { data, error } = await adminClient().from("social_links").select("network,url").order("network");
  if (error) return json(req, { success: false, links: [], error: "SOCIAL_LINKS_UNAVAILABLE" }, 503);
  const links = (Array.isArray(data) ? data : []).flatMap((row: Record<string, unknown>) => {
    const network = text(row.network, 32).toLowerCase();
    const url = text(row.url, 2048);
    if (!SOCIAL_LABELS[network] || !/^https:\/\/[^\s]+$/i.test(url)) return [];
    return [{ network, label: SOCIAL_LABELS[network], url }];
  });
  return json(req, { success: true, links, source: "supabase-edge" });
}

function short(value: unknown, max = 300): string | null {
  const result = text(value, max);
  return result || null;
}

async function trackClick(req: Request): Promise<Response> {
  const blocked = await rateLimited(req, "track-click", 60, 90);
  if (blocked) return blocked;
  let body: Record<string, unknown>;
  try { body = await requestJson(req); } catch { return json(req, { success: false, code: "INVALID_BODY" }, 400); }
  const productId = text(body.productId, 160);
  if (!productId) return json(req, { success: false, code: "PRODUCT_ID_REQUIRED" }, 400);
  const { data: product, error: productError } = await adminClient()
    .from("products")
    .select("id,slug,produto,display_title,preco")
    .eq("id", productId)
    .maybeSingle();
  if (productError) return json(req, { success: false, code: "TRACKING_UNAVAILABLE" }, 503);
  if (!product) return json(req, { success: false, code: "PRODUCT_NOT_FOUND" }, 404);
  const record = {
    product_id: product.id,
    product_slug: product.slug || short(body.productSlug, 240) || "",
    product_name: product.display_title || product.produto || short(body.productName, 500) || "",
    product_price: Number(product.preco) || Number(body.productPrice) || 0,
    utm_source: short(body.utm_source),
    utm_medium: short(body.utm_medium),
    utm_campaign: short(body.utm_campaign),
    utm_content: short(body.utm_content),
    utm_term: short(body.utm_term),
    fbclid: short(body.fbclid, 500),
    gclid: short(body.gclid, 500),
    ttclid: short(body.ttclid, 500),
    referrer: short(body.referrer, 2048),
    landing_page: short(body.landingPage, 2048),
    user_agent: text(req.headers.get("user-agent") || "", 1000) || null,
    ip_address: clientIp(req),
    created_at: new Date().toISOString(),
  };
  const { error } = await adminClient().from("product_clicks").insert(record);
  if (error) return json(req, { success: false, code: "TRACKING_PERSIST_FAILED" }, 503);
  return json(req, { success: true }, 201);
}

function metaProduct(value: unknown): { id: string; name: string; category: string; price: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id, 160);
  const name = text(row.produto || row.displayTitle, 500);
  const category = text(row.categoria, 160);
  const price = Number(row.preco);
  return id && Number.isFinite(price) && price >= 0 ? { id, name, category, price } : null;
}

async function metaCapi(req: Request): Promise<Response> {
  const blocked = await rateLimited(req, "meta-capi", 60, 40);
  if (blocked) return blocked;
  const pixelId = text(Deno.env.get("META_PIXEL_ID"), 100);
  const accessToken = text(Deno.env.get("META_ACCESS_TOKEN"), 2048);
  if (!pixelId || !accessToken) return json(req, { success: false, code: "META_CAPI_NOT_CONFIGURED" }, 503);
  let body: Record<string, unknown>;
  try { body = await requestJson(req); } catch { return json(req, { success: false, code: "INVALID_BODY" }, 400); }
  const eventName = text(body.event_name, 80);
  const eventId = text(body.event_id, 160);
  const product = metaProduct(body.product);
  if (!eventName || !eventId || !product) return json(req, { success: false, code: "META_EVENT_INVALID" }, 400);
  if (!new Set(["InitiateCheckout", "ViewContent"]).has(eventName)) return json(req, { success: false, code: "META_EVENT_NOT_ALLOWED" }, 400);
  const eventSourceUrl = text(req.headers.get("referer") || "https://cerberus-finds.pages.dev/", 2048);
  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: "website",
      event_source_url: eventSourceUrl,
      user_data: {
        client_ip_address: clientIp(req),
        client_user_agent: text(req.headers.get("user-agent") || "", 1000),
      },
      custom_data: {
        content_ids: [product.id],
        content_name: product.name,
        content_category: product.category,
        content_type: "product",
        value: product.price,
        currency: "BRL",
      },
    }],
  };
  const response = await fetch(`https://graph.facebook.com/v22.0/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(accessToken)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    console.error(`[runtime-api] meta_capi_failed status=${response.status}`);
    return json(req, { success: false, code: "META_CAPI_PROVIDER_ERROR" }, 502);
  }
  return json(req, { success: true });
}

async function equalSecret(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return ha === hb;
}

async function isAdmin(req: Request, body?: Record<string, unknown>): Promise<boolean> {
  const configured = text(Deno.env.get("CERBERUS_ADMIN_PASSWORD"), 2048);
  const supplied = text(req.headers.get("x-admin-password") || body?.senha, 2048);
  return equalSecret(configured, supplied);
}

function sanitizeImages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => text(item, 2048)).filter(item => /^https:\/\//i.test(item)))].slice(0, 12);
}

function productMutation(body: Record<string, unknown>) {
  const produto = text(body.produto, 500);
  const categoria = text(body.categoria, 160);
  const preco = Number(body.preco);
  const imagens = sanitizeImages(body.imagens);
  const link = text(body.link, 2048);
  return {
    produto,
    categoria,
    preco: Number.isFinite(preco) ? preco : 0,
    imagens,
    link,
    destaque: body.destaque === true,
    descricao: text(body.descricao, 4000),
    pagina_ponte_url: text(body.paginaPonteUrl, 2048) || null,
    raw_title: text(body.rawTitle, 500) || produto,
    display_title: text(body.displayTitle, 90) || produto.slice(0, 90),
  };
}

async function adminVerify(req: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try { body = await requestJson(req); } catch { /* fail below */ }
  if (!await isAdmin(req, body)) return json(req, { success: false, error: "Senha incorreta." }, 401);
  return json(req, { success: true, message: "Senha de administrador verificada com sucesso!" });
}

async function adminCreateProduct(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await requestJson(req); } catch { return json(req, { success: false, code: "INVALID_BODY" }, 400); }
  if (!await isAdmin(req, body)) return json(req, { success: false, error: "Não autorizado." }, 401);
  const row = productMutation(body);
  if (!row.produto || !row.categoria || row.preco <= 0 || !row.link || row.imagens.length === 0) return json(req, { success: false, code: "PRODUCT_INPUT_INVALID" }, 400);
  const id = `admin-${crypto.randomUUID()}`;
  const slug = `${row.produto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60)}-${id.slice(-6)}`;
  const { data, error } = await adminClient().from("products").insert({
    id, ref: `ADM-${id.slice(-8).toUpperCase()}`, ...row, ativo: false, status: "pending", created_by: "admin_serverless", slug,
    image_editorial_status: "unreviewed", display_title_status: "unreviewed",
  }).select("*").single();
  if (error) return json(req, { success: false, code: "PRODUCT_CREATE_FAILED" }, 500);
  return json(req, { success: true, product: data, message: "Produto salvo como pendente. Publicação exige aprovação no Telegram." }, 201);
}

async function adminUpdateProduct(req: Request, id: string): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await requestJson(req); } catch { return json(req, { success: false, code: "INVALID_BODY" }, 400); }
  if (!await isAdmin(req, body)) return json(req, { success: false, error: "Não autorizado." }, 401);
  const client = adminClient();
  const { data: current, error: currentError } = await client.from("products").select("id,ativo,status").eq("id", id).maybeSingle();
  if (currentError) return json(req, { success: false, code: "PRODUCT_UPDATE_FAILED" }, 500);
  if (!current) return json(req, { success: false, code: "PRODUCT_NOT_FOUND" }, 404);
  if (current.ativo === true && current.status === "published") return json(req, { success: false, code: "PUBLIC_PRODUCT_IMMUTABLE_FROM_ADMIN_API", error: "Pause/arquive no fluxo governado antes de editar." }, 409);
  const row = productMutation(body);
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const inputKey = key === "pagina_ponte_url" ? "paginaPonteUrl" : key === "raw_title" ? "rawTitle" : key === "display_title" ? "displayTitle" : key;
    if (Object.prototype.hasOwnProperty.call(body, inputKey)) patch[key] = value;
  }
  patch.ativo = false;
  if (body.status === "archived") patch.status = "archived";
  const { data, error } = await client.from("products").update(patch).eq("id", id).select("*").single();
  if (error) return json(req, { success: false, code: "PRODUCT_UPDATE_FAILED" }, 500);
  return json(req, { success: true, product: data });
}

async function adminDeleteProduct(req: Request, id: string): Promise<Response> {
  let body: Record<string, unknown> = {};
  try { body = await requestJson(req); } catch { /* DELETE body may be empty */ }
  if (!await isAdmin(req, body)) return json(req, { success: false, error: "Não autorizado." }, 401);
  const client = adminClient();
  const { data, error } = await client.from("products").update({ ativo: false, status: "archived" }).eq("id", id).select("id").maybeSingle();
  if (error) return json(req, { success: false, code: "PRODUCT_ARCHIVE_FAILED" }, 500);
  if (!data) return json(req, { success: false, code: "PRODUCT_NOT_FOUND" }, 404);
  await client.from("catalog_overlay_entries").upsert({ product_id: id, action: "hide", source: "admin_archive", metadata: {} });
  return json(req, { success: true, archived: true });
}

async function adminExtract(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await requestJson(req); } catch { return json(req, { success: false, code: "INVALID_BODY" }, 400); }
  if (!await isAdmin(req, body)) return json(req, { success: false, error: "Não autorizado." }, 401);
  const rawText = text(body.rawText, 30_000);
  if (!rawText) return json(req, {
    success: false,
    code: "SERVERLESS_EXTRACTOR_INPUT_REQUIRED",
    error: "A extração serverless não consulta páginas da Shopee às cegas. Envie dados brutos/estruturados ou use o fluxo Telegram governado.",
  }, 422);
  try {
    const parsed = JSON.parse(rawText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return json(req, { success: true, data: parsed });
  } catch { /* text is not JSON */ }
  return json(req, { success: false, code: "SERVERLESS_EXTRACTOR_STRUCTURED_INPUT_REQUIRED", error: "Envie JSON estruturado para extração determinística." }, 422);
}

function routePath(req: Request): string {
  const pathname = new URL(req.url).pathname.replace(/\/+$/, "");
  const marker = "/cerberus-runtime-api";
  const index = pathname.indexOf(marker);
  return index >= 0 ? (pathname.slice(index + marker.length) || "/") : pathname;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const path = routePath(req);
  try {
    if (req.method === "GET" && path === "/health") {
      return json(req, {
        status: "ok",
        service: "cerberus-runtime-api",
        runtime: "supabase-edge",
        adminConfigured: Boolean(text(Deno.env.get("CERBERUS_ADMIN_PASSWORD"))),
        metaConfigured: Boolean(text(Deno.env.get("META_PIXEL_ID")) && text(Deno.env.get("META_ACCESS_TOKEN"))),
        renderDependency: false,
      });
    }
    if (req.method === "GET" && path === "/social-links") return socialLinks(req);
    if (req.method === "POST" && path === "/newsletter") return newsletter(req);
    if (req.method === "POST" && path === "/track-click") return trackClick(req);
    if (req.method === "POST" && path === "/meta-capi") return metaCapi(req);
    if (req.method === "POST" && path === "/admin/verify") return adminVerify(req);
    if (req.method === "POST" && path === "/admin/products") return adminCreateProduct(req);
    if (req.method === "POST" && path === "/admin/extract") return adminExtract(req);
    const productMatch = path.match(/^\/admin\/products\/([^/]+)$/);
    if (productMatch && req.method === "PUT") return adminUpdateProduct(req, decodeURIComponent(productMatch[1]));
    if (productMatch && req.method === "DELETE") return adminDeleteProduct(req, decodeURIComponent(productMatch[1]));
    return json(req, { success: false, code: "NOT_FOUND" }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "RUNTIME_API_ERROR";
    console.error(`[runtime-api] ${message.slice(0, 160)}`);
    return json(req, { success: false, code: "RUNTIME_API_UNAVAILABLE" }, 503);
  }
});
