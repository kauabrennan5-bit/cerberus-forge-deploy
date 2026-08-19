// ============================================================================
// Bloco N13 — Motor de curadoria Cerberus (FUNÇÃO PURA, determinística).
//
// GOVERNANÇA:
// - Sem chamadas externas, sem Date.now na decisão, sem random.
// - A única saída dependente de tempo é evaluatedAt (metadado), e ela
//   NÃO influencia o verdict nem o digest.
// - Fail-closed: qualquer critério sem informação suficiente → blocked;
//   blocked > failed > checked na construção do verdict global.
// ============================================================================
import { createHash } from "crypto";
import {
  CURATOR_CONTRACT_VERSION,
  CURATOR_CRITERIA,
  CURATOR_PROVENANCE,
  type CriterionEvaluation,
  type CuratorCriterion,
  type CuratorDecision,
  type CuratorDecisionInput,
  type CuratorVerdict,
} from "./contract";

/**
 * Marketplaces reconhecidos pelo pipeline de discovery (N10/N12).
 * O candidato usa os nomes do candidatesRepository MARKETPLACES
 * ("Shopee", "Mercado Livre", "Outro"). "Outro" NÃO é reconhecido
 * para curadoria → BLOCKED (marketplace não suportado).
 */
const RECOGNIZED_MARKETPLACES = new Set<string>(["Shopee", "Mercado Livre"]);

/**
 * Hosts oficiais permitidos por marketplace (mesmo catálogo do N2/N6).
 */
const RECOGNIZED_HOSTS: Record<string, ReadonlyArray<string>> = {
  Shopee: ["shopee.com.br", "shopee.com", "shope.ee"],
  "Mercado Livre": ["mercadolivre.com.br", "mercadolibre.com", "meli.la"],
};

/** Provenances de entrada reconhecidas (discovery controlada N10). */
const RECOGNIZED_PROVENANCES = new Set<string>([
  "n10:telegram:url",
  "n10:telegram:search",
  "n10:admin:manual",
  "n10:discovery",
]);

/**
 * Estados compatíveis com ENTRADA no N13. Candidatos rejeitados,
 * retirados ou já em FUNNEL_END não devem ser avaliados novamente.
 */
const VALID_ENTRY_STATUSES = new Set<string>(["DISCOVERED", "REVIEWING", "INCONCLUSIVE"]);
const VALID_ENTRY_STAGES = new Set<string>(["INTAKE", "EVIDENCE_OK", "AWAITING_REVIEW"]);

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./u, "").toLowerCase();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Critérios individuais (ordem estável = determinismo garantido)
// ---------------------------------------------------------------------------

function evaluateIdentityPresent(input: CuratorDecisionInput): CriterionEvaluation {
  // Bloco N13 Fase 2 — contrato alinhado ao N1: generateCandidateId() emite
  // can-<hex 24 chars> (nonce base36 + aleatório). O formato canônico aceito
  // é can-<hex entre 24 e 32 chars>; qualquer outro formato é BLOCKED
  // (fail-closed preservado).
  if (!input.candidateId || !/^can-[A-Za-z0-9]{24,32}$/.test(input.candidateId)) {
    return {
      criterion: "c_candidate_identity_present",
      result: "blocked",
      rationale: "candidate_id ausente ou fora do formato canônico can-<hex 24-32>",
    };
  }
  return {
    criterion: "c_candidate_identity_present",
    result: "checked",
    rationale: "candidate_id canônico presente e bem formado",
  };
}

function evaluateMarketplace(input: CuratorDecisionInput): CriterionEvaluation {
  if (!input.marketplace) {
    return {
      criterion: "c_marketplace_recognized",
      result: "blocked",
      rationale: "marketplace ausente no candidato",
    };
  }
  if (!RECOGNIZED_MARKETPLACES.has(input.marketplace)) {
    return {
      criterion: "c_marketplace_recognized",
      result: "blocked",
      rationale: `marketplace não suportado pelo filtro: ${input.marketplace}`,
    };
  }
  return {
    criterion: "c_marketplace_recognized",
    result: "checked",
    rationale: `marketplace reconhecido: ${input.marketplace}`,
  };
}

function evaluateUrl(input: CuratorDecisionInput): CriterionEvaluation {
  if (!input.sourceUrl) {
    return {
      criterion: "c_url_valid",
      result: "blocked",
      rationale: "source_url ausente no candidato",
    };
  }
  const host = hostOf(input.sourceUrl);
  if (!host) {
    return {
      criterion: "c_url_valid",
      result: "blocked",
      rationale: "source_url inválida (não é URI absoluta parseável)",
    };
  }
  const allowed = RECOGNIZED_HOSTS[input.marketplace ?? ""] as ReadonlyArray<string> | undefined;
  const hostIsOfficial =
    Array.isArray(allowed) && allowed.some((official) => host === official || host.endsWith(`.${official}`));
  if (!hostIsOfficial) {
    return {
      criterion: "c_url_valid",
      result: "blocked",
      rationale: `host da source_url fora do whitelist do marketplace: ${host}`,
    };
  }
  return {
    criterion: "c_url_valid",
    result: "checked",
    rationale: `source_url parseável com host oficial: ${host}`,
  };
}

