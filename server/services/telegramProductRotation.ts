import * as core from "./telegramBotCore";
import * as productsRepository from "../repositories/productsRepository";
import { requireSupabase } from "../repositories/productsRepository";
import { resolveCanonicalProductImage } from "../../src/lib/productCanonical";
import { resolvePublicSiteUrl } from "./newsletterInstitutional";
import { syncCatalogAndDeploy } from "./catalogSync";
import {
  approveProductRotation,
  cancelProductRotation,
  getProductRotationRequest,
  listRecoverableProductRotations,
  ProductRotationSearchError,
  proposeNextProductRotationCandidate,
  rejectRotationCandidateAndSearchAgain,
  startProductRotation,
  type RotationProposal,
  type RotationSearchDiagnostics,
} from "./productRotation";

const ROTATION_SEARCH_RETRY_MS = 2_000;
const ROTATION_PROVIDER_RETRY_MS = 15_000;
const ROTATION_SUPERVISOR_INTERVAL_MS = 60_000;
const ROTATION_HARD_TIMEOUT_MS = 4 * 60_000;
const activeRotationSearchWorkers = new Set<string>();
const activeRotationApplyRecoveries = new Set<string>();
let rotationSupervisorTimer: ReturnType<typeof setInterval> | null = null;
let rotationSupervisorStarted = false;

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function money(value: unknown): string {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0
    ? `R$ ${amount.toFixed(2).replace(".", ",")}`
    : "não informado";
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || "UNKNOWN"))
    .replace(/[\r\n]+/g, " ")
    .slice(0, 180);
}

function rotationWarningLabel(reason: string): string {
  if (reason === "LOW_CONFIDENCE") return "baixa confiança";
  if (reason.startsWith("PROFILE_BLOCKED_TERM:")) return "estética fora do perfil";
  if (/PROMO|PROMOTIONAL|OVERLAY/i.test(reason)) return "imagem promocional";
  if (/IMAGE_(UNKNOWN|REVIEW|CLEAN)_/i.test(reason)) return "imagem requer revisão humana";
  return reason.toLocaleLowerCase("pt-BR").replace(/_/g, " ");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));
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

function searchingKeyboard(requestId: string) {
  return {
    inline_keyboard: [[{ text: "❌ Cancelar rotação", callback_data: `rotation_cancel:${requestId}` }]],
  };
}

function retryKeyboard(requestId: string) {
  return {
    inline_keyboard: [
      [{ text: "🔁 Tentar novamente", callback_data: `rotation_retry:${requestId}` }],
      [{ text: "❌ Cancelar rotação", callback_data: `rotation_cancel:${requestId}` }],
    ],
  };
}

function summarizeRotationDiagnostics(diagnostics: RotationSearchDiagnostics): string {
  const reasons = Object.entries(diagnostics.rejectionCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([reason, count]) => `${count}× ${reason}`)
    .join("; ");
  return [
    `busca executada: ${diagnostics.providerQueriesExecuted > 0 ? "sim" : "não"}`,
    `candidatos recebidos: ${diagnostics.candidatesReceived}`,
    `candidatos avaliados: ${diagnostics.candidatesExamined}`,
    reasons ? `rejeições: ${reasons}` : "rejeições: nenhuma registrada",
  ].join("; ");
}

