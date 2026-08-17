// ============================================================================
// Bloco N9 — Commercial Decision Gate v1 (commercial_decision_v1).
//
// O gate responde: "este ciclo pode ser encaminhado ao executor N5?"
// com um documento de decisão versionado, determinístico e explicável.
//
// REGRAS ABSOLUTAS:
//   - SEM score novo; SEM "score mágico"; o N4 (Cerberus Filter) continua a
//     única autoridade de avaliação — aqui usamos somente recommendation/
//     classification/priority já emitidas;
//   - RECOMMENDATION != ACTION: mesmo uma recommendation favorável NÃO
//     executa nada; a execução exige o executor N5 com sua própria decisão;
//   - UNKNOWN != CONFIRMED: UNKNOWN crítico bloqueia; UNKNOWN não-crítico
//     permanece explícito (unknownsCount) e NÃO é estimado;
//   - IDENTITY_UNCERTAIN != CONFIRMED: nunca converter; sempre bloquear;
//   - erro de leitura/infraestrutura NUNCA vira permissão (BLOCK_RESOLUTION_ERROR);
//   - DECISION_ALLOWED NUNCA é produzido por fallback — qualquer bloqueio
//     presente produz DECISION_BLOCKED.
// ============================================================================
import { createHash } from "node:crypto";
import {
  BlockingRule,
  CycleMarketplace,
  DECISION_VERSION,
  DecisionOutcome,
  GateDecision,
  GateInput,
  PassedRule,
} from "./cycleContract";

// Recommendation que o mercado Cerberus considera compatível com ação
// de publicação. "ADD_TO_NICHE" (N4: cerberus_filter_v1) é a única que
// habilita encaminhamento ao executor N5. As demais permanecem explícitas
// no documento como não-acioáveis (nem recusa automática: INVENTORY/
// INVESTIGATE_FURTHER/PARK indicam pendências humanas).
const ACTIONABLE_RECOMMENDATIONS: ReadonlySet<string> = new Set(["ADD_TO_NICHE"]);

function ruleNote(rule: string, message: string): string {
  return `${rule}: ${message}`;
}

/**
 * Avalia o Decision Gate v1 sobre a entrada consolidada do ciclo.
 * Determinístico: mesma entrada → mesma saída (usada também para o
 * input_digest do documento persistido).
 */
