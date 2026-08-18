// ============================================================================
// Bloco N11 — Discovery Facilitator / Mapper de resposta Telegram
// -----------------------------------------------------------------------------
// Converte DiscoveryBatchResult em texto Telegram, SEM lógica de
// apresentação dentro do Facilitator (separação de responsabilidades).
//
// Regras obrigatórias:
//   - apresentar: batch_id, status, recebidos/processados, created,
//     duplicate, conflict, unknown_identity, failed, timed_out, cancelled,
//     retried, resultado individual por índice, candidate_id quando
//     existente, identidade externa quando existente, rationale de
//     UNKNOWN quando existente, failure_reason quando houver;
//   - NÃO inventar title/price/seller;
//   - UNKNOWN permanece UNKNOWN;
//   - não expor secrets, tokens, headers ou credenciais.
// ============================================================================
import {
  DiscoveryBatchResult,
  DiscoveryItemResult,
} from "./contracts";
import type { ExternalIdentity } from "../sourceConnector/contracts";
import { isExternalIdentityKnown } from "../sourceConnector/contracts";

/**
 * Monta o texto Telegram de um batch (HTML parse mode do Bot).
 * Escape de HTML aplicado ao batch_id; identidades vêm de campos
 * determinísticos do N10 (não há texto livre de usuário aqui).
 */
export function mapBatchResultToTelegramMessage(
  result: DiscoveryBatchResult,
): string {
  const lines: string[] = [];
  const m = result.metrics;
  const title =
    result.status === "success"
      ? "DESCOBERTA EM LOTE CONCLUÍDA"
      : result.status === "partial"
        ? "DESCOBERTA EM LOTE PARCIAL"
        : result.status === "cancelled"
          ? "DESCOBERTA EM LOTE CANCELADA"
          : "DESCOBERTA EM LOTE FALHOU";
  lines.push(`📦 <b>${title}</b> (batch ${escapeHtml(result.batch_id)})`);
  lines.push("━━━━━━━━━━━━━━━━━━");
  lines.push(`Status: ${result.status}`);
  lines.push(`Recebidos: ${m.received} · Processados: ${m.processed}`);
  lines.push(`🆕 created: ${m.created}`);
  lines.push(`🔁 duplicate: ${m.duplicates}`);
  lines.push(`⚔️ conflict: ${m.conflicts}`);
  lines.push(`❓ unknown_identity: ${m.unknown_identity}`);
  lines.push(`❌ failed: ${m.failed}`);
  lines.push(`⏱️ timed_out: ${m.timed_out}`);
  lines.push(`🛑 cancelled: ${m.cancelled}`);
  lines.push(`🔁 retried: ${m.retried}`);
  if (result.proof_run_id) {
    lines.push(`🔖 proof_run_id: ${escapeHtml(result.proof_run_id)}`);
  }
  lines.push("━━━━━━━━━━━━━━━━━━");
  lines.push("Por índice:");
  for (const item of result.items) {
    lines.push(renderItemLine(item));
  }
  lines.push("━━━━━━━━━━━━━━━━━━");
  lines.push("📏 CANDIDATE != FACT CANÔNICO — candidatos registrados permanecem no funil N1; nenhum produto canônico foi criado ou alterado.");
  return lines.join("\n");
}

function renderItemLine(item: DiscoveryItemResult): string {
  const parts: string[] = [];
  const emoji =
    item.status === "created"
      ? "✅"
      : item.status === "duplicate"
        ? "🔁"
        : item.status === "conflict"
          ? "⚔️"
          : item.status === "unknown_identity"
            ? "❓"
            : "❌";
  parts.push(`${emoji} [${item.index}] status=${item.status}`);
  if (item.candidate_id) {
    parts.push(`candidate=${escapeHtml(item.candidate_id)}`);
  }
  const eid = item.external_identity;
  if (eid) {
    if (isExternalIdentityKnown(eid)) {
      if (eid.status === "ITEM_ID") {
        parts.push(`🆔 ITEM_ID=${escapeHtml(eid.value)} (${eid.marketplace})`);
      } else if (eid.status === "SHOP_ITEM") {
        parts.push(`🆔 SHOP_ITEM shop=${eid.shop_id} item=${eid.item_id} (${eid.marketplace})`);
      }
    } else if (eid.status === "UNKNOWN") {
      parts.push(`🆔 Identidade: UNKNOWN (${escapeHtml(eid.rationale)})`);
    }
  }
  if (item.failure_reason) {
    parts.push(`⚠️ failure_reason=${escapeHtml(item.failure_reason)}`);
  }
  if (item.attempts > 1) {
    parts.push(`tentativas=${item.attempts}`);
  }
  return parts.join(" · ");
}

/**
 * Escape HTML mínimo para valores determinísticos internos (batch_id,
 * candidate_id, failure_reason). URLs de source NÃO são expostas —
 * a exibição permanece neutra e sem texto livre do usuário.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Extrai candidate_ids existentes do resultado (para auditoria/cleanup
 * seletivo em provas controladas). Não modifica nada.
 */
export function collectCandidateIds(
  result: DiscoveryBatchResult,
): ReadonlyArray<string> {
  return result.items
    .map(item => item.candidate_id)
    .filter((id): id is string => id !== null);
}
