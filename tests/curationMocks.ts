// ============================================================================
// Bloco N13 — Mock do cliente Supabase para testes de curadoria.
//
// Proxy minimalista que satisfaz as cadeias usadas pelos repositórios:
//   client.from(T).select(C).eq(K,V)[.eq(...)].limit(N).order(...).maybeSingle()
//   client.from(T).insert(R).select().single()
//   client.from(T).select("*").eq(...).order(...).limit(1).maybeSingle()
//   await client.from(T).select(...)   (listEvidence — trata a base como Promise)
// Sem dependências reais do Supabase — objeto Proxy puro.
// ============================================================================

export interface MockPersistBehavior {
  /** Quantas inserts da tabela candidate_assessment criam com sucesso (depois, duplica). */
  succeedInserts?: number;
  /** Linha devolvida no replay (identical_duplicate). */
  replayRow?: Record<string, unknown>;
}

export interface MockReadBehavior {
  /** Resposta de getCandidate (tabela candidates). */
  candidate?: { ok: boolean; candidate?: Record<string, unknown> };
  /** Evidências devolvidas por listCandidateEvidence. */
  evidence?: unknown[];
  /** Evidências indisponíveis → leitura falha ({ ok: false }). */
  evidenceUnavailable?: boolean;
  /** Candidato não encontrado. */
  candidateNotFound?: boolean;
}

export interface CurationMockOptions {
  reads?: MockReadBehavior;
  persist?: MockPersistBehavior;
}

const DUPLICATE_ERROR = {
  code: "23505",
  message: "duplicate key value violates unique constraint",
  details: "",
  hint: "",
} as const;

/**
 * Monta um objeto chainável que responde a eq/order/limit/range/select,
 * é "await-ável" (resolve { data, error }) e tem terminadores single/
 * maybeSingle.
 */
function makeReadChain(data: unknown): unknown {
  // Filtro de igualdade do próprio mock: se o dado for um único objeto
  // (linha de candidates/candidate_evidence), eq() só devolve a linha quando o
  // valor da coluna coincide — comportamento real do PostgREST. Isso evita
  // que IDs malformados "vazem" como candidatos encontrados.
  const row =
    Array.isArray(data) || data === null || data === undefined
      ? data
      : typeof data === "object"
        ? data
        : data;
  let matched: unknown = row;
  const chain: Record<string, unknown> = {
    eq(key: string, value: unknown): unknown {
      if (matched !== null && matched !== undefined && typeof matched === "object" && !Array.isArray(matched)) {
        const rec = matched as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(rec, key) && rec[key] !== value) {
          matched = null;
        }
      } else if (Array.isArray(matched)) {
        matched = matched.filter(
          (item) => typeof item === "object" && item !== null && (item as Record<string, unknown>)[key] === value,
        );
      }
      return chain;
    },
    order() {
      return chain;
    },
    limit() {
      return chain;
    },
    range() {
      return chain;
    },
    select() {
      return chain;
    },
    single() {
      return Promise.resolve({ data: Array.isArray(matched) ? matched[0] : matched, error: null });
    },
    maybeSingle() {
      return Promise.resolve({ data: Array.isArray(matched) ? matched[0] : matched, error: null });
    },
    then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
      // Await sem maybeSingle/single trata o resultado como lista:
      // linha única vira lista de 0-1 itens; arrays permanecem arrays.
      const list = Array.isArray(matched) ? matched : matched === null || matched === undefined ? [] : [matched];
      return Promise.resolve({ data: list, error: null }).then(resolve, reject);
    },
    catch(rej: (e: unknown) => void) {
      const list = Array.isArray(matched) ? matched : matched === null || matched === undefined ? [] : [matched];
      return Promise.resolve({ data: list, error: null }).catch(rej);
    },
  };
  return chain;
}

/**
 * Cadeia que falha na leitura (simula erro do PostgREST).
 */
