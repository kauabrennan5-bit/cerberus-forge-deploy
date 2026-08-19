/**
 * Bloco N15 — Policy registry versionado: governance_policy_v1
 *
 * Todos os thresholds vivem AQUI, centralizados. O engine e o service
 * NUNCA contêm literais "if score > 0.7" — consultam o registry.
 *
 * Princípio: aprovação por AUSÊNCIA nunca é permitida. Cada ação declara
 * seus requisitos; requisitos ausentes na política → BLOCKED.
 */

import {
  ActionPolicySpec,
  GOVERNANCE_ACTIONS,
  GovernanceAction,
  GovernancePolicyRegistry,
} from "./contract";

export const GOVERNANCE_POLICY_VERSION = "governance_policy_v1";

/** Requisito base — aplicado implicitamente a todas as ações. */
export const GOVERNANCE_BASE_REQUIREMENTS = [
  "candidate_exists",
  "n13_pass",
  "n14_assessment_exists",
  "n14_score_valid",
  "n14_band_valid",
  "evidence_sufficient",
  "provenance_valid",
  "risk_acceptable",
  "assessment_not_stale",
  "candidate_not_promoted_in_conflicting_state",
  "action_allowed",
  "operator_authorization",
] as const;

function baseRequirements(): ActionPolicySpec["requirements"] {
  return GOVERNANCE_BASE_REQUIREMENTS.map((requirement) => ({
    requirement,
    required: true,
    description: baseRequirementDescriptions[requirement] ?? "",
  }));
}

const baseRequirementDescriptions: Record<string, string> = {
  candidate_exists: "O candidato persistido deve existir e ser legível.",
  n13_pass: "O assessment N13 mais recente deve existir com verdict=PASS.",
  n14_assessment_exists:
    "Deve existir assessment N14 válido (filter_version=n14:commercial_brain_v1).",
  n14_score_valid: "O score N14 deve ser um número finito dentro de [0, 1].",
  n14_band_valid:
    "O band N14 deve pertencer a HIGH/MEDIUM/LOW/INSUFFICIENT e ser consistente com o score.",
  evidence_sufficient:
    "O candidato deve possuir evidências coerentes (KNOWN) suficientes.",
  provenance_valid:
    "A proveniência do candidato deve ser reconhecida (prefixo n10:).",
  risk_acceptable:
    "A penalidade de risco combinada deve estar dentro do limite da política.",
  assessment_not_stale:
    "As avaliações de origem devem estar dentro do TTL configurado da política.",
  candidate_not_promoted_in_conflicting_state:
    "O candidato não pode estar em estado de promoção/decisão conflitante.",
  action_allowed: "A ação solicitada deve existir no catálogo de ações.",
  operator_authorization:
    "O contexto de autorização deve ser estabelecido e validado pelo servidor.",
};

/** PUBLISH — requisitos de publicação. */
export const PUBLISH_POLICY: ActionPolicySpec = {
  action: "PUBLISH",
  hard_gates: [
    "candidate_exists",
    "n13_pass",
    "n14_assessment_exists",
    "n14_score_valid",
    "n14_band_valid",
    "evidence_sufficient",
    "provenance_valid",
    "operator_authorization",
  ],
  requirements: [
    ...baseRequirements(),
    {
      requirement: "score_at_least_min",
      required: true,
      description: "O score N14 deve ser >= ao mínimo desta ação.",
    },
    {
      requirement: "risk_at_most_max",
      required: true,
      description: "O risco combinado deve ser <= ao máximo desta ação.",
    },
  ],
  n13_ttl_hours: 168, // 7 dias
  n14_ttl_hours: 72, // 3 dias
  min_score: 0.75,
  max_risk: 0.5,
  stale_status: "REVIEW",
};