function rotationSearchFailureMessage(error: unknown): { text: string; retryable: boolean } {
  if (!(error instanceof ProductRotationSearchError)) {
    return {
      text:
        "⚠️ <b>ROTAÇÃO NÃO CONCLUÍDA</b>\n\n" +
        `Motivo: <code>${escapeHtml(safeError(error))}</code>\n\n` +
        "A peça atual continua publicada e nenhuma troca foi feita.",
      retryable: true,
    };
  }

  const diagnostic = escapeHtml(summarizeRotationDiagnostics(error.diagnostics));
  if (error.code === "SHOPEE_PROVIDER_NOT_CONFIGURED") {
    return {
      text:
        "⛔ <b>ROTAÇÃO BLOQUEADA — PROVIDER SHOPEE NÃO CONFIGURADO</b>\n\n" +
        "<code>SHOPEE_PROVIDER_NOT_CONFIGURED</code>\n" +
        "Configure as credenciais oficiais da Affiliate API somente no secret manager do ambiente. Nenhuma ausência de configuração foi convertida em falta de candidatos.\n\n" +
        "A peça atual continua publicada e nenhuma troca foi feita.",
      retryable: false,
    };
  }
  if (error.code === "SHOPEE_PROVIDER_AUTH_FAILED") {
    return {
      text:
        "⛔ <b>ROTAÇÃO BLOQUEADA — AUTENTICAÇÃO SHOPEE REJEITADA</b>\n\n" +
        "<code>SHOPEE_PROVIDER_AUTH_FAILED</code>\n" +
        "Revise credenciais e permissões/scopes no secret manager do ambiente.\n\n" +
        "A peça atual continua publicada e nenhuma troca foi feita.",
      retryable: false,
    };
  }
  if (["SHOPEE_PROVIDER_RATE_LIMITED", "SHOPEE_PROVIDER_TIMEOUT", "SHOPEE_PROVIDER_UNAVAILABLE"].includes(error.code)) {
    return {
      text:
        "⚠️ <b>ROTAÇÃO ADIADA — PROVIDER SHOPEE INDISPONÍVEL</b>\n\n" +
        `<code>${escapeHtml(error.code)}</code>\n` +
        `Diagnóstico seguro: <code>${diagnostic}</code>\n\n` +
        "A falha foi tratada como temporária; a busca continuará automaticamente e a peça atual permanece publicada.",
      retryable: true,
    };
  }
  if (error.code === "SHOPEE_PROVIDER_RESPONSE_INVALID") {
    return {
      text:
        "⛔ <b>ROTAÇÃO BLOQUEADA — RESPOSTA SHOPEE INCOMPATÍVEL</b>\n\n" +
        "<code>SHOPEE_PROVIDER_RESPONSE_INVALID</code>\n" +
        `Diagnóstico seguro: <code>${diagnostic}</code>\n\n` +
        "A peça atual continua publicada e nenhuma troca foi feita.",
      retryable: false,
    };
  }
  if (error.code === "ROTATION_CANDIDATE_PERSIST_FAILED") {
    return {
      text:
        "⚠️ <b>ROTAÇÃO AGUARDANDO NOVA TENTATIVA DE PERSISTÊNCIA</b>\n\n" +
        "<code>ROTATION_CANDIDATE_PERSIST_FAILED</code>\n" +
        `Diagnóstico seguro: <code>${diagnostic}</code>\n\n` +
        "A busca continuará automaticamente. A peça atual continua publicada.",
      retryable: true,
    };
  }
  return {
    text:
      "🔄 <b>ROTAÇÃO CONTINUA EM BUSCA</b>\n\n" +
      `Diagnóstico do lote atual: ${diagnostic}.\n\n` +
      "Os candidatos deste lote não passaram pelos gates. O Cerberus avançará automaticamente para novas consultas e páginas da Shopee; você não precisa tentar novamente.",
    retryable: true,
  };
}

async function sendRotationProposal(proposal: RotationProposal): Promise<void> {
  const { request, source, candidate, score } = proposal;
  const warnings = [...new Set((proposal.warnings || []).map(rotationWarningLabel))];
  const warningBlock = warnings.length > 0
    ? ["⚠️ <b>AVISOS — NÃO SÃO BLOQUEIOS FATAIS</b>", ...warnings.map(warning => `⚠️ ${escapeHtml(warning)}`)].join("\n")
    : "✅ <b>Avisos estéticos:</b> nenhum registrado";
  const caption = [
    "🔄 <b>CERBERUS — PROPOSTA DE ROTAÇÃO</b>",
    "",
    "<b>Peça atual</b>",
    `• ${escapeHtml(source.displayTitle || source.produto)}`,
    `• ${escapeHtml(source.ref || source.id)}`,
    `• ${money(source.preco)}`,
    "",
    "⬇️ <b>Substituir por</b>",
    `• ${escapeHtml(candidate.displayTitle || candidate.produto)}`,
    `• ${escapeHtml(candidate.ref || candidate.id)}`,
    `• ${money(candidate.preco)}`,
    `• Categoria: ${escapeHtml(candidate.categoria)}`,
    `• Compatibilidade rápida: <b>${Math.round(score)}/100</b>`,
    "",
    warningBlock,
    "",
    "✅ Identidade Shopee, disponibilidade, link afiliado, preço, categoria e imagem do anúncio foram conferidos.",
    "",
    "<i>A escolha estética final é sua. Não gostou? Toque em Buscar outra opção. A peça atual continua publicada até você aprovar.</i>",
  ].join("\n");
  const image = resolveCanonicalProductImage(candidate).primaryImageUrl;
  if (image && /^https:\/\//i.test(image)) {
    const sent = await core.sendTelegramPhoto(request.telegramChatId, image, caption, rotationKeyboard(request.id));
    if (sent.ok) return;
  }
  const textSent = await core.sendTelegramMessage(request.telegramChatId, caption, rotationKeyboard(request.id));
  if (!textSent.ok) throw new Error("ROTATION_CARD_DELIVERY_FAILED");
}

