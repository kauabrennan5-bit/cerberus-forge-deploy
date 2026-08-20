import type { SupabaseClient } from "@supabase/supabase-js";
import {
  acquireAffiliateLink,
  type AffiliateApiSource,
} from "./acquisitionService";
import {
  getProvider,
  n17AffiliateRepository,
} from "./affiliateRepository";
import {
  createN17AuthorizationStore,
  type N17AuthorizationStore,
} from "./n17AuthorizationStore";
import type {
  N17Dependencies,
  N17AcquireRequest,
  N17AcquireResult,
} from "./n17Contract";
import { acquireN17 } from "./n17Service";

export interface N17RuntimeDeps extends N17Dependencies {
  readonly authorizationStore: N17AuthorizationStore;
}

/**
 * Composição única do runtime N17.
 *
 * A factory apenas injeta dependências. Nenhuma leitura, chamada ao provider,
 * aquisição ou persistência ocorre durante sua construção.
 */
export function createN17RuntimeDeps(
  client: SupabaseClient,
  apiSource: AffiliateApiSource | null,
  now?: () => Date,
): N17RuntimeDeps {
  const authorizationStore = createN17AuthorizationStore(client, now);

  return {
    providerStore: {
      getById: getProvider,
    },
    authorizationStore,
    repository: n17AffiliateRepository,
    acquire: (options) =>
      acquireAffiliateLink({
        ...options,
        apiSource,
      }),
    ...(now ? { now } : {}),
  };
}

let runtimeDeps: N17RuntimeDeps | null = null;

/** Injeta a composição N17 no bootstrap; não dispara nenhuma operação. */
export function setN17RuntimeDeps(next: N17RuntimeDeps | null): void {
  runtimeDeps = next;
}

/** Obtém a composição injetada para futuras rotas/operadores N17. */
export function getN17RuntimeDeps(): N17RuntimeDeps | null {
  return runtimeDeps;
}

/**
 * Entrada runtime futura para a operação N17. Mantém o orquestrador como única
 * autoridade de fluxo e falha fechado quando o bootstrap não foi configurado.
 */
export async function acquireN17Runtime(
  request: N17AcquireRequest,
): Promise<N17AcquireResult> {
  const deps = runtimeDeps;
  if (!deps) {
    return {
      status: "BLOCKED",
      affiliate_link_id: null,
      affiliate_url: null,
      short_url: null,
      provider_id: null,
      marketplace: null,
      listing_id: null,
      seller_id: null,
      title_snapshot: null,
      canonical_url: null,
      acquisition_ref: null,
      authorization_ref: request.authorization_ref ?? null,
      assessment_id: request.assessment_id ?? null,
      idempotency_key: request.idempotency_key ?? "",
      method: null,
      acquired_at: null,
      observed_at: new Date().toISOString(),
      response_digest: null,
      provenance: null,
      error_kind: "N17_RUNTIME_NOT_CONFIGURED",
      reason_sanitized: "n17_runtime_not_configured",
    };
  }
  return acquireN17(request, deps);
}
