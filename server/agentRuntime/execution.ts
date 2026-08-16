/**
 * Bloco 16 — Fase C — Identificadores determinísticos e artefatos de execução.
 *
 * EXECUTION PLAN != EXECUTION · ALLOW != EXECUTED · POLICY != EXECUTION.
 *
 * Este módulo produz apenas DADOS: execution_id determinístico/seguro e input
 * fingerprint (nunca o input bruto). Nenhuma execução, nenhuma ferramenta,
 * nenhuma persistência, nenhum efeito externo.
 *
 * - execution_id: deriva de intention_key (que já cobre agente+versão+request+
 *   avaliação) e do fingerprint canônico do contexto relevante. Mesmo intention
 *   + mesmo contexto relevante = mesma identidade de execução. Timestamp NÃO é
 *   usado como único mecanismo de identidade.
 * - input_fingerprint: digest do conteúdo relevante do input (por referência
 *   determinística, sem o payload bruto externo).
 */

/** Versão do schema do artefato de execução (muda quando o schema mudar). */
export const AGENT_RUNTIME_EXECUTION_SCHEMA_VERSION = "1.0";

/**
 * Canonical JSON estável (mesma ordem de chaves sempre). Reimplementação
 * mínima e local para evitar importar o módulo do Decision Journal (que
 * carrega o cliente Supabase em runtime — o contrato de fase C proíbe essa
 * dependência). A lógica é idêntica ao canonicalJson do Bloco 15.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  );
  return `{${entries
    .map(([key, val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`)
    .join(",")}}`;
}

/**
 * Digest determinístico em base36 (FNV-1a-like sobre o payload canônico).
 * Determinística (mesma entrada = mesma saída em qualquer máquina), não
 * criptográfica — adequada para identidade de execução, nunca para segurança
 * de segredos. O espaço é 36^~12, com prefixo estável para legibilidade.
 */
function digest36(payload: string): string {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  // Segunda rodada para espalhar melhor colisão em inputs curtos.
  let hash2 = 0;
  for (let i = 0; i < payload.length; i += 1) {
    hash2 = (hash2 << 5) - hash2 + payload.charCodeAt(i);
    hash2 |= 0;
  }
  return Math.abs(hash).toString(36) + Math.abs(hash2).toString(36);
}

export interface ExecutionIdentityParts {
  /** Chave de intenção determinística (já valida agente/versão/avaliação). */
  intentionKey: string;
  /** Conteúdo relevante do input para identidade (referência canônica). */
  identityContext: Record<string, unknown>;
}

/**
 * execution_id determinístico/seguro. Mesma intenção + mesmo contexto
 * relevante = mesma identidade. Alteração relevante no contexto = nova
 * identidade. Timestamp deliberadamente fora da derivação.
 */
export function generateExecutionId(parts: ExecutionIdentityParts): string {
  const payload = canonicalJson({
    intentionKey: parts.intentionKey,
    identityContext: parts.identityContext,
    schemaVersion: AGENT_RUNTIME_EXECUTION_SCHEMA_VERSION,
  });
  return `exec-${digest36(payload)}-${payload.length.toString(36)}`;
}

/**
 * input_fingerprint: digest do conteúdo relevante do input. O inputReference
 * declarado no request (que já é uma referência, nunca o payload bruto
 * externo) participa do fingerprint.
 */
export function deriveInputFingerprint(
  inputReference: string,
  identityContext: Record<string, unknown>
): string {
  const payload = canonicalJson({ inputReference, identityContext });
  return `fp-${digest36(payload)}`;
}