function isAutomaticRotationRetry(error: unknown): error is ProductRotationSearchError {
  return error instanceof ProductRotationSearchError && [
    "NO_QUALIFIED_REPLACEMENT_FOUND",
    "ROTATION_CANDIDATE_PERSIST_FAILED",
    "SHOPEE_PROVIDER_RATE_LIMITED",
    "SHOPEE_PROVIDER_TIMEOUT",
    "SHOPEE_PROVIDER_UNAVAILABLE",
  ].includes(error.code);
}

function automaticRotationRetryDelay(error: ProductRotationSearchError): number {
  return ["SHOPEE_PROVIDER_RATE_LIMITED", "SHOPEE_PROVIDER_TIMEOUT", "SHOPEE_PROVIDER_UNAVAILABLE"].includes(error.code)
    ? ROTATION_PROVIDER_RETRY_MS
    : ROTATION_SEARCH_RETRY_MS;
}

async function searchAndDeliverRotation(requestId: string, chatId: string | number): Promise<void> {
  if (activeRotationSearchWorkers.has(requestId)) return;
  activeRotationSearchWorkers.add(requestId);
  const deadline = Date.now() + ROTATION_HARD_TIMEOUT_MS;
  try {
    for (;;) {
      if (Date.now() >= deadline) {
        await cancelProductRotation(requestId).catch(() => undefined);
        await core.sendTelegramMessage(chatId, "⏱️ <b>ROTAÇÃO ENCERRADA POR TIMEOUT</b>\n\nA busca manual atingiu o limite de quatro minutos. A peça atual continua publicada e nenhuma troca foi feita.");
        return;
      }
      const current = await getProductRotationRequest(requestId);
      if (!current || ["cancelled", "replaced", "applying"].includes(current.status)) return;
      try {
        const proposal = await proposeNextProductRotationCandidate(requestId);
        const latest = await getProductRotationRequest(requestId);
        if (!latest || latest.status !== "candidate_ready" || latest.candidateProductId !== proposal.candidate.id) continue;
        await sendRotationProposal(proposal);
        return;
      } catch (error) {
        if (isAutomaticRotationRetry(error)) {
          const latest = await getProductRotationRequest(requestId).catch(() => null);
          if (!latest || ["cancelled", "replaced", "applying"].includes(latest.status)) return;
          const remaining = deadline - Date.now();
          if (remaining <= 0) continue;
          await sleep(Math.min(automaticRotationRetryDelay(error), remaining));
          continue;
        }
        const rendered = rotationSearchFailureMessage(error);
        await core.sendTelegramMessage(
          chatId,
          rendered.text,
          rendered.retryable ? retryKeyboard(requestId) : { inline_keyboard: [[{ text: "❌ Cancelar rotação", callback_data: `rotation_cancel:${requestId}` }]] },
        );
        return;
      }
    }
  } finally {
    activeRotationSearchWorkers.delete(requestId);
  }
}

function ensureRotationSearchWorker(requestId: string, chatId: string | number): void {
  if (activeRotationSearchWorkers.has(requestId)) return;
  void searchAndDeliverRotation(requestId, chatId).catch(error => {
    console.error(`[ROTATION] worker_failed request=${requestId} error=${safeError(error)}`);
  });
}