/** ACQUIRE_AFFILIATE — requisitos para aquisição de link de afiliado (N8). */
export const ACQUIRE_AFFILIATE_POLICY: ActionPolicySpec = {
  action: "ACQUIRE_AFFILIATE",
  hard_gates: [
    "candidate_exists",
    "n13_pass",
    "n14_assessment_exists",
    "n14_score_valid",
    "n14_band_valid",
    "provenance_valid",
    "operator_authorization",
  ],
  requirements: [
    ...baseRequirements(),
    {
      requirement: "n8_contract_compatible",
      required: true,
      description:
        "A identidade externa deve ser compatível com o contrato do N8 (affiliate_resolver_v1).",
    },
    {
      requirement: "score_at_least_min",
      required: true,
      description: "O score N14 deve ser >= ao mínimo desta ação.",
    },
  ],
  n13_ttl_hours: 168,
  n14_ttl_hours: 72,
  min_score: 0.6,
  max_risk: 0.5,
  stale_status: "REVIEW",
};

/** DISTRIBUTE — depende de PUBLISH previamente autorizado. */
export const DISTRIBUTE_POLICY: ActionPolicySpec = {
  action: "DISTRIBUTE",
  hard_gates: [
    "candidate_exists",
    "n13_pass",
    "n14_assessment_exists",
    "n14_score_valid",
    "operator_authorization",
  ],
  requirements: [
    ...baseRequirements(),
    {
      requirement: "publish_previously_authorized",
      required: true,
      description:
        "Deve existir decisão PUBLISH=APPROVED vigente para este candidato.",
    },
    {
      requirement: "channel_allowed",
      required: true,
      description: "O canal de distribuição deve ser permitido pela política.",
    },
  ],
  n13_ttl_hours: 168,
  n14_ttl_hours: 72,
  min_score: 0.7,
  max_risk: 0.5,
  stale_status: "REVIEW",
};

/** ADVERTISE — mídia paga; score mínimo superior ao de PUBLISH. */
export const ADVERTISE_POLICY: ActionPolicySpec = {
  action: "ADVERTISE",
  hard_gates: [
    "candidate_exists",
    "n13_pass",
    "n14_assessment_exists",
    "n14_score_valid",
    "n14_band_valid",
    "evidence_sufficient",
    "provenance_valid",
    "risk_acceptable",
    "operator_authorization",
  ],
  requirements: [
    ...baseRequirements(),
    {
      requirement: "publish_previously_authorized",
      required: true,
      description:
        "Deve existir decisão PUBLISH=APPROVED vigente para este candidato.",
    },
    {
      requirement: "score_at_least_min_advertise",
      required: true,
      description:
        "O score N14 deve ser >= ao mínimo desta ação (superior ao de PUBLISH).",
    },
    {
      requirement: "risk_at_most_max_advertise",
      required: true,
      description: "O risco deve estar dentro do limite mais restrito de mídia paga.",
    },
    {
      requirement: "explicit_authorization_scope",
      required: true,
      description:
        "A ação ADVERTISE deve constar explicitamente do authorization_scope do operador.",
    },
  ],
  n13_ttl_hours: 168,
  n14_ttl_hours: 48,
  min_score: 0.85,
  max_risk: 0.3,
  stale_status: "BLOCKED",
};

/** Registry versionado — thresholds centralizados. */
export const GOVERNANCE_POLICY_REGISTRY: GovernancePolicyRegistry = {
  version: GOVERNANCE_POLICY_VERSION,
  base_requirements: [...GOVERNANCE_BASE_REQUIREMENTS],
  actions: {
    PUBLISH: PUBLISH_POLICY,
    ACQUIRE_AFFILIATE: ACQUIRE_AFFILIATE_POLICY,
    DISTRIBUTE: DISTRIBUTE_POLICY,
    ADVERTISE: ADVERTISE_POLICY,
  },
};

export function getActionPolicy(action: GovernanceAction): ActionPolicySpec {
  const policy = GOVERNANCE_POLICY_REGISTRY.actions[action];
  if (!policy) {
    throw new Error(`unknown_policy: ${action}`);
  }
  return policy;
}

export function listGovernanceActions(): GovernanceAction[] {
  return [...GOVERNANCE_ACTIONS];
}
