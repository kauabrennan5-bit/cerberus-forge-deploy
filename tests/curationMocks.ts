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
  /** Lista de assessments devolvida por listCandidateAssessments (usado
   *  pelo gate N13 do N14). */
  listAssessments?: unknown[];
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
  insertedRowSink?: { data: Record<string, unknown> | null },
): unknown {
  // Linha registrada pela 1ª inserção bem-sucedida (auto-replay):
  // resolveReplay (select.eq.order.limit.maybeSingle no mesmo client)
  // deve encontrar o registro já inserido.
  const insertedRow: { data: Record<string, unknown> | null; input?: Record<string, unknown> } = { data: null };
  const fromTable = {
    insert(inputRow?: Record<string, unknown>): unknown {
      // Captura a linha enviada ao insert() para que o auto-replay
      // (resolveReplay via eq.idempotency_key) encontre campos completos.
      if (inputRow && typeof inputRow === "object") {
        insertedRow.input = inputRow;
      }
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
            // Linha completa persistida: dados do input + id oficial.
            const base = insertedRow.input ?? {};
            const row = {
              ...base,
              assessment_id: base.assessment_id ?? "cur-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
              schema_version: base.schema_version ?? "1.0",
              created_at: base.created_at ?? "2026-08-19T00:00:00Z",
            };
            if (options.replayRow) Object.assign(row, options.replayRow);
            insertedRow.data = row;
            if (insertedRowSink) insertedRowSink.data = row;
            return Promise.resolve({ data: row, error: null });
          }
          return Promise.resolve({ data: null, error: DUPLICATE_ERROR });
        },
        maybeSingle() {
          // resolveReplay: busca o registro pelo idempotency_key.
          return Promise.resolve({ data: insertedRow.data ?? options.replayRow ?? null, error: null });
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

/**
 * Cadeia híbrida para candidate_assessment (usada pelo gate N13 + persist
 * do N14 no MESMO client): listCandidateAssessments usa
 * select().order().limit() (await), persistAssessment usa
 * insert().select().single(). O modo é decidido pelo primeiro método
 * chamado — insert → cadeia de persist; select sem insert antes → read.
 */
function makeHybridCandidateAssessmentChain(options: {
  succeedInserts: number;
  replayRow?: Record<string, unknown>;
  listData?: unknown[];
  insertCallsTracker: { count: number };
  insertedRowSink?: Record<string, { data: Record<string, unknown> | null }>;
}): unknown {
  const state: { mode: "read" | "insert" | null } = { mode: null };
  // Última coluna/valor de eq() da cadeia — usada para reconhecer a query
  // de replay do resolveReplay (eq('idempotency_key', key)).
  const lastEq: { column: string | null; value: unknown } = { column: null, value: null };
  // Linha inserida pela 1ª chamada bem-sucedida (auto-replay idempotência):
  // a referência vem do store compartilhado do client (insertedRows),
  // persistindo entre chamadas from().
  const sharedInsertedRow: { data: Record<string, unknown> | null } =
    options.insertedRowSink?.candidate_assessment ?? { data: null };
  const readChain = makeReadChain(options.listData ?? null);
  const insertChain = makeInsertChain(
    { succeedInserts: options.succeedInserts, replayRow: options.replayRow },
    options.insertCallsTracker,
    sharedInsertedRow,
  );
  const insertObj = insertChain as Record<string, (...args: unknown[]) => unknown>;
  const readObj = readChain as Record<string, (...args: unknown[]) => unknown>;
  // O insertObj não conhece sharedInsertedRow (closure própria); sobrescrever
  // o maybeSingle do hybrid para resolver replay pela linha inserida.
  const hybridMaybeSingle = (): unknown => {
    if (sharedInsertedRow.data !== null) {
      return Promise.resolve({ data: sharedInsertedRow.data, error: null });
    }
    return readObj.maybeSingle();
  };
  const chain: Record<string, unknown> = {
    insert(): unknown {
      state.mode = "insert";
      return insertObj.insert();
    },
    eq(column?: string | null, value?: unknown): unknown {
      if (typeof column === "string") lastEq.column = column;
      if (value !== undefined) lastEq.value = value;
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
      if (state.mode === null) state.mode = "read";
      return chain;
    },
    single() {
      if (state.mode === "insert") return insertObj.single();
      // Replay: busca pontual pelo idempotency_key sem insert prévio
      // (resolveReplay de outra avaliação no mesmo client).
      if (lastEq.column === "idempotency_key" && sharedInsertedRow.data !== null) {
        return Promise.resolve({ data: sharedInsertedRow.data, error: null });
      }
      return readObj.single();
    },
    maybeSingle() {
      if (state.mode === "insert") return insertObj.maybeSingle();
      return hybridMaybeSingle();
    },
    then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
      return state.mode === "insert" ? insertObj.then(resolve, reject) : readObj.then(resolve, reject);
    },
    catch(rej: (e: unknown) => void) {
      return state.mode === "insert" ? insertObj.catch(rej) : readObj.catch(rej);
    },
  };
  return chain;
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
  // Store compartilhado por tabela: linhas inseridas por QUALQUER cadeia
  // persistem entre chamadas from() (idempotência do resolveReplay).
  const insertedRows: Record<string, { data: Record<string, unknown> | null }> = {
    candidate_assessment: { data: null },
  };

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
      return makeHybridCandidateAssessmentChain({
        succeedInserts,
        replayRow: persist.replayRow,
        listData: reads.listAssessments,
        insertCallsTracker,
        insertedRowSink: insertedRows,
      });
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
    insertCalls: () => insertCallsTracker.count,
  } as unknown as MockSupabaseClientHandle;
}