function evaluateEvidencePresent(input: CuratorDecisionInput): CriterionEvaluation {
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    return {
      criterion: "c_evidence_present",
      result: "blocked",
      rationale: "nenhuma evidência vinculada ao candidato",
    };
  }
  return {
    criterion: "c_evidence_present",
    result: "checked",
    rationale: `${input.evidence.length} evidência(s) vinculada(s) ao candidato`,
  };
}

/**
 * Coerência: presença de contradição explícita → blocked; presença de
 * estado DERIVED não reconhecido ou COLLECTION_FAILED → blocked.
 * CONTRADICTED com referência a evidências anuladas preserva ambas e
 * sinaliza conflito → blocked.
 */
function evaluateEvidenceCoherent(input: CuratorDecisionInput): CriterionEvaluation {
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  if (evidence.some((e) => e.isContradicted)) {
    return {
      criterion: "c_evidence_coherent",
      result: "blocked",
      rationale: "evidência explicitamente contraditada presente no conjunto",
    };
  }
  if (evidence.some((e) => e.fieldState === "COLLECTION_FAILED")) {
    return {
      criterion: "c_evidence_coherent",
      result: "blocked",
      rationale: "evidência com coleção falha (COLLECTION_FAILED) sem evidência substituta",
    };
  }
  if (evidence.some((e) => e.fieldState === "CONTRADICTED")) {
    return {
      criterion: "c_evidence_coherent",
      result: "blocked",
      rationale: "campo de evidência marcado como CONTRADICTED",
    };
  }
  if (evidence.every((e) => e.fieldState === "UNKNOWN")) {
    return {
      criterion: "c_evidence_coherent",
      result: "blocked",
      rationale: "todas as evidências estão em estado UNKNOWN — nenhuma informação utilizável",
    };
  }
  return {
    criterion: "c_evidence_coherent",
    result: "checked",
    rationale: "evidências coerentes: sem contradição e com pelo menos um campoKnown/declarado",
  };
}

function evaluateProvenance(input: CuratorDecisionInput): CriterionEvaluation {
  if (!input.provenance) {
    return {
      criterion: "c_provenance_valid",
      result: "blocked",
      rationale: "provenance ausente no candidato",
    };
  }
  if (!RECOGNIZED_PROVENANCES.has(input.provenance)) {
    return {
      criterion: "c_provenance_valid",
      result: "blocked",
      rationale: `provenance não reconhecida pelo filtro: ${input.provenance}`,
    };
  }
  return {
    criterion: "c_provenance_valid",
    result: "checked",
    rationale: `provenance reconhecida: ${input.provenance}`,
  };
}

function evaluateEntryState(input: CuratorDecisionInput): CriterionEvaluation {
  if (!input.status) {
    return {
      criterion: "c_entry_state_valid",
      result: "blocked",
      rationale: "status ausente no candidato",
    };
  }
  if (!VALID_ENTRY_STATUSES.has(input.status)) {
    return {
      criterion: "c_entry_state_valid",
      result: "failed",
      rationale: `status incompatível com entrada no N13: ${input.status}`,
    };
  }
  if (input.funnelStage && !VALID_ENTRY_STAGES.has(input.funnelStage)) {
    return {
      criterion: "c_entry_state_valid",
      result: "failed",
      rationale: `funnel_stage incompatível com entrada no N13: ${input.funnelStage}`,
    };
  }
  return {
    criterion: "c_entry_state_valid",
    result: "checked",
    rationale: `estado compatível: status=${input.status}, stage=${input.funnelStage ?? "não declarado"}`,
  };
}

function evaluateIdentityFields(input: CuratorDecisionInput): CriterionEvaluation {
  if (!input.externalListingId) {
    return {
      criterion: "c_identity_fields_complete",
      result: "blocked",
      rationale: "external_listing_id ausente — identidade do anúncio não resolvida",
    };
  }
  return {
    criterion: "c_identity_fields_complete",
    result: "checked",
    rationale: `external_listing_id presente: ${input.externalListingId}`,
  };
}