export function evaluateDecisionGate(input: GateInput): GateDecision {
  const blocking: BlockingRule[] = [];
  const passed: PassedRule[] = [];
  const notes: string[] = [];

  // 1) Infraestrutura: qualquer erro de leitura já bloqueia (fail-closed).
  //    Esta regra tem precedência: sem dados confiáveis não há decisão.
  if (input.resolutionError) {
    blocking.push("BLOCK_RESOLUTION_ERROR");
    notes.push(ruleNote("BLOCK_RESOLUTION_ERROR", input.errorReason ?? "consulta necessária falhou"));
  }

  // 2) BLOCK_NO_ACTION — recommendation não acionável ou assessment
  //    ausente/não acionável (recomendação null = sem avaliação válida).
  const recommendationActionable =
    typeof input.recommendation === "string" &&
    ACTIONABLE_RECOMMENDATIONS.has(input.recommendation);
  if (!recommendationActionable) {
    blocking.push("BLOCK_NO_ACTION");
    notes.push(
      ruleNote(
        "BLOCK_NO_ACTION",
        `recommendation=${input.recommendation ?? "null"} não permite ação (N4 continua autoridade da avaliação)`,
      ),
    );
  } else {
    passed.push("PASS_RECOMMENDATION_ACTIONABLE");
    notes.push(ruleNote("PASS_RECOMMENDATION_ACTIONABLE", `recommendation=${input.recommendation} compatível com ação`));
  }

  // 3) BLOCK_CONTRADICTION — contradições abertas relevantes.
  if (input.contradictionsCount > 0) {
    blocking.push("BLOCK_CONTRADICTION");
    notes.push(ruleNote("BLOCK_CONTRADICTION", `${input.contradictionsCount} contradição(ões) aberta(s) no N3`));
  } else {
    passed.push("PASS_CONTRADICTIONS_CLEAR");
    notes.push(ruleNote("PASS_CONTRADICTIONS_CLEAR", "sem contradições abertas"));
  }

  // 4) BLOCK_COLLECTION_FAILED — dados centrais não observáveis porque o
  //    fetch falhou (COLLECTION_FAILED registrado pelo N2).
  if (input.collectionFailed) {
    blocking.push("BLOCK_COLLECTION_FAILED");
    notes.push(ruleNote("BLOCK_COLLECTION_FAILED", "coleta falhou; dados centrais continuam não observáveis"));
  } else {
    passed.push("PASS_COLLECTION_OK");
    notes.push(ruleNote("PASS_COLLECTION_OK", "coleta sem falha aberta"));
  }

  // 5) BLOCK_UNKNOWN_CRITICAL — preço UNKNOWN ou título não confirmado.
  //    UNKNOWN NÃO-crítico (ex.: rating não observado) permanece explícito
  //    no documento e NÃO é estimado.
  if (input.unknownCriticalPrice || input.unknownCriticalTitle) {
    blocking.push("BLOCK_UNKNOWN_CRITICAL");
    const reasons: string[] = [];
    if (input.unknownCriticalPrice) reasons.push("preço UNKNOWN");
    if (input.unknownCriticalTitle) reasons.push("título não confirmado");
    notes.push(ruleNote("BLOCK_UNKNOWN_CRITICAL", reasons.join("; ")));
  } else {
    passed.push("PASS_UNKNOWN_CRITICAL_CLEAR");
    notes.push(
      ruleNote("PASS_UNKNOWN_CRITICAL_CLEAR", `campos críticos confirmados (${input.unknownsCount} unknown(s) não-crítico(s) preservados)`),
    );
  }

  // 6) BLOCK_IDENTITY_UNCERTAIN — identidade de afiliado não confirmada.
  //    Nunca converter para confirmado; quando confirmada, registrar a
  //    regra passada (ou a ausência: link não exigido/identidade não
  //    exigida neste ciclo).
  if (input.identityConfidence === "PRODUCT_IDENTITY_UNCERTAIN") {
    blocking.push("BLOCK_IDENTITY_UNCERTAIN");
    notes.push(ruleNote("BLOCK_IDENTITY_UNCERTAIN", "identidade do produto NÃO confirmada pelo N8; jamais habilita publicação"));
  } else if (input.identityConfidence === "PRODUCT_IDENTITY_CONFIRMED") {
    passed.push("PASS_IDENTITY_CONFIRMED");
    notes.push(ruleNote("PASS_IDENTITY_CONFIRMED", "identidade confirmada pelo mecanismo oficial (N8)"));
  } else {
    // Sem aquisição realizada ou identidade não exigida — não bloqueia por
    // si só; o link exigido é coberto por BLOCK_AFFILIATE_MISSING.
    notes.push(ruleNote("PASS_IDENTITY_CONFIRMED", `identityConfidence=${input.identityConfidence ?? "null"} (não bloqueante neste ciclo)`));
    passed.push("PASS_IDENTITY_CONFIRMED");
  }

  // 7) BLOCK_AFFILIATE_MISSING — política do ciclo exige link afiliado
  //    válido e a resolução retorna MISSING/NO_ELEGIBLE_LINK/RESOLUTION_ERROR.
  if (input.requireAffiliateLink) {
    if (
      input.resolutionStatus === "MISSING" ||
      input.resolutionStatus === "NO_ELEGIBLE_LINK" ||
      input.resolutionStatus === "RESOLUTION_ERROR"
    ) {
      blocking.push("BLOCK_AFFILIATE_MISSING");
      notes.push(ruleNote("BLOCK_AFFILIATE_MISSING", `resolução=${input.resolutionStatus}; política do ciclo exige link afiliado válido`));
    } else {
      passed.push("PASS_AFFILIATE_LINK_AVAILABLE");
      notes.push(ruleNote("PASS_AFFILIATE_LINK_AVAILABLE", `resolução=${input.resolutionStatus ?? "null"} satisfaz a exigência de link`));
    }
  } else {
    notes.push(ruleNote("PASS_AFFILIATE_LINK_AVAILABLE", "ciclo sem exigência de link afiliado"));
    passed.push("PASS_AFFILIATE_LINK_AVAILABLE");
  }

  // 8) BLOCK_NOT_APPROVED — candidato não está em APPROVED.
  //    O gate NUNCA altera automaticamente o status do candidato.
  if (input.candidateStatus !== "APPROVED") {
    blocking.push("BLOCK_NOT_APPROVED");
    notes.push(ruleNote("BLOCK_NOT_APPROVED", `candidate.status=${input.candidateStatus ?? "null"}; transição humana para APPROVED pendente`));
  } else {
    passed.push("PASS_CANDIDATE_APPROVED");
    notes.push(ruleNote("PASS_CANDIDATE_APPROVED", "candidate.status=APPROVED"));
  }

  if (!input.resolutionError) {
    passed.push("PASS_QUERIES_OK");
    notes.push(ruleNote("PASS_QUERIES_OK", "consultas necessárias sem erro"));
  }

  const outcome: DecisionOutcome = blocking.length === 0 ? "DECISION_ALLOWED" : "DECISION_BLOCKED";

  const rationale = buildRationale(outcome, input, blocking, notes);

  return Object.freeze({
    outcome,
    blockingRules: Object.freeze(blocking) as ReadonlyArray<BlockingRule>,
    passedRules: Object.freeze(passed) as ReadonlyArray<PassedRule>,
    rationale,
    ruleNotes: Object.freeze(notes) as ReadonlyArray<string>,
  });
}