function makeFailChain(reason: string): unknown {
  const chain: Record<string, unknown> = {
    eq() {
      return chain;
    },
    order() {
      return chain;
    },
    limit() {
      return chain;
    },
    range() {
      return chain;
    },
    select() {
      return chain;
    },
    single() {
      return Promise.resolve({ data: null, error: { message: reason } });
    },
    maybeSingle() {
      return Promise.resolve({ data: null, error: { message: reason } });
    },
    then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
      return Promise.resolve({ data: null, error: { message: reason } }).then(resolve, reject);
    },
    catch(rej: (e: unknown) => void) {
      return Promise.resolve().catch(rej);
    },
  };
  return chain;
}

/**
 * Cadeia de insert(): ...select().single() — primeiro succeedInserts
 * chamadas criam; depois simula unique constraint (23505), que faz o
 * repositório chamar resolveReplay (select.eq.order.limit.maybeSingle).
 */
function makeInsertChain(
  options: { succeedInserts: number; replayRow?: Record<string, unknown> },
  tracker: { count: number },
): unknown {
  const fromTable = {
    insert(): unknown {
      tracker.count += 1;
      const ok = tracker.count <= options.succeedInserts;
      const insertChain: Record<string, unknown> = {
        select() {
          return insertChain;
        },
        eq() {
          return insertChain;
        },
        order() {
          return insertChain;
        },
        limit() {
          return insertChain;
        },
        single() {
          if (ok) {
            return Promise.resolve({ data: { assessment_id: "cur-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }, error: null });
          }
          return Promise.resolve({ data: null, error: DUPLICATE_ERROR });
        },
        maybeSingle() {
          // resolveReplay: busca o registro pelo idempotency_key.
          return Promise.resolve({ data: options.replayRow ?? { assessment_id: "cur-replay" }, error: null });
        },
      };
      return insertChain;
    },
    eq() {
      return fromTable;
    },
    order() {
      return fromTable;
    },
    limit() {
      return fromTable;
    },
    select() {
      return fromTable;
    },
    maybeSingle() {
      // resolveReplay: busca o registro pelo idempotency_key.
      return Promise.resolve({ data: options.replayRow ?? { assessment_id: "cur-replay" }, error: null });
    },
    single() {
      // insert().select().single() já passa por insertChain.single; esta rota
      // só atende o resolveReplay via maybeSingle acima.
      return Promise.resolve({ data: options.replayRow ?? { assessment_id: "cur-replay" }, error: null });
    },
  };
  return fromTable;
}

export type MockSupabaseClientHandle = {
  client: { from: (table: string) => unknown };
  insertCalls(): number;
};

/**
 * Client proxy configurável por teste.
 */
export function makeMockSupabaseClient(options: CurationMockOptions = {}): MockSupabaseClientHandle {
  const reads = options.reads ?? {};
  const persist = options.persist ?? {};
  const insertCallsTracker = { count: 0 };
  const succeedInserts = persist.succeedInserts ?? 1;

  const fromTable = (table: string): unknown => {
    if (table === "candidates") {
      if (reads.candidateNotFound) return makeReadChain(null);
      return makeReadChain(reads.candidate?.candidate ?? null);
    }
    if (table === "candidate_evidence") {
      if (reads.evidenceUnavailable) return makeFailChain("generic_error");
      return makeReadChain(reads.evidence ?? []);
    }
    if (table === "candidate_assessment") {
      return makeInsertChain({ succeedInserts, replayRow: persist.replayRow }, insertCallsTracker);
    }
    return makeReadChain(null);
  };

  const proxy = new Proxy(
    {} as { from(table: string): unknown },
    {
      get(_target: unknown, prop: string | symbol): unknown {
        if (prop === "from") return fromTable;
        return undefined;
      },
    },
  );

  return {
    client: proxy,
    get insertCalls() {
      return insertCallsTracker.count;
    },
  } as unknown as MockSupabaseClientHandle;
}
