// ============================================================================
// Bloco N2 — Comandos controlados de descoberta no Telegram.
// Sintaxe autorizada (fail-closed — qualquer argumento inválido é recusado):
//   /discover                        → render-only do funil N1 (inalterado)
//   /discover ML url <url>           → descoberta por URL (Mercado Livre)
//   /discover SH search <termo>      → busca limitada (Shopee)
// O comando NÃO aceita argumentos arbitrários: marketplace desconhecido,
// modo desconhecido, URL fora da whitelist ou ausência de argumentos após
// o modo resultam em mensagem de erro controlada (nunca execução parcial).
// ============================================================================

import { isMarketplaceSource, MarketplaceSource, DISCOVERY_LIMITS } from "../commercial/discovery/types";
import { validateDiscoveryUrl } from "../commercial/discovery/evidence";
import { executeDiscover } from "../commercial/discovery/discover";
// Integração N10 — Source Connector runtime. O /discover (modo url) utiliza o
// discoverFromSource do N10, que: normaliza dialetos de marketplace, extrai a
// identidade externa determinística (ITEM_ID/SHOP_ITEM/UNKNOWN+rationale)
// e DELEGA a execução de rede ao executeDiscover/N2 (SSRF guards intactos).
// O N1 continua sendo a única autoridade de candidates (idempotência).
import { discoverFromSource } from "../commercial/sourceConnector/sourceConnector";
import type { ExternalIdentity } from "../commercial/sourceConnector/contracts";
import { isExternalIdentityKnown } from "../commercial/sourceConnector/contracts";

const MP_ALIASES: Record<string, MarketplaceSource> = {
  ML: "MERCADOLIVRE",
  MERCADOLIVRE: "MERCADOLIVRE",
  SH: "SHOPEE",
  SHOPEE: "SHOPEE",
};

export interface ParsedDiscoverCommand {
  kind: "render" | "execute";
  error?: string;
  marketplace?: MarketplaceSource;
  mode?: "url" | "search";
  url?: string;
  query?: string;
}

export function parseDiscoverCommand(argsRaw: string): ParsedDiscoverCommand {
  const parts = argsRaw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { kind: "render" };
  }
  const mpRaw = parts[0].toUpperCase();
  const marketplace = MP_ALIASES[mpRaw];
  if (!marketplace || !isMarketplaceSource(marketplace)) {
    return { kind: "execute", error: `marketplace_desconhecido: use ML ou SH` };
  }
  const modeRaw = (parts[1] ?? "").toLowerCase();
  if (modeRaw !== "url" && modeRaw !== "search") {
    return { kind: "execute", error: `modo_desconhecido: use "url" ou "search"` };
  }
  const value = parts.slice(2).join(" ").trim();
  if (!value) {
    return { kind: "execute", error: `valor_ausente: informe a URL ou o termo de busca` };
  }
  if (modeRaw === "url") {
    const validation = validateDiscoveryUrl(value, marketplace);
    if (!validation.ok) {
      return { kind: "execute", error: `url_recusada (${validation.reason})` };
    }
    return { kind: "execute", marketplace, mode: "url", url: validation.url };
  }
  if (value.length > 120) {
    return { kind: "execute", error: `termo_excede_120_caracteres` };
  }
  return { kind: "execute", marketplace, mode: "search", query: value };
}