function buildRationale(
  outcome: DecisionOutcome,
  input: GateInput,
  blocking: BlockingRule[],
  notes: string[],
): string {
  const lines: string[] = [];
  lines.push(`gate=${DECISION_VERSION}; outcome=${outcome}`);
  if (blocking.length > 0) {
    lines.push(`bloqueios ativos: ${blocking.join(", ")}`);
    lines.push(`a regra determinante foi: ${blocking[0]} (ordem de avaliação das regras nomeadas)`);
  } else {
    lines.push("nenhum bloqueio ativo; todas as regras nomeadas passaram");
  }
  lines.push(
    `evidências usadas: candidate=${input.candidateId} recommendation=${input.recommendation ?? "null"} classification=${input.classification ?? "null"} priority=${input.priority ?? "null"} unknowns=${input.unknownsCount} contradictions=${input.contradictionsCount} collectionFailed=${input.collectionFailed} identityConfidence=${input.identityConfidence ?? "null"} resolutionStatus=${input.resolutionStatus ?? "null"} candidateStatus=${input.candidateStatus ?? "null"}`,
  );
  const remainingUnknowns =
    input.unknownCriticalPrice || input.unknownCriticalTitle ? "unknowns críticos" : `${input.unknownsCount} unknown(s) não-crítico(s)`;
  lines.push(`UNKNOWN preservados (não estimados): ${remainingUnknowns}`);
  lines.push(`riscos remanescentes: avaliação do N4 (${input.priority ?? "null"}); sem score novo foi criado`);
  if (notes.length > 0) {
    lines.push(`notas de regras: ${notes.slice(0, 8).join(" | ")}`);
  }
  return lines.join("; ");
}

/**
 * Digest determinístico do input consolidado do gate (idempotência da
 * decisão: mesma entrada → mesmo digest → mesmo decision document).
 */
export function buildDecisionInputDigest(
  input: GateInput,
): string {
  const payload = JSON.stringify({
    candidateId: input.candidateId,
    candidateStatus: input.candidateStatus,
    recommendation: input.recommendation,
    classification: input.classification,
    priority: input.priority,
    unknownsCount: input.unknownsCount,
    unknownCriticalPrice: input.unknownCriticalPrice,
    unknownCriticalTitle: input.unknownCriticalTitle,
    contradictionsCount: input.contradictionsCount,
    collectionFailed: input.collectionFailed,
    identityConfidence: input.identityConfidence,
    resolutionStatus: input.resolutionStatus,
    requireAffiliateLink: input.requireAffiliateLink,
    resolutionError: input.resolutionError,
    errorReason: input.errorReason,
  });
  return digestString(payload);
}

/** SHA-256 (hex) de uma string — mesmo padrão de digest do projeto. */
export function digestString(payload: string): string {
  // Mesmo formato do N2 (evidenceDigest): "sha256:" + hex.
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

/**
 * Monta um decision_id determinístico a partir do cycle_id e do digest
 * (replay idêntico → mesmo decision_id → idempotência de persistência).
 */
export function buildDecisionId(cycleId: string, inputDigest: string): string {
  const hash = createHash("sha256").update(`${cycleId}:${inputDigest}`).digest("hex");
  return `ncd-${cycleId}-${hash.slice(0, 16)}`;
}

/** Validação simples de marketplace fechado (mesmo catálogo do N2). */
export function isCycleMarketplace(value: unknown): value is CycleMarketplace {
  return value === "mercadolivre" || value === "shopee";
}
