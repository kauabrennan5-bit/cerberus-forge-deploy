// ============================================================================
// Bloco N11 — Discovery Facilitator / Porta Telegram "/discover-batch"
// -----------------------------------------------------------------------------
// Menor porta controlada para executar um DiscoveryBatch via Telegram.
//
// Formato mínimo (fail-closed — qualquer argumento inválido é recusado):
//   /discover-batch <url1> [url2] ... [url20]
//
// Regras:
//   - somente URLs;
//   - máximo FACILITATOR_LIMITS.MAX_BATCH_ITEMS;
//   - sem search, sem keywords, sem categorias, sem descoberta aberta;
//   - sem scraping arbitrário;
//   - NÃO altera o /discover unitário (semanticamente idêntico).
//
// O comando não cria candidates diretamente, não faz fetch e não valida
// SSRF por conta própria — toda a autoridade permanece no Facilitator,
// N10 e N2. URLs são validadas pela whitelist do N2
// (validateDiscoveryUrl) antes de entrar no lote.
// ============================================================================
import { validateDiscoveryUrl } from "../discovery/evidence";
import { runDiscoveryBatch } from "./runDiscoveryBatch";
import {
  mapBatchResultToTelegramMessage,
  collectCandidateIds,
} from "./telegramBatchResponse";
import { FACILITATOR_LIMITS } from "./contracts";
import type { DiscoveryItem } from "./contracts";

/**
 * Resultado do parsing do /discover-batch.
 * kind "rejected": comando recusado sem executar nada (fail-closed).
 * kind "execute": request pronto para o Facilitator.
 */
export interface ParsedDiscoverBatchCommand {
  readonly kind: "rejected" | "execute";
  readonly reason?: string;
  readonly request?: {
    readonly batch: { readonly items: ReadonlyArray<DiscoveryItem> };
  };
}

/**
 * Parser testável do /discover-batch (sem executar).
 */
export function parseDiscoverBatchCommand(argsRaw: string): ParsedDiscoverBatchCommand {
  const raw = argsRaw.trim();
  if (!raw) {
    return {
      kind: "rejected",
      reason: "urls_ausentes: informe de 1 a 20 URLs",
    };
  }
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length > FACILITATOR_LIMITS.MAX_BATCH_ITEMS) {
    return {
      kind: "rejected",
      reason: `lote_excede_${FACILITATOR_LIMITS.MAX_BATCH_ITEMS}_urls`,
    };
  }
  // Dialeto explícito por URL? Não — a validação usa whitelist genérica do
  // N2 (validateDiscoveryUrl exige marketplace). Para manter a porta
  // mínima e determinística, aceita-se "ML" ou "SH" como primeiro token
  // opcional; ausente → rejeição explícita (sem inferência).
  let first = parts[0].toUpperCase();
  let urls: ReadonlyArray<string>;
  if (first === "ML" || first === "SH") {
    urls = parts.slice(1);
    if (urls.length === 0) {
      return { kind: "rejected", reason: "urls_ausentes: informe de 1 a 20 URLs" };
    }
  } else {
    return {
      kind: "rejected",
      reason: "dialeto_ausente: use \"ML\" ou \"SH\" antes das URLs (ex.: /discover-batch ML url1 url2)",
    };
  }
  // Rejeição explícita de qualquer tentativa de search/keywords/category.
  for (const token of parts.slice(1)) {
    if (/^search|keyword|category|termo|busca$/i.test(token)) {
      return { kind: "rejected", reason: "search/keywords/categorias fora do escopo do batch" };
    }
  }
  const marketplace = first === "ML" ? "MERCADOLIVRE" : "SHOPEE";
  const items: DiscoveryItem[] = [];
  for (const token of urls) {
    const validation = validateDiscoveryUrl(token, marketplace);
    if (!validation.ok) {
      return { kind: "rejected", reason: `url_recusada (${validation.reason})` };
    }
    items.push({ marketplace, source_url: validation.url });
  }
  return {
    kind: "execute",
    request: { batch: { items } },
  };
}

/**
 * Executa o /discover-batch e retorna o texto Telegram da resposta.
 */
export async function runDiscoverBatchCommand(argsRaw: string): Promise<string> {
  const parsed = parseDiscoverBatchCommand(argsRaw);
  if (parsed.kind === "rejected") {
    return (
      "⚠️ <b>DESCOBERTA EM LOTE RECUSADA</b>\n" +
      "━━━━━━━━━━━━━━━━━━\n" +
      `Motivo: ${parsed.reason}\n` +
      "━━━━━━━━━━━━━━━━━━\n" +
      "✅ Sintaxe autorizada:\n" +
      "   /discover-batch ML <url1> [url2] ...\n" +
      "   /discover-batch SH <url1> [url2] ...\n" +
      "━━━━━━━━━━━━━━━━━━\n" +
      "Regra: CANDIDATE != FACT CANÔNICO. Nenhum candidato registrado é produto publicado."
    );
  }
  const result = await runDiscoveryBatch({ batch: parsed.request!.batch });
  const lines: string[] = [mapBatchResultToTelegramMessage(result)];
  const ids = collectCandidateIds(result);
  if (ids.length > 0) {
    lines.push(`📋 candidate_ids da prova: ${ids.join(", ")}`);
  }
  return lines.join("\n");
}
