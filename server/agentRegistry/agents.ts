/**
 * Bloco 15 — Fase A — Registros congelados do Agent Registry.
 *
 * Os agentes abaixo são artefatos versionados e imutáveis em código.
 * A única forma de registrar/alterar um agente é alteração de código
 * em main com revisão humana — não existe registro em runtime.
 *
 * Permissões seguem o princípio de default deny: quando uma capacidade
 * não está explicitamente definida, usa-se lista vazia em vez de inferir.
 * Os 9 agentes representam capacidades DECLARATIVAS; nenhum agente
 * é executável nesta fase.
 */
import {
  AGENT_REGISTRY_POLICY_VERSION,
  type AgentDefinition,
} from "./types";

/** Discovery Agent — leitura de catálogo e observações para descoberta futura de produtos.
 *  Ações declarativas: nenhuma ação de escrita/excecução; apenas leitura.
 *  Risco máximo: LOW. Política: 1.0. */
export const DISCOVERY_AGENT = Object.freeze<AgentDefinition>({
  agentId: "discovery-agent",
  version: "1.0",
  role: "descoberta",
  description:
    "Consulta catálogo e observações para identificar produtos com potencial de curadoria futura. Não executa ingestão, não publica, não enfileira.",
  status: "DRAFT",
  enabled: false,
  allowedTools: Object.freeze(["catalog.read", "observations.read"]),
  allowedTables: Object.freeze(["products", "product_clicks"]),
  allowedActions: Object.freeze(["READ_PRODUCT", "READ_OBSERVATION"]),
  maxRisk: "LOW",
  tokenBudget: 0,
  timeBudgetMs: 0,
  memoryScope: Object.freeze(["PRODUCT", "OBSERVATIONS"]),
  policyVersion: AGENT_REGISTRY_POLICY_VERSION,
});

/** Research Agent — leitura analítica do Commercial Brain existente. */
export const RESEARCH_AGENT = Object.freeze<AgentDefinition>({
  agentId: "research-agent",
  version: "1.0",
  role: "pesquisa",
  description:
    "Lê sinais e artefatos do Commercial Brain para consolidar informação de pesquisa. Não cria sinais, não cria recomendações, não executa análise.",
  status: "DRAFT",
  enabled: false,
  allowedTools: Object.freeze(["commercial.signals.read"]),
  allowedTables: Object.freeze(["commercial_signals", "commercial_artifacts"]),
  allowedActions: Object.freeze(["READ_COMMERCIAL_SIGNAL", "READ_COMMERCIAL_ARTIFACT"]),
  maxRisk: "LOW",
  tokenBudget: 0,
  timeBudgetMs: 0,
  memoryScope: Object.freeze(["COMMERCIAL_SIGNALS", "COMMERCIAL_ARTIFACTS"]),
  policyVersion: AGENT_REGISTRY_POLICY_VERSION,
});

/** Product Analyst — leitura e análise de produtos (read-only do Bloco 14). */
export const PRODUCT_ANALYST_AGENT = Object.freeze<AgentDefinition>({
  agentId: "product-analyst",
  version: "1.0",
  role: "análise de produto",
  description:
    "Lê produtos e realiza análise comercial read-only (analyze). Declara intenção futura de usar signals.read; nenhuma escrita declarada.",
  status: "DRAFT",
  enabled: false,
  allowedTools: Object.freeze(["products.read", "commercial.analyze"]),
  allowedTables: Object.freeze(["products", "product_clicks"]),
  allowedActions: Object.freeze(["READ_PRODUCT", "ANALYZE_PRODUCT"]),
  maxRisk: "LOW",
  tokenBudget: 0,
  timeBudgetMs: 0,
  memoryScope: Object.freeze(["PRODUCT"]),
  policyVersion: AGENT_REGISTRY_POLICY_VERSION,
});

/** Curator Agent — leitura de recomendações para curadoria futura de produtos.
 *  PUBLISH_PRODUCT declarada como capacidade DESCRITIVA; risco HIGH não é
 *  permitido pelo max_risk LOW — a política bloqueará a ação até nova versão. */
export const CURATOR_AGENT = Object.freeze<AgentDefinition>({
  agentId: "curator-agent",
  version: "1.0",
  role: "curadoria",
  description:
    "Consolida recomendações do Commercial Brain para revisão de curadoria humana. PUBLISH_PRODUCT é capacidade declarativa bloqueada por max_risk LOW até política explícita.",
  status: "DRAFT",
  enabled: false,
  // commercial.signals.read é a ÚNICA tool declarativa (ACTION_TOOL_MAP)
  // compatível com as actions do curador; lifecycle.read é DRAFT (sem action
  // compatível ainda) e fica fora do contrato fechado.
  allowedTools: Object.freeze(["commercial.signals.read"]),
  allowedTables: Object.freeze(["commercial_signals", "commercial_artifacts"]),
  allowedActions: Object.freeze(["READ_COMMERCIAL_SIGNAL", "READ_COMMERCIAL_ARTIFACT"]),
  maxRisk: "LOW",
  tokenBudget: 0,
  timeBudgetMs: 0,
  memoryScope: Object.freeze(["COMMERCIAL_SIGNALS", "COMMERCIAL_ARTIFACTS"]),
  policyVersion: AGENT_REGISTRY_POLICY_VERSION,
});