async function recoverApplyingRotation(requestId: string, chatId: string | number): Promise<void> {
  if (activeRotationApplyRecoveries.has(requestId)) return;
  activeRotationApplyRecoveries.add(requestId);
  try {
    const request = await getProductRotationRequest(requestId);
    if (!request || request.status !== "applying" || !request.candidateProductId) return;
    const source = await productsRepository.getProductByIdOrSlug(request.sourceProductId);
    const candidate = await productsRepository.getProductByIdOrSlug(request.candidateProductId);
    if (!source || !candidate) {
      const { error } = await requireSupabase().from("product_rotation_requests").update({
        status: "failed",
        reason: "APPLY_RECOVERY_PRODUCTS_MISSING",
        updated_at: new Date().toISOString(),
      }).eq("id", request.id).eq("status", "applying");
      if (error) throw error;
      return;
    }

    const sourcePublished = source.status === "published" && source.ativo !== false;
    const sourceArchived = source.status === "archived" && source.ativo === false;
    const candidatePublished = candidate.status === "published" && candidate.ativo !== false;
    const candidatePaused = candidate.status === "paused" && candidate.ativo === false;

    if (candidatePublished) {
      if (sourcePublished) {
        const { error } = await requireSupabase().from("products").update({ ativo: false, status: "archived" })
          .eq("id", source.id).eq("status", "published");
        if (error) throw error;
      } else if (!sourceArchived) {
        throw new Error(`APPLY_RECOVERY_SOURCE_STATE:${source.status}:${String(source.ativo)}`);
      }

      const sync = await syncCatalogAndDeploy(`manual product rotation recovery ${request.id}`);
      if (!sync.success) throw new Error(`ROTATION_CATALOG_SYNC_RECOVERY_FAILED:${sync.error || "unknown"}`);

      const completedAt = new Date().toISOString();
      const { data, error } = await requireSupabase().from("product_rotation_requests").update({
        status: "replaced",
        replacement_product_id: candidate.id,
        reason: "ROTATED_BY_USER",
        completed_at: completedAt,
        updated_at: completedAt,
        metadata: {
          ...request.metadata,
          archive_reason: "ROTATED_BY_USER",
          recovered_after_restart: true,
          replaced_at: completedAt,
        },
      }).eq("id", request.id).eq("status", "applying").select("id").maybeSingle();
      if (error) throw error;
      if (data) {
        await core.sendTelegramMessage(
          chatId,
          "✅ <b>ROTAÇÃO CONCLUÍDA</b>\n\n" +
            `${escapeHtml(source.displayTitle || source.produto)}\n⬇️ substituído por\n` +
            `<b>${escapeHtml(candidate.displayTitle || candidate.produto)}</b>\n\n` +
            "✅ Nova peça publicada\n✅ Catálogo público sincronizado\n✅ Recuperação pós-restart concluída",
          { inline_keyboard: [[{ text: "👁️ Ver nova peça", callback_data: `product_view:${candidate.id}` }], [{ text: "📦 Produtos", callback_data: "products_list:0" }]] },
        );
      }
      return;
    }

    if (candidatePaused) {
      if (sourceArchived) {
        const { error } = await requireSupabase().from("products").update({ ativo: true, status: "published" })
          .eq("id", source.id).eq("status", "archived");
        if (error) throw error;
      } else if (!sourcePublished) {
        throw new Error(`APPLY_RECOVERY_SOURCE_STATE:${source.status}:${String(source.ativo)}`);
      }
      const recoveredAt = new Date().toISOString();
      const { data, error } = await requireSupabase().from("product_rotation_requests").update({
        status: "candidate_ready",
        reason: "APPLY_RECOVERED_TO_REVIEW",
        updated_at: recoveredAt,
        metadata: { ...request.metadata, recovered_after_restart: true, recovered_at: recoveredAt },
      }).eq("id", request.id).eq("status", "applying").select("id").maybeSingle();
      if (error) throw error;
      if (data) {
        await core.sendTelegramMessage(
          chatId,
          "↩️ <b>ROTAÇÃO RECUPERADA</b>\n\nO backend reiniciou durante a sincronização. A peça anterior foi restaurada e o candidato continua disponível para sua decisão.",
          rotationKeyboard(request.id),
        );
      }
      return;
    }

    if (sourceArchived) {
      await requireSupabase().from("products").update({ ativo: true, status: "published" }).eq("id", source.id).eq("status", "archived");
    }
    const { error } = await requireSupabase().from("product_rotation_requests").update({
      status: "failed",
      reason: `APPLY_RECOVERY_CANDIDATE_STATE:${candidate.status}:${String(candidate.ativo)}`,
      updated_at: new Date().toISOString(),
    }).eq("id", request.id).eq("status", "applying");
    if (error) throw error;
  } catch (error) {
    console.error(`[ROTATION] apply_recovery_failed request=${requestId} error=${safeError(error)}`);
  } finally {
    activeRotationApplyRecoveries.delete(requestId);
  }
}

