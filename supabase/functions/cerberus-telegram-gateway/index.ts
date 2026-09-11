import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const MAX_BODY_BYTES = 1_000_000;
const PUBLIC_SITE = "https://cerberus-finds.pages.dev";

type JsonRecord = Record<string, any>;

function text(value: unknown, max = 2000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
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

function botToken(): string {
  return text(Deno.env.get("TELEGRAM_BOT_TOKEN"), 256);
}

function allowedUsers(): Set<string> {
  return new Set(
    text(Deno.env.get("TELEGRAM_ALLOWED_USER_IDS") || Deno.env.get("TELEGRAM_ALLOWED_USERS"), 4000)
      .split(",")
      .map(value => value.trim())
      .filter(value => /^\d+$/.test(value)),
  );
}

function isAllowed(userId: unknown): boolean {
  const configured = allowedUsers();
  return configured.size > 0 && configured.has(String(userId ?? ""));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function equalSecret(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return ha === hb;
}

async function telegram(method: string, payload: Record<string, unknown>): Promise<any> {
  const token = botToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN_MISSING");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok !== true) throw new Error(`TELEGRAM_API_${method.toUpperCase()}_${response.status}`);
  return body.result;
}

async function sendMessage(chatId: string | number, message: string, replyMarkup?: unknown): Promise<any> {
  return telegram("sendMessage", {
    chat_id: chatId,
    text: message,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function sendPhoto(chatId: string | number, photo: string, caption: string, replyMarkup?: unknown): Promise<any> {
  return telegram("sendPhoto", {
    chat_id: chatId,
    photo,
    caption: caption.slice(0, 1024),
    parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function answerCallback(callbackId: string, message?: string, showAlert = false): Promise<void> {
  await telegram("answerCallbackQuery", {
    callback_query_id: callbackId,
    ...(message ? { text: message.slice(0, 180) } : {}),
    show_alert: showAlert,
  }).catch(() => undefined);
}

function reviewData(row: any): JsonRecord {
  return row?.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data : {};
}

function reviewImage(data: JsonRecord): string {
  const candidates = [
    data?.imageCuration?.primaryImageUrl,
    data?.imagemPrincipal,
    Array.isArray(data?.imagens) ? data.imagens[0] : null,
  ].map(value => text(value, 2048));
  return candidates.find(value => /^https:\/\//i.test(value)) || "";
}

function reviewKeyboard(reviewId: string) {
  return {
    inline_keyboard: [
      [{ text: "✅ PUBLICAR", callback_data: `confirm_pub:${reviewId}` }],
      [{ text: "❌ DESCARTAR", callback_data: `cancel_rev:${reviewId}` }],
    ],
  };
}

function reviewCaption(row: any): string {
  const data = reviewData(row);
  const price = Number(data.preco);
  return [
    "🛡️ <b>CERBERUS — REVISÃO HUMANA</b>",
    "",
    `<b>${escapeHtml(data.displayTitle || data.produto || data.rawTitle || "Produto sem título")}</b>`,
    `Categoria: <b>${escapeHtml(data.categoria || "não informada")}</b>`,
    `Preço-base: <b>${Number.isFinite(price) && price > 0 ? `R$ ${price.toFixed(2).replace(".", ",")}` : "não confirmado"}</b>`,
    `Review: <code>${escapeHtml(row.id)}</code>`,
    "",
    "⚠️ <b>PUBLICAR</b> é uma decisão humana auditável. O banco só ativa o produto se review, identidade Shopee, imagem, autorização e callback forem coerentes.",
    "❌ <b>DESCARTAR</b> encerra esta review sem publicar.",
  ].join("\n");
}

async function sendReviewCard(row: any, overrideChatId?: string | number): Promise<void> {
  const chatId = overrideChatId ?? row.chat_id;
  if (!chatId) throw new Error("REVIEW_CHAT_ID_MISSING");
  const caption = reviewCaption(row);
  const keyboard = reviewKeyboard(String(row.id));
  const image = reviewImage(reviewData(row));
  if (image) {
    try {
      await sendPhoto(chatId, image, caption, keyboard);
      return;
    } catch {
      // A imagem pode bloquear hotlink; o card textual mantém o gate humano.
    }
  }
  await sendMessage(chatId, caption, keyboard);
}

function rotationKeyboard(requestId: string) {
  return {
    inline_keyboard: [
      [{ text: "✅ Aprovar substituição", callback_data: `rotation_approve:${requestId}` }],
      [{ text: "🔁 Buscar outra opção", callback_data: `rotation_retry:${requestId}` }],
      [{ text: "❌ Cancelar rotação", callback_data: `rotation_cancel:${requestId}` }],
    ],
  };
}

async function legacyBaselineIds(): Promise<Set<string>> {
  const { data, error } = await adminClient().from("catalog_legacy_baseline").select("product_id");
  if (error) throw new Error(`LEGACY_BASELINE_UNAVAILABLE:${error.code || "unknown"}`);
  return new Set((Array.isArray(data) ? data : []).map((row: any) => text(row.product_id)).filter(Boolean));
}

async function isPublicRotationSource(product: any): Promise<{ allowed: boolean; legacyBaseline: boolean }> {
  if (!product || product.status !== "published") return { allowed: false, legacyBaseline: false };
  if (product.ativo === true) return { allowed: true, legacyBaseline: false };
  const baseline = await legacyBaselineIds();
  return { allowed: baseline.has(String(product.id)), legacyBaseline: baseline.has(String(product.id)) };
}

async function sendRotationCard(requestId: string, chatId?: string | number): Promise<void> {
  const client = adminClient();
  const { data: request, error } = await client
    .from("product_rotation_requests")
    .select("id,source_product_id,candidate_product_id,telegram_chat_id,status")
    .eq("id", requestId)
    .maybeSingle();
  if (error || !request) throw new Error("ROTATION_REQUEST_NOT_FOUND");
  if (request.status !== "candidate_ready" || !request.candidate_product_id) throw new Error(`ROTATION_NOT_READY:${request.status}`);
  const { data: products, error: productsError } = await client
    .from("products")
    .select("id,produto,display_title,preco,categoria,imagens,image_curation")
    .in("id", [request.source_product_id, request.candidate_product_id]);
  if (productsError) throw new Error("ROTATION_PRODUCTS_UNAVAILABLE");
  const source = (products || []).find((row: any) => row.id === request.source_product_id);
  const candidate = (products || []).find((row: any) => row.id === request.candidate_product_id);
  if (!source || !candidate) throw new Error("ROTATION_PRODUCTS_MISSING");
  const message = [
    "🔄 <b>CERBERUS — PROPOSTA DE ROTAÇÃO</b>",
    "",
    `<b>Peça atual:</b> ${escapeHtml(source.display_title || source.produto)}`,
    `<b>Substituir por:</b> ${escapeHtml(candidate.display_title || candidate.produto)}`,
    `Categoria: ${escapeHtml(candidate.categoria)}`,
    `Preço-base: R$ ${Number(candidate.preco || 0).toFixed(2).replace(".", ",")}`,
    "",
    "A peça atual permanece publicada até sua aprovação explícita.",
  ].join("\n");
  const targetChat = chatId ?? request.telegram_chat_id;
  const image = reviewImage(candidate);
  if (image) {
    try {
      await sendPhoto(targetChat, image, message, rotationKeyboard(requestId));
      return;
    } catch {
      // fallback textual
    }
  }
  await sendMessage(targetChat, message, rotationKeyboard(requestId));
}

async function persistUpdate(updateId: number, rawBody: string): Promise<void> {
  await adminClient().rpc("cerberus_telegram_register_update", {
    p_update_id: updateId,
    p_payload_hash: await sha256(rawBody),
  });
}

async function markUpdate(updateId: number, status: "processed" | "rejected" | "error", code?: string): Promise<void> {
  await adminClient().rpc("cerberus_telegram_mark_update", {
    p_update_id: updateId,
    p_status: status,
    p_error_code: code || null,
  }).catch(() => undefined);
}

function callbackContext(update: any) {
  const query = update?.callback_query;
  return {
    callbackId: text(query?.id, 256),
    data: text(query?.data, 256),
    senderId: String(query?.from?.id ?? ""),
    chatId: String(query?.message?.chat?.id ?? ""),
    messageId: String(query?.message?.message_id ?? ""),
  };
}

async function handleCallback(update: any): Promise<void> {
  const ctx = callbackContext(update);
  if (!ctx.callbackId || !ctx.data || !ctx.chatId || !ctx.senderId) throw new Error("TELEGRAM_CALLBACK_INVALID");
  if (!isAllowed(ctx.senderId)) {
    await answerCallback(ctx.callbackId, "Usuário não autorizado.", true);
    throw new Error("TELEGRAM_USER_NOT_ALLOWED");
  }
  const client = adminClient();

  if (ctx.data.startsWith("confirm_pub:")) {
    const reviewId = ctx.data.slice("confirm_pub:".length);
    await answerCallback(ctx.callbackId, "⏳ Validando aprovação humana...");
    const { data, error } = await client.rpc("cerberus_telegram_publish_review", {
      p_review_id: reviewId,
      p_sender_id: ctx.senderId,
      p_chat_id: ctx.chatId,
      p_message_id: ctx.messageId,
      p_callback_query_id: ctx.callbackId,
    });
    if (error) {
      await sendMessage(ctx.chatId, `❌ <b>PUBLICAÇÃO BLOQUEADA</b>\n\n<code>${escapeHtml(error.message || error.code || "HUMAN_GATE_REJECTED")}</code>\n\nNenhum bypass foi executado.`);
      throw new Error(`PUBLISH_REJECTED:${error.code || "unknown"}`);
    }
    await sendMessage(ctx.chatId, `✅ <b>PUBLICAÇÃO CONFIRMADA</b>\n\nProduto: <code>${escapeHtml(data?.productId || "confirmado")}</code>\nOperação: <code>${escapeHtml(data?.operationId || "confirmada")}</code>\n\nA prova do seu callback foi persistida e a autorização humana foi consumida pelo banco.`);
    return;
  }

  if (ctx.data.startsWith("cancel_rev:")) {
    const reviewId = ctx.data.slice("cancel_rev:".length);
    await answerCallback(ctx.callbackId, "Descartando review...");
    const { error } = await client.rpc("cerberus_telegram_discard_review", {
      p_review_id: reviewId,
      p_sender_id: ctx.senderId,
      p_chat_id: ctx.chatId,
      p_message_id: ctx.messageId,
      p_callback_query_id: ctx.callbackId,
    });
    if (error) throw new Error(`DISCARD_REJECTED:${error.code || "unknown"}`);
    await sendMessage(ctx.chatId, `❌ <b>REVIEW DESCARTADA</b>\n\n<code>${escapeHtml(reviewId)}</code>\nNenhum produto foi publicado.`);
    return;
  }

  if (ctx.data.startsWith("rotation_approve:")) {
    const requestId = ctx.data.slice("rotation_approve:".length);
    await answerCallback(ctx.callbackId, "Aplicando rotação aprovada...");
    const { data, error } = await client.rpc("cerberus_telegram_apply_rotation", {
      p_request_id: requestId,
      p_sender_id: ctx.senderId,
      p_chat_id: ctx.chatId,
      p_message_id: ctx.messageId,
      p_callback_query_id: ctx.callbackId,
    });
    if (error) {
      await sendMessage(ctx.chatId, `❌ <b>ROTAÇÃO BLOQUEADA</b>\n\n<code>${escapeHtml(error.message || error.code || "ROTATION_REJECTED")}</code>\nA peça atual foi preservada sempre que a transação não concluiu.`);
      throw new Error(`ROTATION_REJECTED:${error.code || "unknown"}`);
    }
    await sendMessage(ctx.chatId, `✅ <b>ROTAÇÃO APLICADA</b>\n\nNova peça: <code>${escapeHtml(data?.productId || "confirmada")}</code>\nOperação: <code>${escapeHtml(data?.operationId || "confirmada")}</code>`);
    return;
  }

  if (ctx.data.startsWith("rotation_retry:") || ctx.data.startsWith("rotation_cancel:")) {
    const retry = ctx.data.startsWith("rotation_retry:");
    const prefix = retry ? "rotation_retry:" : "rotation_cancel:";
    const requestId = ctx.data.slice(prefix.length);
    const { data, error } = await client.rpc("cerberus_telegram_rotation_decision", {
      p_request_id: requestId,
      p_decision: retry ? "rotation_retry" : "rotation_cancel",
      p_sender_id: ctx.senderId,
      p_chat_id: ctx.chatId,
      p_message_id: ctx.messageId,
      p_callback_query_id: ctx.callbackId,
    });
    await answerCallback(ctx.callbackId, retry ? "Nova busca registrada." : "Rotação cancelada.");
    if (error) throw new Error(`ROTATION_DECISION_REJECTED:${error.code || "unknown"}`);
    await sendMessage(ctx.chatId, retry
      ? `🔁 <b>NOVA BUSCA SOLICITADA</b>\n\nRequest: <code>${escapeHtml(requestId)}</code>\nEstado: <code>${escapeHtml(data?.status || "searching")}</code>`
      : `❌ <b>ROTAÇÃO CANCELADA</b>\n\nRequest: <code>${escapeHtml(requestId)}</code>\nA peça atual continua publicada.`);
    return;
  }

  if (ctx.data.startsWith("product_rotate:")) {
    const productId = ctx.data.slice("product_rotate:".length);
    await answerCallback(ctx.callbackId, "Criando solicitação de rotação...");
    const { data: product, error: productError } = await client
      .from("products")
      .select("id,categoria,ativo,status")
      .eq("id", productId)
      .maybeSingle();
    if (productError || !product) throw new Error("ROTATION_SOURCE_INVALID");
    const visibility = await isPublicRotationSource(product);
    if (!visibility.allowed) throw new Error("ROTATION_SOURCE_NOT_PUBLIC");
    const { data: request, error } = await client.from("product_rotation_requests").insert({
      source_product_id: product.id,
      category: product.categoria,
      status: "searching",
      requested_by: ctx.senderId,
      telegram_chat_id: ctx.chatId,
      metadata: {
        origin: "telegram-edge",
        callbackQueryId: ctx.callbackId,
        sourceWasLegacyBaseline: visibility.legacyBaseline,
      },
    }).select("id,status").single();
    if (error) throw new Error(`ROTATION_REQUEST_CREATE_FAILED:${error.code || "unknown"}`);
    await sendMessage(ctx.chatId, `🔎 <b>ROTAÇÃO REGISTRADA</b>\n\nRequest: <code>${escapeHtml(request.id)}</code>\nA peça atual permanece publicada até uma candidata ser apresentada e você tocar em <b>Aprovar substituição</b>.`);
    return;
  }

  await answerCallback(ctx.callbackId, "Ação não suportada neste runtime.", true);
  throw new Error("TELEGRAM_CALLBACK_UNSUPPORTED");
}

async function publicProductsForTelegram(): Promise<any[]> {
  const client = adminClient();
  const [baselineResult, productsResult] = await Promise.all([
    client.from("catalog_legacy_baseline").select("product_id"),
    client.from("products").select("id,ref,produto,display_title,slug,ativo,status").eq("status", "published").limit(100),
  ]);
  if (baselineResult.error || productsResult.error) throw new Error("PRODUCT_LIST_UNAVAILABLE");
  const baseline = new Set((baselineResult.data || []).map((row: any) => String(row.product_id)));
  return (productsResult.data || []).filter((row: any) => row.ativo === true || baseline.has(String(row.id))).slice(0, 10);
}

async function handleMessage(update: any): Promise<void> {
  const message = update?.message;
  const senderId = String(message?.from?.id ?? "");
  const chatId = String(message?.chat?.id ?? "");
  const command = text(message?.text, 2000);
  if (!senderId || !chatId) throw new Error("TELEGRAM_MESSAGE_INVALID");
  if (!isAllowed(senderId)) throw new Error("TELEGRAM_USER_NOT_ALLOWED");

  if (/^\/(?:start|menu)(?:\s|$)/i.test(command)) {
    await sendMessage(chatId, [
      "🛡️ <b>CERBERUS — RUNTIME SERVERLESS</b>",
      "",
      "O webhook está no Supabase Edge; não depende do Render.",
      "• <code>/review ID</code> — reabrir card pendente",
      "• <code>/produtos</code> — listar peças públicas, inclusive a baseline legada",
      "",
      "Publicação e rotação continuam exigindo seu callback explícito no Telegram.",
    ].join("\n"));
    return;
  }

  const reviewMatch = command.match(/^\/review\s+([^\s]+)$/i);
  if (reviewMatch) {
    const { data, error } = await adminClient().from("telegram_pending_reviews").select("*").eq("id", reviewMatch[1]).maybeSingle();
    if (error || !data) {
      await sendMessage(chatId, "⚠️ Review não encontrada.");
      return;
    }
    await sendReviewCard(data, chatId);
    return;
  }

  if (/^\/produtos(?:\s|$)/i.test(command)) {
    const rows = await publicProductsForTelegram();
    const rendered = rows.length
      ? rows.map((row: any) => `• <a href="${PUBLIC_SITE}/produto/${encodeURIComponent(row.slug || row.id)}">${escapeHtml(row.display_title || row.produto)}</a> · <code>${escapeHtml(row.ref || row.id)}</code>`).join("\n")
      : "Nenhuma peça pública encontrada.";
    await sendMessage(chatId, `📦 <b>PEÇAS PÚBLICAS</b>\n\n${rendered}`);
    return;
  }

  await sendMessage(chatId, "Use <code>/menu</code> para ver os comandos serverless disponíveis.");
}

async function processUpdate(update: any, rawBody: string): Promise<void> {
  const updateId = Number(update?.update_id);
  if (!Number.isInteger(updateId) || updateId < 0) throw new Error("TELEGRAM_UPDATE_ID_INVALID");
  await persistUpdate(updateId, rawBody);
  try {
    if (update?.callback_query) await handleCallback(update);
    else if (update?.message) await handleMessage(update);
    else throw new Error("TELEGRAM_UPDATE_UNSUPPORTED");
    await markUpdate(updateId, "processed");
  } catch (error) {
    const message = error instanceof Error ? error.message : "TELEGRAM_UPDATE_ERROR";
    await markUpdate(updateId, message.includes("NOT_ALLOWED") ? "rejected" : "error", message);
    throw error;
  }
}

async function internalAuthorized(req: Request): Promise<boolean> {
  const configured = text(Deno.env.get("CERBERUS_INTERNAL_TOKEN"), 512);
  const supplied = text(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || req.headers.get("x-cerberus-internal-token"), 512);
  return equalSecret(configured, supplied);
}

async function parseJson(req: Request): Promise<JsonRecord> {
  const raw = await req.text();
  if (!raw || raw.length > MAX_BODY_BYTES) throw new Error("INVALID_BODY");
  const body = JSON.parse(raw);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("INVALID_BODY");
  return body;
}

function normalizeReviewPayload(input: JsonRecord) {
  const data = input.data && typeof input.data === "object" && !Array.isArray(input.data) ? input.data : input;
  const images = Array.isArray(data.imagens)
    ? data.imagens.map((item: unknown) => text(item, 2048)).filter((item: string) => /^https:\/\//i.test(item)).slice(0, 12)
    : [];
  const primary = text(data?.imageCuration?.primaryImageUrl || data.imagemPrincipal || images[0], 2048);
  return {
    ...data,
    produto: text(data.produto || data.rawTitle, 500),
    rawTitle: text(data.rawTitle || data.produto, 500),
    displayTitle: text(data.displayTitle || data.produto || data.rawTitle, 90),
    categoria: text(data.categoria, 160),
    preco: Number(data.preco),
    imagens: images,
    imageCuration: data.imageCuration && typeof data.imageCuration === "object"
      ? data.imageCuration
      : { status: "ready", primaryImageUrl: primary },
    link: text(data.link, 2048),
    normalizedUrl: text(data.normalizedUrl || data.sourceProductUrl, 2048),
    shopId: text(data.shopId || data?.existingProduct?.shopId, 120),
    itemId: text(data.itemId || data?.existingProduct?.itemId, 120),
    descricao: text(data.descricao, 4000),
  };
}

async function createCard(req: Request): Promise<Response> {
  if (!await internalAuthorized(req)) return json({ ok: false, error: "UNAUTHORIZED" }, 401);
  let body: JsonRecord;
  try { body = await parseJson(req); } catch { return json({ ok: false, error: "INVALID_BODY" }, 400); }
  const data = normalizeReviewPayload(body);
  const chatId = text(body.chatId || body.chat_id, 64);
  const senderId = text(body.senderId || body.sender_id || [...allowedUsers()][0], 64);
  if (!chatId || !senderId || !isAllowed(senderId)) return json({ ok: false, error: "REVIEW_OWNER_INVALID" }, 400);
  if (!data.produto || !data.displayTitle || !data.categoria || !Number.isFinite(data.preco) || data.preco <= 0 || !data.link || !data.normalizedUrl || !data.shopId || !data.itemId || !reviewImage(data)) {
    return json({ ok: false, error: "REVIEW_DATA_INCOMPLETE" }, 400);
  }
  const reviewId = text(body.reviewId || body.id, 160) || `edge-review-${crypto.randomUUID()}`;
  const now = Date.now();
  const row = {
    id: reviewId,
    chat_id: chatId,
    sender_id: senderId,
    first_name: text(body.firstName, 160) || null,
    username: text(body.username, 160) || null,
    created_at: now,
    expires_at: now + 24 * 60 * 60 * 1000,
    status: "pending",
    data,
    updated_at: new Date().toISOString(),
  };
  const { data: saved, error } = await adminClient().from("telegram_pending_reviews").upsert(row, { onConflict: "id" }).select("*").single();
  if (error) return json({ ok: false, error: "REVIEW_PERSIST_FAILED" }, 500);
  await sendReviewCard(saved);
  return json({ ok: true, reviewId, cardSent: true }, 201);
}

async function sendRotationCardEndpoint(req: Request): Promise<Response> {
  if (!await internalAuthorized(req)) return json({ ok: false, error: "UNAUTHORIZED" }, 401);
  let body: JsonRecord;
  try { body = await parseJson(req); } catch { return json({ ok: false, error: "INVALID_BODY" }, 400); }
  const requestId = text(body.requestId, 80);
  if (!requestId) return json({ ok: false, error: "REQUEST_ID_REQUIRED" }, 400);
  await sendRotationCard(requestId, body.chatId ? text(body.chatId, 64) : undefined);
  return json({ ok: true, requestId, cardSent: true });
}

async function registerWebhook(req: Request): Promise<Response> {
  if (!await internalAuthorized(req)) return json({ ok: false, error: "UNAUTHORIZED" }, 401);
  const secret = text(Deno.env.get("TELEGRAM_WEBHOOK_SECRET"), 256);
  const supabaseUrl = text(Deno.env.get("SUPABASE_URL"), 2048).replace(/\/+$/, "");
  if (!botToken() || !secret || !supabaseUrl) return json({ ok: false, error: "TELEGRAM_CONFIG_MISSING" }, 503);
  const webhookUrl = `${supabaseUrl}/functions/v1/cerberus-telegram-gateway/webhook`;
  const result = await telegram("setWebhook", {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
  return json({ ok: true, webhookUrl, registered: result === true });
}

function routePath(req: Request): string {
  const pathname = new URL(req.url).pathname.replace(/\/+$/, "");
  const marker = "/cerberus-telegram-gateway";
  const index = pathname.indexOf(marker);
  return index >= 0 ? (pathname.slice(index + marker.length) || "/") : pathname;
}

Deno.serve(async (req: Request) => {
  const path = routePath(req);
  if (req.method === "GET" && path === "/health") {
    return json({
      status: "ok",
      service: "cerberus-telegram-gateway",
      runtime: "supabase-edge",
      botConfigured: Boolean(botToken()),
      allowedUsersConfigured: allowedUsers().size > 0,
      webhookSecretConfigured: Boolean(text(Deno.env.get("TELEGRAM_WEBHOOK_SECRET"))),
      internalTokenConfigured: Boolean(text(Deno.env.get("CERBERUS_INTERNAL_TOKEN"))),
      renderDependency: false,
      humanGate: "telegram-db-authorization-v1",
      legacyBaselineAware: true,
    });
  }

  try {
    if (req.method === "POST" && path === "/card") return createCard(req);
    if (req.method === "POST" && path === "/rotation-card") return sendRotationCardEndpoint(req);
    if (req.method === "POST" && path === "/register-webhook") return registerWebhook(req);
    if (req.method !== "POST" || (path !== "/webhook" && path !== "/")) return json({ ok: false, error: "NOT_FOUND" }, 404);

    const expectedSecret = text(Deno.env.get("TELEGRAM_WEBHOOK_SECRET"), 256);
    const suppliedSecret = text(req.headers.get("x-telegram-bot-api-secret-token"), 256);
    if (!await equalSecret(expectedSecret, suppliedSecret)) return json({ ok: false, error: "TELEGRAM_WEBHOOK_UNAUTHORIZED" }, 403);
    if (!req.headers.get("content-type")?.toLowerCase().includes("application/json")) return json({ ok: false, error: "CONTENT_TYPE_REQUIRED" }, 415);
    const rawBody = await req.text();
    if (!rawBody || rawBody.length > MAX_BODY_BYTES) return json({ ok: false, error: "INVALID_BODY" }, 400);
    let update: any;
    try { update = JSON.parse(rawBody); } catch { return json({ ok: false, error: "INVALID_JSON" }, 400); }
    await processUpdate(update, rawBody);
    return json({ ok: true, accepted: true, processed: true, gateway: "supabase-edge" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "TELEGRAM_EDGE_ERROR";
    console.error(`[telegram-edge] ${message.slice(0, 180)}`);
    if (message.includes("NOT_ALLOWED") || message.includes("UNSUPPORTED")) return json({ ok: true, accepted: true, rejected: true }, 200);
    return json({ ok: false, error: "TELEGRAM_EDGE_UNAVAILABLE" }, 503);
  }
});