/** Pricing Analyst — leitura de sinais de preço (Bloco 14) para análise futura. */
export const PRICING_ANALYST_AGENT = Object.freeze<AgentDefinition>({
  agentId: "pricing-analyst",
  version: "1.0",
  role: "análise de preços",
  description:
    "Lê sinais de preço do Commercial Brain para análise de pricing. UPDATE_PRICE permanece fora das ações permitidas.",
  status: "DRAFT",
  enabled: false,
  allowedTools: Object.freeze(["commercial.signals.read"]),
  allowedTables: Object.freeze(["commercial_signals", "commercial_artifacts"]),
  allowedActions: Object.freeze(["READ_COMMERCIAL_SIGNAL", "READ_COMMERCIAL_ARTIFACT"]),
  maxRisk: "LOW",
  tokenBudget: 0,
  timeBudgetMs: 0,
  memoryScope: Object.freeze(["COMMERCIAL_SIGNALS"]),
  policyVersion: AGENT_REGISTRY_POLICY_VERSION,
});

/** Marketing Analyst — leitura de interesses/cliques para análise de marketing. */
export const MARKETING_ANALYST_AGENT = Object.freeze<AgentDefinition>({
  agentId: "marketing-analyst",
  version: "1.0",
  role: "análise de marketing",
  description:
    "Lê cliques de produto e sinais de interesse para análise de marketing. SEND_TELEGRAM permanece fora das ações permitidas.",
  status: "DRAFT",
  enabled: false,
  allowedTools: Object.freeze(["observations.read"]),
  allowedTables: Object.freeze(["product_clicks"]),
  allowedActions: Object.freeze(["READ_PRODUCT", "READ_OBSERVATION"]),
  maxRisk: "LOW",
  tokenBudget: 0,
  timeBudgetMs: 0,
  memoryScope: Object.freeze(["PRODUCT", "OBSERVATIONS"]),
  policyVersion: AGENT_REGISTRY_POLICY_VERSION,
});

/** Analytics Analyst — leitura operacional e de jobs para relatórios futuros. */
export const ANALYTICS_ANALYST_AGENT = Object.freeze<AgentDefinition>({
  agentId: "analytics-analyst",
  version: "1.0",
  role: "análise analítica",
  description:
    "Lê eventos operacionais e estado da job queue para relatórios analíticos. ENQUEUE_JOB declarada como capacidade DESCRITIVA bloqueada por max_risk LOW.",
  status: "DRAFT",
  enabled: false,
  allowedTools: Object.freeze(["operational.read", "job_queue.read"]),
  allowedTables: Object.freeze(["operational_events", "job_queue"]),
  allowedActions: Object.freeze(["READ_OPERATIONAL_EVENT", "READ_JOB_QUEUE"]),
  maxRisk: "LOW",
  tokenBudget: 0,
  timeBudgetMs: 0,
  memoryScope: Object.freeze(["OPERATIONAL_EVENTS", "JOB_QUEUE"]),
  policyVersion: AGENT_REGISTRY_POLICY_VERSION,
});

/** Reliability Agent — leitura de incidentes/recuperações para confiabilidade futura. */
export const RELIABILITY_AGENT = Object.freeze<AgentDefinition>({
  agentId: "reliability-agent",
  version: "1.0",
  role: "confiabilidade",
  description:
    "Lê incidentes operacionais e tentativas de recuperação para monitoramento de confiabilidade. RUN_RECOVERY permanece fora das ações permitidas.",
  status: "DRAFT",
  enabled: false,
  allowedTools: Object.freeze(["operational.read"]),
  allowedTables: Object.freeze([
    "operational_events",
    "operational_incidents",
    "operational_recovery_attempts",
    "operator_state",
  ]),
  allowedActions: Object.freeze(["READ_OPERATIONAL_EVENT"]),
  maxRisk: "LOW",
  tokenBudget: 0,
  timeBudgetMs: 0,
  memoryScope: Object.freeze(["OPERATIONAL_EVENTS", "OPERATIONAL_OPERATIONS"]),
  policyVersion: AGENT_REGISTRY_POLICY_VERSION,
});

/** Security Agent — leitura de estado operacional e eventos de segurança. */
export const SECURITY_AGENT = Object.freeze<AgentDefinition>({
  agentId: "security-agent",
  version: "1.0",
  role: "segurança",
  description:
    "Lê estado operacional, eventos e estado do Operator para monitoramento de segurança. operator.approve permanece fora das tools permitidas.",
  status: "DRAFT",
  enabled: false,
  allowedTools: Object.freeze(["operational.read", "operator.mode.read"]),
  allowedTables: Object.freeze(["operational_events", "operator_state"]),
  allowedActions: Object.freeze(["READ_OPERATIONAL_EVENT"]),
  maxRisk: "LOW",
  tokenBudget: 0,
  timeBudgetMs: 0,
  memoryScope: Object.freeze(["OPERATIONAL_EVENTS"]),
  policyVersion: AGENT_REGISTRY_POLICY_VERSION,
});

/** Registros congelados do Agent Registry — imutáveis por construção. */
export const AGENT_REGISTRY: ReadonlyArray<AgentDefinition> = Object.freeze([
  DISCOVERY_AGENT,
  RESEARCH_AGENT,
  PRODUCT_ANALYST_AGENT,
  CURATOR_AGENT,
  PRICING_ANALYST_AGENT,
  MARKETING_ANALYST_AGENT,
  ANALYTICS_ANALYST_AGENT,
  RELIABILITY_AGENT,
  SECURITY_AGENT,
]);

/** Registry lookup — somente leitura. Nenhum método de registro em runtime. */
export function getAgent(agentId: string): AgentDefinition | undefined {
  return AGENT_REGISTRY.find(agent => agent.agentId === agentId);
}

export function listAgents(): ReadonlyArray<AgentDefinition> {
  return AGENT_REGISTRY;
}