function ensureRotationApplyRecovery(requestId: string, chatId: string | number): void {
  if (activeRotationApplyRecoveries.has(requestId)) return;
  void recoverApplyingRotation(requestId, chatId);
}

async function recoverDurableRotations(): Promise<void> {
  const requests = await listRecoverableProductRotations(50);
  for (const request of requests) {
    if (request.status !== "searching") continue;
    ensureRotationSearchWorker(request.id, request.telegramChatId);
  }

  const { data, error } = await requireSupabase()
    .from("product_rotation_requests")
    .select("id,telegram_chat_id")
    .eq("status", "applying")
    .order("updated_at", { ascending: true })
    .limit(25);
  if (error) throw error;
  for (const row of data || []) {
    ensureRotationApplyRecovery(String(row.id), String(row.telegram_chat_id));
  }
}

export function startProductRotationSupervisor(env: NodeJS.ProcessEnv = process.env): boolean {
  if (rotationSupervisorStarted) return false;
  if (env.ROTATION_SEARCH_SUPERVISOR_ENABLED !== "true") return false;
  rotationSupervisorStarted = true;
  const initial = setTimeout(() => {
    void recoverDurableRotations().catch(error => console.error(`[ROTATION] supervisor_initial_failed error=${safeError(error)}`));
  }, 1_000);
  initial.unref?.();
  rotationSupervisorTimer = setInterval(() => {
    void recoverDurableRotations().catch(error => console.error(`[ROTATION] supervisor_tick_failed error=${safeError(error)}`));
  }, ROTATION_SUPERVISOR_INTERVAL_MS);
  rotationSupervisorTimer.unref?.();
  console.info(`[ROTATION] supervisor.on intervalMs=${ROTATION_SUPERVISOR_INTERVAL_MS}`);
  return true;
}

export function stopProductRotationSupervisor(): boolean {
  if (!rotationSupervisorStarted) return false;
  if (rotationSupervisorTimer) clearInterval(rotationSupervisorTimer);
  rotationSupervisorTimer = null;
  rotationSupervisorStarted = false;
  return true;
}

async function applyRotationAndNotify(requestId: string, chatId: string | number): Promise<void> {
  try {
    const applied = await approveProductRotation(requestId);
    await core.sendTelegramMessage(
      chatId,
      "✅ <b>ROTAÇÃO CONCLUÍDA</b>\n\n" +
        `${escapeHtml(applied.source.displayTitle || applied.source.produto)}\n⬇️ substituído por\n` +
        `<b>${escapeHtml(applied.replacement.displayTitle || applied.replacement.produto)}</b>\n\n` +
        `Categoria: ${escapeHtml(applied.replacement.categoria)}\nPreço: ${money(applied.replacement.preco)}\n\n` +
        "✅ Nova peça publicada\n✅ Catálogo público sincronizado\n✅ Peça anterior arquivada como <code>ROTATED_BY_USER</code>",
      { inline_keyboard: [[{ text: "👁️ Ver nova peça", callback_data: `product_view:${applied.replacement.id}` }], [{ text: "📦 Produtos", callback_data: "products_list:0" }]] },
    );
  } catch (error) {
    await core.sendTelegramMessage(
      chatId,
      "❌ <b>ROTAÇÃO NÃO APLICADA</b>\n\n" +
        `Motivo: <code>${escapeHtml(safeError(error))}</code>\n\n` +
        "A peça anterior permanece publicada. Se o candidato ficou inválido, a busca pode continuar pela próxima opção.",
      { inline_keyboard: [[{ text: "🔁 Buscar outra opção", callback_data: `rotation_retry:${requestId}` }], [{ text: "❌ Cancelar rotação", callback_data: `rotation_cancel:${requestId}` }]] },
    );
  }
}