const EVALUATORS: Record<CuratorCriterion, (input: CuratorDecisionInput) => CriterionEvaluation> = {
  c_candidate_identity_present: evaluateIdentityPresent,
  c_marketplace_recognized: evaluateMarketplace,
  c_url_valid: evaluateUrl,
  c_evidence_present: evaluateEvidencePresent,
  c_evidence_coherent: evaluateEvidenceCoherent,
  c_provenance_valid: evaluateProvenance,
  c_entry_state_valid: evaluateEntryState,
  c_identity_fields_complete: evaluateIdentityFields,
};

// ---------------------------------------------------------------------------
// Decisão global
// ---------------------------------------------------------------------------

/**
 * Regra determinística do verdict global (aplicada nesta ordem):
 * 1. Qualquer critério failed → FAIL.
 * 2. Qualquer critério blocked → BLOCKED.
 * 3. Caso contrário → PASS.
 * Nunca PASS por fallback: PASS só acontece quando TODOS os critérios
 * estão checked.
 */
export function deriveVerdict(criteria: ReadonlyArray<CriterionEvaluation>): CuratorVerdict {
  if (criteria.some((c) => c.result === "failed")) return "FAIL";
  if (criteria.some((c) => c.result === "blocked")) return "BLOCKED";
  return "PASS";
}

export function deriveConfidence(criteria: ReadonlyArray<CriterionEvaluation>): number {
  if (criteria.length === 0) return 0;
  const decided = criteria.filter((c) => c.result === "checked" || c.result === "failed").length;
  return Math.round((decided / criteria.length) * 100) / 100;
}

export function buildGlobalRationale(criteria: ReadonlyArray<CriterionEvaluation>, verdict: CuratorVerdict): string {
  if (verdict === "PASS") {
    return "todos_os_criterios_estruturais_atendidos_com_evidencia_suficiente";
  }
  if (verdict === "FAIL") {
    const firstFailed = criteria.find((c) => c.result === "failed");
    return `falha_estrutural:${firstFailed?.criterion ?? "unknown"}:${firstFailed?.rationale ?? "n/d"}`;
  }
  const blocked = criteria.filter((c) => c.result === "blocked").map((c) => `${c.criterion}:${c.rationale}`);
  return `informacao_insuficiente_ou_conflitante:${blocked.join(";")}`;
}

function stableDigest(input: CuratorDecisionInput, verdict: CuratorVerdict): string {
  const payload = {
    contractVersion: CURATOR_CONTRACT_VERSION,
    candidateId: input.candidateId,
    marketplace: input.marketplace,
    sourceUrl: input.sourceUrl,
    externalListingId: input.externalListingId,
    status: input.status,
    funnelStage: input.funnelStage,
    provenance: input.provenance,
    // Evidências ordenadas por evidenceId para que o digest seja ESTÁVEL
    // independentemente da ordem de chegada (replay idempotente).
    evidence: input.evidence
      .map((e) => ({
        evidenceId: e.evidenceId,
        fieldName: e.fieldName,
        fieldState: e.fieldState,
        isContradicted: e.isContradicted,
        kind: e.kind,
      }))
      .sort((x, y) => (x.evidenceId < y.evidenceId ? -1 : x.evidenceId > y.evidenceId ? 1 : 0)),
    verdict,
  };
  // Replacer: ordena as chaves de objetos alfabeticamente SEM eliminar arrays
  // (Object.keys(payload).sort() como replacer destrói objetos filhos).
  const orderedKeysReplacer = (_key: string, value: unknown): unknown => {
    if (Array.isArray(value)) return value;
    if (typeof value === "object" && value !== null) {
      return Object.keys(value)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (value as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return value;
  };
  const serialized = JSON.stringify(payload, orderedKeysReplacer);
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

/**
 * evaluateCandidate — avaliação pura e determinística.
 *
 * Mesmo input (mesma ordem de evidências no array) → mesmo verdict,
 * mesma confidence, mesmo rationale e mesmo digest.
 */
export function evaluateCandidate(input: CuratorDecisionInput, now: string): CuratorDecision {
  const criteria: CriterionEvaluation[] = CURATOR_CRITERIA.map(
    (criterion) => EVALUATORS[criterion as CuratorCriterion](input),
  );
  const verdict = deriveVerdict(criteria);
  const confidence = deriveConfidence(criteria);
  const rationale = buildGlobalRationale(criteria, verdict);
  const digest = stableDigest(input, verdict);
  return {
    contractVersion: CURATOR_CONTRACT_VERSION,
    candidateId: input.candidateId,
    verdict,
    confidence,
    criteria,
    rationale,
    digest,
    idempotencyKey: `cur-${digest.slice(0, 40)}`,
    evaluatedAt: now,
  };
}

export const CURATOR_METADATA = {
  provenance: CURATOR_PROVENANCE,
  note: "N13 Fase 1 — filtro de curadoria estrutural. Curadoria NÃO cria produto, NÃO cria link, NÃO publica.",
} as const;
