/**
 * Bloco 15 — Fase A — Contrato do Agent Registry.
 *
 * Este módulo define APENAS o contrato declarativo de agentes:
 * tipos, catálogos fechados e estruturas versionadas.
 *
 * REGRAS DE CONTRATO:
 * - Nomes de ações/tools NÃO são executáveis; são capacidades declarativas.
 * - Default deny: qualquer referência fora dos catálogos fechados é inválida.
 * - Registry inválido deve falhar no carregamento/teste, nunca ser corrigido silenciosamente.
 * - Nenhum agente pode alterar o próprio registry (read-only por construção).
 *
 * Dependencies: nenhuma dependência operacional (sem Supabase, sem Telegram,
 * sem Operator, sem job_queue, sem productsRepository, sem LLM).
 */

/** Vocabulário fechado de risco — reutiliza o vocabulário existente do
 *  safeAutoHealEngine (AutoHealRisk: LOW|MEDIUM|HIGH|CRITICAL). */
export type AgentRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Ordem total do vocabulário de risco: LOW < MEDIUM < HIGH < CRITICAL.
 *  Usada para comparar risk_requested vs max_risk (Fase B do Bloco 15). */
export const AGENT_RISK_ORDER: ReadonlyArray<AgentRiskLevel> = Object.freeze([
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
]);

/** Ferramentas permitidas — catálogo fechado definido na Fase 0.
 *  Nenhuma ferramenta nova é criada nesta fase; os nomes descrevem
 *  capacidades reais já existentes no backend, sem criar ferramentas. */
export type AgentToolName =
  | "catalog.read"
  | "observations.read"
  | "commercial.analyze"
  | "commercial.recommend"
  | "commercial.signals.read"
  | "job_queue.read"
  | "job_queue.enqueue"
  | "telegram.send"
  | "telegram.status"
  | "products.read"
  | "products.write"
  | "operational.read"
  | "operator.approve"
  | "operator.mode.read"
  | "lifecycle.read";

/** Catálogo fechado de ferramentas. */
export const AGENT_TOOL_CATALOG: ReadonlyArray<AgentToolName> = Object.freeze([
  "catalog.read",
  "observations.read",
  "commercial.analyze",
  "commercial.recommend",
  "commercial.signals.read",
  "job_queue.read",
  "job_queue.enqueue",
  "telegram.send",
  "telegram.status",
  "products.read",
  "products.write",
  "operational.read",
  "operator.approve",
  "operator.mode.read",
  "lifecycle.read",
]);

/** Ações permitidas — catálogo fechado definido na Fase 0.
 *  Os nomes são capacidades DECLARATIVAS e NÃO são executáveis. */
export type AgentActionName =
  | "READ_PRODUCT"
  | "READ_OBSERVATION"
  | "ANALYZE_PRODUCT"
  | "READ_COMMERCIAL_SIGNAL"
  | "READ_COMMERCIAL_ARTIFACT"
  | "READ_JOB_QUEUE"
  | "CREATE_RECOMMENDATION"
  | "CREATE_SIGNAL"
  | "PUBLISH_PRODUCT"
  | "UPDATE_PRODUCT"
  | "DELETE_PRODUCT"
  | "UPDATE_PRICE"
  | "SEND_TELEGRAM"
  | "ENQUEUE_JOB"
  | "RUN_RECOVERY"
  | "READ_OPERATIONAL_EVENT";

/** Categorias de ação — usadas para políticas de piso de risco (Fase B). */
export type AgentActionCategory = "read" | "write" | "execute" | "dispatch";

/** Risco mínimo por ação, conforme o catálogo fechado da Fase 0. */
export const AGENT_ACTION_MIN_RISK: Readonly<Record<AgentActionName, AgentRiskLevel>> =
  Object.freeze({
    READ_PRODUCT: "LOW",
    READ_OBSERVATION: "LOW",
    ANALYZE_PRODUCT: "LOW",
    READ_COMMERCIAL_SIGNAL: "LOW",
    READ_COMMERCIAL_ARTIFACT: "LOW",
    READ_JOB_QUEUE: "LOW",
    READ_OPERATIONAL_EVENT: "LOW",
    CREATE_RECOMMENDATION: "MEDIUM",
    CREATE_SIGNAL: "MEDIUM",
    ENQUEUE_JOB: "MEDIUM",
    PUBLISH_PRODUCT: "HIGH",
    SEND_TELEGRAM: "HIGH",
    UPDATE_PRODUCT: "HIGH",
    DELETE_PRODUCT: "CRITICAL",
    UPDATE_PRICE: "CRITICAL",
    RUN_RECOVERY: "CRITICAL",
  });