export async function runDiscoverCommand(argsRaw: string): Promise<string> {
  const parsed = parseDiscoverCommand(argsRaw);
  if (parsed.kind === "render") {
    // Comportamento N1 original (render-only do funil).
    const { renderDiscover } = await import("./commercialCockpit");
    return await renderDiscover();
  }
  if (parsed.error) {
    return (
      "⚠️ <b>DESCOBERTA RECUSADA</b>\n" +
      `Motivo: ${parsed.error}\n` +
      "━━━━━━━━━━━━━━━━━━\n" +
      "✅ Sintaxe autorizada:\n" +
      "   /discover ML url &lt;url&gt;\n" +
      "   /discover SH search &lt;termo&gt;\n" +
      "━━━━━━━━━━━━━━━━━━\n" +
      "Regra: CANDIDATE != FACT CANÔNICO. Nenhum candidato registrado é produto publicado."
    );
  }

  const lines: string[] = [];
  const mpLabel = parsed.marketplace === "MERCADOLIVRE" ? "Mercado Livre" : "Shopee";
  lines.push(`🔭 <b>DESCOBERTA CONTROLADA (${mpLabel})</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━");
  lines.push(`Modo: ${parsed.mode === "url" ? "URL" : "busca"}`);

  let result;
  if (parsed.mode === "url" && parsed.url) {
    // Integração N10: o Source Connector é a porta de entrada do discovery
    // por URL — identidade determinística + delegação ao N2. Não há
    // re-implementação de guards SSRF aqui (executeDiscover continua
    // aplicando a whitelist MARKETPLACE_HOSTS do N2).
    const delegate = await discoverFromSource({
      marketplace: parsed.marketplace!,
      source_url: parsed.url,
    });
    if (!delegate.ok) {
      // Falha governada do N10 (dialeto inválido, connector ausente,
      // delegação rejeitada pelo N2...): propagar sem inventar contagens.
      const dr = delegate.discover_result;
      const hasResult = dr && dr.ok && dr.items.length > 0;
      lines.push(`❌ Não foi possível concluir a descoberta.`);
      lines.push(`Motivo: ${delegate.failure_reason ?? delegate.error ?? "indisponível"}`);
      const eid: ExternalIdentity = delegate.external_identity;
      if (eid.status === "UNKNOWN") {
        lines.push(`🆔 Identidade: UNKNOWN (${eid.rationale})`);
      }
      if (hasResult && dr!.items.length > 0) {
        const it = dr!.items[0];
        lines.push(`   candidate: ${it.candidate_id ?? "—"} (${it.marketplace})`);
        if (it.unknown_fields.length > 0) {
          lines.push(`   ⚠️ UNKNOWN: ${it.unknown_fields.join(", ")}`);
        }
      }
      lines.push("━━━━━━━━━━━━━━━━━━");
      lines.push("CANDIDATE != FACT CANÔNICO — nenhum dado canônico foi alterado.");
      return lines.join("\n");
    }
    const dr = delegate.discover_result!;
    result = dr.ok ? dr : result;
    if (!result) {
      result = {
        ok: false,
        marketplace: delegate.marketplace,
        mode: "url",
        found: 0,
        created: 0,
        duplicates: 0,
        conflicts: 0,
        items: [],
        error: delegate.error ?? "discovery_failed",
      };
    }
    // Anexa a external_identity do N10 ao item retornado (proveniência da
    // identidade; o N1 continua controlando candidate/listing_key/idempotência).
    const eid: ExternalIdentity = delegate.external_identity;
    const enriched = {
      ...dr.items[0],
      external_identity: eid,
      identity_source: eid.status === "UNKNOWN" ? "UNKNOWN" : eid.source,
    };
    result.items = [enriched];
    result.error = undefined;
    // Idempotência (prova N10-RT-11): quando o delegate delegou e o N1
    // registrou duplicate/conflict, refletir nas contagens originais do dr.
  } else {
    result = await executeDiscover({
      marketplace: parsed.marketplace!,
      mode: parsed.mode!,
      url: parsed.url,
      query: parsed.query,
      limit: Math.min(5, DISCOVERY_LIMITS.MAX_RESULTS),
    });
  }

  if (!result.ok) {
    lines.push(`❌ Não foi possível concluir a descoberta.`);
    lines.push(`Motivo: ${result.error ?? "indisponível"}`);
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("CANDIDATE != FACT CANÔNICO — nenhum dado canônico foi alterado.");
    return lines.join("\n");
  }

  lines.push(`📦 Anúncios lidos: ${result.found}`);
  lines.push(`🆕 Registrados no funil N1: ${result.created}`);
  lines.push(`🔁 Duplicados idempotentes: ${result.duplicates}`);
  lines.push(`⚔️ Colisões rejeitadas: ${result.conflicts}`);

  for (const item of result.items) {
    const statusEmoji = item.outcome === "created" ? "✅" : item.outcome === "identical_duplicate" ? "🔁" : "⚔️";
    lines.push(`${statusEmoji} <b>${item.title ?? item.candidate_id ?? "sem título"}</b> (${item.marketplace})`);
    // Identidade externa N10: ITEM_ID/SHOP_ITEM confirmados ou UNKNOWN+rationale.
    const eid = (item as { external_identity?: ExternalIdentity }).external_identity;
    if (eid) {
      if (eid.status === "ITEM_ID") {
        lines.push(`   🆔 Identidade: ITEM_ID = ${eid.value} (${eid.source})`);
      } else if (eid.status === "SHOP_ITEM") {
        lines.push(`   🆔 Identidade: SHOP_ITEM shop=${eid.shop_id} item=${eid.item_id} (${eid.source})`);
      } else {
        lines.push(`   🆔 Identidade: UNKNOWN (${eid.rationale})`);
      }
    }
    if (item.unknown_fields.length > 0) {
      lines.push(`   ⚠️ UNKNOWN: ${item.unknown_fields.join(", ")}`);
    }
  }

  lines.push("━━━━━━━━━━━━━━━━━━");
  lines.push("📏 Regra: CANDIDATE != FACT CANÔNICO — candidatos registrados permanecem no funil N1; nenhum produto canônico foi criado ou alterado.");
  return lines.join("\n");
}
