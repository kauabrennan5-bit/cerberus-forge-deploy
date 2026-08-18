// ============================================================================
// Bloco N10 — Source Connector (facilitador do Discovery)
// -----------------------------------------------------------------------------
// Fluxo obrigatório:
//   N10 source connector → ConnectorRegistry → executeDiscover/N2 → candidate
//
// O N10:
//   - NORMALIZA o marketplace (qualquer dialeto → canônico UPPER do N2);
//   - EXTRAI a external_identity determinística (ou UNKNOWN);
//   - DELEGA o discovery ao N2 (única autoridade de discovery/candidate);
//   - PRESERVA candidate_id, collectionFailed, provenance e external identity;
//
// O N10 NUNCA:
//   - cria candidate diretamente (N1 é a única autoridade);
//   - cria segunda tabela de candidates ou segundo sistema de evidences;
//   - lê credenciais de afiliado, chama API de afiliados ou gera affiliate URL;
//   - escreve em products, publica ou resolve acquisition (N8).
// ============================================================================
import { executeDiscover, DiscoverInput } from "../discovery/discover";
import { normalizeMarketplace } from "./marketplaceNormalization";
import { extractExternalIdentity } from "./externalIdentity";
import { sourceConnectorRegistry } from "./connectorRegistry";
import { ConnectorResult, ConnectorErrorResult } from "./contracts";

export interface DiscoverOverrides {
  // Injeção determinística para testes (nunca usada em produção).
  readonly discoverFn?: typeof executeDiscover;
}

// Validação sanitária de entrada antes de qualquer delegação — sem criar
// bypass da validação existente do N2 (validateDiscoveryUrl/SSRF guard
// continuam sendo aplicados pelo executeDiscover).
function validateSourceConnectorInput(input: { marketplace?: unknown; source_url?: unknown }): { ok: boolean; reason?: string } {
  if (typeof input.source_url !== "string" || input.source_url.trim() === "") {
    return { ok: false, reason: "source_url_ausente" };
  }
  try {
    new URL(input.source_url);
  } catch {
    return { ok: false, reason: "source_url_invalida" };
  }
  return { ok: true };
}

/**
 * Executa o discovery de uma fonte (URL) via Source Connector N10.
 *
 * A delegação ao N2 é a única forma de registro: o N10 não cria candidates.
 * Qualquer falha de normalização, resolução de connector ou extração de
 * identidade resulta em erro governado (ConnectorErrorResult), sem inventar
 * candidate_id, sem mascarar collection_failed e sem gerar affiliate URL.
 */
export async function discoverFromSource(
  input: { marketplace: unknown; source_url: string },
  overrides?: DiscoverOverrides,
): Promise<ConnectorResult | ConnectorErrorResult> {
  const validation = validateSourceConnectorInput(input);
  if (!validation.ok) {
    return {
      ok: false,
      marketplace: null,
      source_url: typeof input.source_url === "string" ? input.source_url : "",
      external_identity: {
        status: "UNKNOWN",
        // Marketplace NULL — a normalização não concluiu; nunca inventar um
        // marketplace específico para uma entrada que falhou antes disso.
        marketplace: null,
        type: "UNKNOWN",
        rationale: validation.reason ?? "entrada inválida",
      },
      discover_result: null,
      candidate_id: null,
      collection_failed: false,
      failure_reason: validation.reason ?? "entrada inválida",
      error: validation.reason ?? "entrada inválida",
    } as ConnectorErrorResult;
  }

  const normalization = normalizeMarketplace(input.marketplace);
  const marketplace = normalization.marketplace;
  const source_url = input.source_url;

  if (!normalization.ok || !marketplace) {
    return {
      ok: false,
      marketplace: null,
      source_url,
      external_identity: {
        status: "UNKNOWN",
        // Marketplace NULL — normalização falhou (desconhecido/inválido);
        // o UNKNOWN não recebe um marketplace específico inventado.
        marketplace: null,
        type: "UNKNOWN",
        rationale: normalization.reason ?? "marketplace desconhecido",
      },
      discover_result: null,
      candidate_id: null,
      collection_failed: false,
      failure_reason: normalization.reason ?? "marketplace_desconhecido",
      error: normalization.reason ?? "marketplace_desconhecido",
    } as ConnectorErrorResult;
  }

  // O connector deve existir no registry — falha fechada se ausente.
  const connector = sourceConnectorRegistry.resolve(marketplace);
  if (!connector) {
    return {
      ok: false,
      marketplace,
      source_url,
      external_identity: {
        status: "UNKNOWN",
        marketplace,
        type: "UNKNOWN",
        rationale: "nenhum connector registrado para este marketplace",
      },
      discover_result: null,
      candidate_id: null,
      collection_failed: false,
      failure_reason: "connector_ausente",
      error: "connector_ausente",
    } as ConnectorErrorResult;
  }

  // Identidade externa determinística (ou UNKNOWN) — extraída da URL observada.
  const { identity: external_identity } = extractExternalIdentity(marketplace, source_url);

  // Delegação integral ao N2 (única autoridade de discovery/candidate).
  const discoverFn = overrides?.discoverFn ?? executeDiscover;
  const discoverInput: DiscoverInput = { marketplace, mode: "url", url: source_url };
  let discover_result = null;
  try {
    discover_result = await discoverFn(discoverInput);
  } catch (error) {
    // Falha operacional do delegate — erro governado explícito, nunca sucesso.
    return {
      ok: false,
      marketplace,
      source_url,
      external_identity,
      discover_result: null,
      candidate_id: null,
      collection_failed: false,
      failure_reason: "discovery_delegate_falhou",
      error: error instanceof Error ? error.message : "discovery_delegate_falhou",
    } as ConnectorResult;
  }

  if (!discover_result || !discover_result.ok) {
    return {
      ok: false,
      marketplace,
      source_url,
      external_identity,
      discover_result,
      candidate_id: null,
      collection_failed: false,
      failure_reason: discover_result?.error ?? "discovery_failed",
      error: discover_result?.error ?? "discovery_failed",
    } as ConnectorResult;
  }

  // Preservação: candidate_id + collectionFailed + provenance propagados.
  // Falha fechada: sem candidate_id válido criado pelo N1/N2, o resultado é
  // governado como falha — o N10 nunca reporta ok:true sem candidate_id real.
  const item = (discover_result.items ?? [])[0] as { candidate_id?: string | null; unknown_fields?: string[] } | undefined;
  const candidate_id = item?.candidate_id ?? null;
  const unknown_fields = item?.unknown_fields ?? [];
  if (!candidate_id) {
    return {
      ok: false,
      marketplace,
      source_url,
      external_identity,
      discover_result,
      candidate_id: null,
      collection_failed: unknown_fields.length > 0,
      failure_reason: unknown_fields.length > 0 ? "collection_failed" : "candidate_not_created",
      error: unknown_fields.length > 0 ? "collection_failed" : "candidate_not_created",
    } as ConnectorResult;
  }
  return {
    ok: true,
    marketplace,
    source_url,
    external_identity,
    discover_result,
    candidate_id,
    collection_failed: false,
    failure_reason: null,
    error: null,
  } as ConnectorResult;
}