async function renderProductWithRotation(chatId: string | number, messageId: number, productId: string): Promise<void> {
  const product = await productsRepository.getProductByIdOrSlug(productId);
  if (!product) {
    await core.editTelegramMessageText(chatId, messageId, "⚠️ Produto não encontrado.", { inline_keyboard: [[{ text: "⬅️ Voltar", callback_data: "products_list:0" }]] });
    return;
  }
  const activePublished = product.ativo !== false && (!product.status || product.status === "approved" || product.status === "published");
  const text = `👁️ <b>DETALHES DO PRODUTO</b>\n\n` +
    `<b>Nome:</b> ${escapeHtml(product.displayTitle || product.produto)}\n` +
    `<b>REF:</b> <code>${escapeHtml(product.ref || product.id)}</code>\n` +
    `<b>Preço:</b> ${money(product.preco)}\n` +
    `<b>Categoria:</b> ${escapeHtml(product.categoria)}\n` +
    `<b>Status:</b> ${product.ativo !== false ? "🟢 Ativo" : "⏸️ Pausado"}\n` +
    `<b>Destaque:</b> ${product.destaque ? "Sim" : "Não"}\n`;
  await core.editTelegramMessageText(chatId, messageId, text, {
    inline_keyboard: [
      [{ text: "🎯 Ver Analytics", callback_data: `analytics_product:${product.id}:7d` }],
      ...(activePublished ? [[{ text: "🔄 Rotacionar peça", callback_data: `product_rotate:${product.id}` }]] : []),
      ...(activePublished ? [[{ text: "📧 Criar campanha", callback_data: `campaign_email:${product.id}` }]] : []),
      [{ text: "✏️ Editar", callback_data: `product_edit:${product.id}` }, { text: "🗄️ Arquivar", callback_data: `product_del_confirm:${product.id}` }],
      [{ text: "🔗 Abrir no Site", url: `${resolvePublicSiteUrl()}/produto/${encodeURIComponent(product.slug || product.id)}` }],
      [{ text: "⬅️ Voltar", callback_data: "products_list:0" }],
    ],
  });
}

export function isProductRotationCallback(data: string): boolean {
  return data.startsWith("product_view:")
    || data.startsWith("product_rotate:")
    || data.startsWith("rotation_approve:")
    || data.startsWith("rotation_retry:")
    || data.startsWith("rotation_cancel:");
}

