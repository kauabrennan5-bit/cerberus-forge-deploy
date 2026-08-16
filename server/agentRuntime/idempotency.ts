/**
 * Bloco 16 — Fase C — Idempotência do Agent Runtime.
 *
 * A mesma intention_key nunca deve gerar múltiplas execuções independentes:
 * 1. primeira solicitação: PLANNED (dentro da máquina);
 * 2. segunda solicitação idêntica: retorna a mesma identidade de planejamento;
 * 3. mesma intention_key + payload/contexto diferente: conflito rejeitado;
 * 4. request com execution_id incompatível: rejeitado.
 *
 * FRONTIERA DOCUMENTADA: nesta fase a persistência real do execution state
 * ainda não foi autorizada pelo design (D-8 e a migration correspondente).
 * Este módulo define a INTERFACE de store e uma implementação em memória
 * destinada APENAS a testes locais determinísticos. Produção que use esta
 * implementação perderia estado entre reinicializações — por isso a
 * interface existe para que uma implementação persistente (Supabase) seja
 * injetada em fase futura autorizada, sem alterar este módulo.
 *
 * Não é um "fallback silencioso em memória" para produção: a implementação
 * em memória é explicitamente rotulada como TEST-ONLY e o store real não é
 * instanciado em nenhum código de servidor nesta fase.
 */

import { canonicalJson } from "./execution";

/** Entrada imutável do store de idempotência. */
export interface ExecutionRecord {
  intentionKey: string;
  executionId: string;
  identityContextDigest: string;
  lifecycleState: string;
  createdAt: string;
}

/** Resultado de uma tentativa de registro idempotente. */
export interface IdempotencyOutcome {
  ok: boolean;
  record: ExecutionRecord | null;
  conflict: "NONE" | "DUPLICATE_SAME_INTENTION" | "INTENTION_CONFLICT";
}

/**
 * Interface do store de idempotência. A implementação real (Supabase) deve
 * satisfazer este contrato e será injetada em fase futura autorizada.
 */
export interface ExecutionStore {
  /**
   * Registra ou consulta um registro por intention_key. Same-intention =
   * retorna o registro existente (idempotente); contexto diferente =
   * conflito; chave nova = cria.
   */
  resolveByKey(parts: {
    intentionKey: string;
    identityContextDigest: string;
    executionId: string;
    lifecycleState: string;
    createdAt: string;
  }): Promise<IdempotencyOutcome>;
}

/** Store em memória — EXCLUSIVAMENTE para testes locais determinísticos. */
export class InMemoryExecutionStore implements ExecutionStore {
  private readonly store = new Map<string, ExecutionRecord>();

  async resolveByKey(parts: {
    intentionKey: string;
    identityContextDigest: string;
    executionId: string;
    lifecycleState: string;
    createdAt: string;
  }): Promise<IdempotencyOutcome> {
    const existing = this.store.get(parts.intentionKey);
    if (existing) {
      if (existing.identityContextDigest === parts.identityContextDigest) {
        return Object.freeze({
          ok: true,
          record: existing,
          conflict: "DUPLICATE_SAME_INTENTION",
        });
      }
      return Object.freeze({
        ok: false,
        record: null,
        conflict: "INTENTION_CONFLICT",
      });
    }
    const record: ExecutionRecord = Object.freeze({
      intentionKey: parts.intentionKey,
      executionId: parts.executionId,
      identityContextDigest: parts.identityContextDigest,
      lifecycleState: parts.lifecycleState,
      createdAt: parts.createdAt,
    });
    this.store.set(parts.intentionKey, record);
    return Object.freeze({ ok: true, record, conflict: "NONE" });
  }
}

/**
 * Fingerprint determinístico do contexto de identidade (usado para detectar
 * colisão entre intenção declarada igual e contexto relevante diferente).
 */
export function digestIdentityContext(
  identityContext: Record<string, unknown>
): string {
  return canonicalJson(identityContext);
}