/** Catálogo fechado de ações. */
export const AGENT_ACTION_CATALOG: ReadonlyArray<AgentActionName> = Object.freeze([
  "READ_PRODUCT",
  "READ_OBSERVATION",
  "ANALYZE_PRODUCT",
  "READ_COMMERCIAL_SIGNAL",
  "READ_COMMERCIAL_ARTIFACT",
  "READ_JOB_QUEUE",
  "READ_OPERATIONAL_EVENT",
  "CREATE_RECOMMENDATION",
  "CREATE_SIGNAL",
  "PUBLISH_PRODUCT",
  "UPDATE_PRODUCT",
  "DELETE_PRODUCT",
  "UPDATE_PRICE",
  "SEND_TELEGRAM",
  "ENQUEUE_JOB",
  "RUN_RECOVERY",
]);

/** Tabelas reais existentes no sistema (auditadas na Fase 0).
 *  allowed_tables declara consulta POSSÍVEL mediante ação de leitura
 *  autorizada — NÃO concede acesso automático. */
export type AgentTableName =
  | "products"
  | "catalog_categories"
  | "product_clicks"
  | "product_price_observed"
  | "product_availability_observed"
  | "product_source_observed"
  | "product_image_observed"
  | "commercial_signals"
  | "commercial_artifacts"
  | "job_queue"
  | "operational_events"
  | "operational_incidents"
  | "operational_recovery_attempts"
  | "operator_state";

/** Catálogo fechado de tabelas (tabelas reais auditadas em produção). */
export const AGENT_TABLE_CATALOG: ReadonlyArray<AgentTableName> = Object.freeze([
  "products",
  "catalog_categories",
  "product_clicks",
  "product_price_observed",
  "product_availability_observed",
  "product_source_observed",
  "product_image_observed",
  "commercial_signals",
  "commercial_artifacts",
  "job_queue",
  "operational_events",
  "operational_incidents",
  "operational_recovery_attempts",
  "operator_state",
]);

/** Escopo de memória — o que um agente pode consultar mediante política.
 *  allowed memory scope != acesso automático. */
export type AgentMemoryScope =
  | "PRODUCT"
  | "OBSERVATIONS"
  | "COMMERCIAL_SIGNALS"
  | "COMMERCIAL_ARTIFACTS"
  | "OPERATIONAL_EVENTS"
  | "OPERATIONAL_OPERATIONS"
  | "JOB_QUEUE";

/** Catálogo fechado de escopos de memória. */
export const AGENT_MEMORY_SCOPE_CATALOG: ReadonlyArray<AgentMemoryScope> = Object.freeze([
  "PRODUCT",
  "OBSERVATIONS",
  "COMMERCIAL_SIGNALS",
  "COMMERCIAL_ARTIFACTS",
  "OPERATIONAL_EVENTS",
  "OPERATIONAL_OPERATIONS",
  "JOB_QUEUE",
]);

/** Status declarativo de um agente. enabled é DECLARATIVO e NÃO representa
 *  execução automática. */
export type AgentStatus = "DRAFT" | "REGISTERED" | "SUSPENDED";

/** Definição de um agente no registry (modelo da Fase 0, regras 1–16). */
export interface AgentDefinition {
  agentId: string;
  version: string;
  role: string;
  description: string;
  status: AgentStatus;
  enabled: boolean;
  allowedTools: ReadonlyArray<AgentToolName>;
  allowedTables: ReadonlyArray<AgentTableName>;
  allowedActions: ReadonlyArray<AgentActionName>;
  maxRisk: AgentRiskLevel;
  tokenBudget: number;
  timeBudgetMs: number;
  memoryScope: ReadonlyArray<AgentMemoryScope>;
  policyVersion: string;
}

/** Versão do contrato do Agent Registry (versionamento semântico congelado). */
export const AGENT_REGISTRY_CONTRACT_VERSION = "1.0";

/** Versão da política de referência do Bloco 15 (congelada). */
export const AGENT_REGISTRY_POLICY_VERSION = "1.0";