export async function handleProductRotationCallback(update: any): Promise<void> {
  const cb = update?.callback_query;
  const data = String(cb?.data || "");
  if (!cb || !isProductRotationCallback(data)) return;
  if (!core.shouldProcessTelegramUpdate(update?.update_id)) return;

  const callbackId = String(cb.id || "");
  const senderId = cb.from?.id;
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  if (!core.isUserAllowed(senderId)) {
    await core.answerCallbackQuery(callbackId, "🔒 Acesso não autorizado.", true);
    return;
  }
  if (!chatId) {
    await core.answerCallbackQuery(callbackId, "Chat inválido.", true);
    return;
  }

  if (data.startsWith("product_view:")) {
    await core.answerCallbackQuery(callbackId);
    if (messageId) await renderProductWithRotation(chatId, messageId, data.slice("product_view:".length));
    return;
  }

  if (data.startsWith("product_rotate:")) {
    try {
      const request = await startProductRotation({ sourceProductId: data.slice("product_rotate:".length), requestedBy: senderId, telegramChatId: chatId });
      await core.answerCallbackQuery(callbackId, "Buscando uma opção...");
      await core.sendTelegramMessage(chatId, "🔄 <b>ROTAÇÃO INICIADA</b>\n\nA peça atual continua no site. O Cerberus vai buscar uma opção da mesma categoria para você decidir. Se não gostar, toque em <b>Buscar outra opção</b> e ele traz a próxima.", searchingKeyboard(request.id));
      ensureRotationSearchWorker(request.id, chatId);
    } catch (error) {
      await core.answerCallbackQuery(callbackId, "Não foi possível iniciar a rotação.", true);
      await core.sendTelegramMessage(chatId, `⚠️ <b>ROTAÇÃO NÃO INICIADA</b>\n\n<code>${escapeHtml(safeError(error))}</code>`);
    }
    return;
  }

  const requestId = data.split(":")[1] || "";
  if (data.startsWith("rotation_retry:")) {
    await core.answerCallbackQuery(callbackId, "Buscando outra opção...");
    if (messageId) await core.editTelegramMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });
    try {
      const current = await getProductRotationRequest(requestId);
      if (!current) throw new Error("ROTATION_NOT_RETRYABLE:missing");

      let request = current;
      let message = "🔎 <b>BUSCA DE ROTAÇÃO ATIVA</b>\n\nO Cerberus está buscando a próxima opção. A peça atual continua publicada.";
      if (current.status === "cancelled" && current.reason === "ROTATION_SUPERSEDED_V5") {
        request = await startProductRotation({
          sourceProductId: current.sourceProductId,
          requestedBy: senderId,
          telegramChatId: chatId,
        });
        message = "🔎 <b>NOVA ROTAÇÃO V5 INICIADA</b>\n\nO pedido antigo foi encerrado pela atualização V5. Uma busca nova e rápida foi criada automaticamente para a mesma peça.";
      } else {
        if (["cancelled", "replaced", "applying"].includes(current.status)) throw new Error(`ROTATION_NOT_RETRYABLE:${current.status}`);
        if (current.status === "candidate_ready" && current.candidateProductId) {
          request = await rejectRotationCandidateAndSearchAgain(requestId);
          message = "🔎 <b>OUTRA OPÇÃO SOLICITADA</b>\n\nO candidato anterior foi descartado. A peça atual continua publicada enquanto o Cerberus busca a próxima opção.";
        }
      }

      await core.sendTelegramMessage(chatId, message, searchingKeyboard(request.id));
      ensureRotationSearchWorker(request.id, chatId);
    } catch (error) {
      await core.sendTelegramMessage(chatId, `⚠️ <b>NÃO FOI POSSÍVEL BUSCAR OUTRA OPÇÃO</b>\n\n<code>${escapeHtml(safeError(error))}</code>`);
    }
    return;
  }

  if (data.startsWith("rotation_cancel:")) {
    await core.answerCallbackQuery(callbackId, "Rotação cancelada.");
    if (messageId) await core.editTelegramMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });
    try {
      await cancelProductRotation(requestId);
      await core.sendTelegramMessage(chatId, "❌ <b>ROTAÇÃO CANCELADA</b>\n\nNenhuma substituição foi feita. A peça atual permanece publicada.");
    } catch (error) {
      await core.sendTelegramMessage(chatId, `⚠️ <b>FALHA AO CANCELAR ROTAÇÃO</b>\n\n<code>${escapeHtml(safeError(error))}</code>`);
    }
    return;
  }

  await core.answerCallbackQuery(callbackId, "Conferindo e aplicando substituição...");
  if (messageId) await core.editTelegramMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });
  await core.sendTelegramMessage(chatId, "🚀 <b>APROVAÇÃO RECEBIDA</b>\n\nA identidade, disponibilidade e o link Shopee serão conferidos antes da troca. O produto antigo só sai depois da sincronização segura do catálogo.");
  void applyRotationAndNotify(requestId, chatId);
}

if (process.env.ROTATION_SEARCH_SUPERVISOR_ENABLED === "true") {
  startProductRotationSupervisor();
}

export const telegramProductRotationInternals = {
  rotationSearchFailureMessage,
  summarizeRotationDiagnostics,
  isAutomaticRotationRetry,
  automaticRotationRetryDelay,
  activeRotationSearchWorkers,
  activeRotationApplyRecoveries,
};
