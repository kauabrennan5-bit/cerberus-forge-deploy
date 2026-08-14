import fs from "fs";
import path from "path";
import { supabase, getProducts } from "../repositories/productsRepository";
import { exportStaticProductsJson } from "./exportProductsJson";
import { syncCatalogAndDeploy } from "./catalogSync";
import { getProductPipelineTelemetry } from "./productPipeline";
import {
  type AutoHealActionResult,
  type AutoHealMode,
  type AutoHealContext,
  type AutoHealRisk,
  type SafeAction,
  SafeAutoHealEngine,
} from "./safeAutoHealEngine";
import {
  decideRecovery,
  OperationalStateStore,
  OperatorStateMachine,
  type OperationalStateSnapshot,
  type StateTransition,
} from "./operatorAutonomy";

export type HealthStatus = "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN";
export type IncidentSeverity = "INFO" | "WARNING" | "ERROR" | "CRITICAL";
export type IncidentStatus = "OPEN" | "INVESTIGATING" | "AUTO_FIXING" | "RESOLVED" | "FAILED" | "REQUIRES_APPROVAL" | "ESCALATED";
export type OperatorMode = AutoHealMode;

export interface ComponentHealth {
  name: string;
  status: HealthStatus;
  latencyMs: number;
  timestamp: string;
  details?: string;
  version?: string;
  error?: string;
}

export interface OperatorSystemReport {
  overallStatus: HealthStatus;
  mode: OperatorMode;
  components: Record<string, ComponentHealth>;
  activeIncidentsCount: number;
  recentCorrectionsCount: number;
  lastCheckAt: string;
  nextCheckAt?: string;
  autonomyLevel?: 0 | 1 | 2 | 3;
  operatorState?: string;
  escalationCount?: number;
}

export interface Incident {
  id: string;
  fingerprint: string;
  type: string;
  severity: IncidentSeverity;
  component: string;
  detection: string;
  diagnosis: string;
  status: IncidentStatus;
  actionTaken: string;
  result: string;
  timestamp: string;
  recoveredAt?: string;
  durationMs?: number;
}

export interface HistoryRecord {
  timestamp: string;
  component: string;
  status: HealthStatus;
  latencyMs: number;
  error?: string;
}

export interface OperatorActionView {
  id: string;
  name: string;
  description: string;
  risk: AutoHealRisk;
  requiresApproval: boolean;
}

export interface PendingApproval {
  id: string;
  actionId: string;
  incidentId?: string;
  requestedBy: string;
  createdAt: string;
  expiresAt: number;
}

// Estado em memória e configuração do Operator (Bloco 4)
let currentMode: OperatorMode = "OBSERVE";
let incidents: Incident[] = [];
let healthHistory: HistoryRecord[] = [];
let recentCorrectionsLog: Array<{ timestamp: string; action: string; result: string }> = [];
let lastReportCache: OperatorSystemReport | null = null;
let lastCheckTimestamp: string = "Nunca executado";
let nextCheckTimestamp: string = "Agendado";
let schedulerTimer: NodeJS.Timeout | null = null;
let consecutiveFailures: Record<string, number> = {};
let pendingApprovals: PendingApproval[] = [];
const operatorStateMachine = new OperatorStateMachine();
const operationalStateStore = new OperationalStateStore();

const CONFIG = {
  checkIntervalMs: 10 * 60 * 1000, // 10 minutos (conservador para evitar cold start excessivo no Render)
  maxHistoryRecords: 100,
  maxIncidents: 50,
  failureThresholdForError: 3 // 3 falhas consecutivas elevam para ERROR persistente
};

const BACKEND_PRODUCTS_URL = process.env.CATALOG_API_URL || "https://cerberus-forge-deploy-backend.onrender.com/api/products";
const STATIC_CATALOG_URL = "https://cerberus-static-catalog.onrender.com/data/products.json";
const GITHUB_MAIN_URL = "https://api.github.com/repos/kauabrennan5-bit/cerberus-forge-deploy/branches/main";

async function fetchJsonWithTimeout(url: string, timeoutMs = 15_000): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "cerberus-operator" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function setOperatorMode(mode: OperatorMode): void {
  currentMode = mode;
  console.log(`[OPERATOR] Modo operacional alterado para: ${mode}`);
}

export function getOperatorMode(): OperatorMode {
  return currentMode;
}

export function getIncidents(): Incident[] {
  return incidents;
}

export function getHealthHistory(): HistoryRecord[] {
  return healthHistory;
}

export function getRecentCorrections(): Array<{ timestamp: string; action: string; result: string }> {
  return recentCorrectionsLog;
}

export function getOperationalState(): OperationalStateSnapshot {
  return operationalStateStore.snapshot(currentMode, operatorStateMachine);
}

export function getOperatorStateHistory(): StateTransition[] {
  return operatorStateMachine.getHistory();
}

export function getEscalatedIncidents(): Incident[] {
  return incidents.filter(incident => incident.status === "ESCALATED");
}

function moveOperatorState(to: Parameters<OperatorStateMachine["transition"]>[0], reason: string): StateTransition | undefined {
  try {
    return operatorStateMachine.transition(to, reason);
  } catch (error) {
    // O estado é fail-safe: não força transição inválida nem interrompe funções fundamentais.
    console.warn(`[OPERATOR STATE] Transição ignorada: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function catalogOutputPath(): string {
  return path.join(process.cwd(), "public", "data", "products.json");
}

async function readCatalogSnapshot(): Promise<string | null> {
  try {
    return await fs.promises.readFile(catalogOutputPath(), "utf-8");
  } catch {
    return null;
  }
}

async function restoreCatalogSnapshot(snapshot: string | null | undefined): Promise<void> {
  if (typeof snapshot !== "string") return;
  await fs.promises.mkdir(path.dirname(catalogOutputPath()), { recursive: true });
  await fs.promises.writeFile(catalogOutputPath(), snapshot, "utf-8");
}

async function canonicalProductsAvailable(): Promise<{ ok: boolean; details: string }> {
  if (!supabase) return { ok: false, details: "Supabase não inicializado." };
  const products = await getProducts();
  if (!Array.isArray(products) || products.length === 0) {
    return { ok: false, details: "Fonte canônica não retornou produtos válidos." };
  }
  return { ok: true, details: `${products.length} produtos canônicos disponíveis.` };
}

const SAFE_ACTIONS: SafeAction<any, any>[] = [
  {
    id: "REVALIDATE_SERVICES",
    name: "🔄 Revalidar serviços",
    description: "Repete os health checks sem alterar infraestrutura ou dados.",
    risk: "LOW",
    allowed: true,
    timeoutMs: 30_000,
    cooldownMs: 60_000,
    maxRetries: 1,
    retryable: true,
    preconditions: async () => ({ ok: true, details: "Diagnóstico não invasivo permitido." }),
    execute: async () => runSystemHealthCheck(),
    validate: async report => ({
      ok: report.overallStatus !== "UNKNOWN",
      details: `Health check retornou ${report.overallStatus}.`,
    }),
  },
  {
    id: "REGENERATE_STATIC_CATALOG",
    name: "📦 Regenerar catálogo estático",
    description: "Regenera a projeção local a partir de public.products e valida IDs, slugs e quantidade.",
    risk: "LOW",
    allowed: true,
    timeoutMs: 30_000,
    cooldownMs: 10 * 60_000,
    maxRetries: 0,
    retryable: false,
    preconditions: async () => canonicalProductsAvailable(),
    snapshot: async () => readCatalogSnapshot(),
    execute: async () => {
      const canonical = await getProducts();
      const exportedCount = await exportStaticProductsJson();
      const json = JSON.parse(await fs.promises.readFile(catalogOutputPath(), "utf-8"));
      return { canonical, exportedCount, json };
    },
    validate: async result => {
      if (!Array.isArray(result.json) || result.json.length === 0) {
        return { ok: false, details: "A projeção gerada está vazia." };
      }
      if (result.exportedCount !== result.json.length) {
        return { ok: false, details: "Contagem exportada difere do arquivo gerado." };
      }
      const canonicalValid = result.canonical.filter(product => product.ativo !== false && product.status !== "pending");
      const jsonIds = new Set(result.json.map((product: any) => product.id));
      const missing = canonicalValid.filter(product => !jsonIds.has(product.id));
      const invalidIdentity = result.json.some((product: any) => !product.id || !product.slug || !product.produto || !product.link);
      return {
        ok: missing.length === 0 && !invalidIdentity,
        details: missing.length > 0
          ? `Projeção incompleta: ${missing.length} produtos canônicos não encontrados.`
          : `${result.json.length}/${canonicalValid.length} produtos, IDs e slugs validados.`,
      };
    },
    rollback: async snapshot => restoreCatalogSnapshot(snapshot as string | null | undefined),
  },
  {
    id: "REVALIDATE_TRACKING",
    name: "🔎 Revalidar tracking",
    description: "Valida acesso a products e product_clicks sem gerar clique artificial.",
    risk: "LOW",
    allowed: true,
    timeoutMs: 15_000,
    cooldownMs: 5 * 60_000,
    maxRetries: 1,
    retryable: true,
    preconditions: async () => ({ ok: Boolean(supabase), details: "Cliente Supabase disponível." }),
    execute: async () => {
      if (!supabase) throw new Error("Supabase indisponível.");
      const [productsResult, clicksResult] = await Promise.all([
        supabase.from("products").select("id").limit(1),
        supabase.from("product_clicks").select("id").limit(1),
      ]);
      if (productsResult.error || clicksResult.error) {
        throw new Error(productsResult.error?.message || clicksResult.error?.message || "Falha de diagnóstico do tracking.");
      }
      return true;
    },
    validate: async ok => ({ ok, details: "Tabelas products e product_clicks acessíveis sem inserir dados." }),
  },
  {
    id: "REVALIDATE_ANALYTICS",
    name: "📊 Revalidar analytics",
    description: "Executa consulta de diagnóstico em public.product_clicks sem alterar registros.",
    risk: "LOW",
    allowed: true,
    timeoutMs: 15_000,
    cooldownMs: 5 * 60_000,
    maxRetries: 1,
    retryable: true,
    preconditions: async () => ({ ok: Boolean(supabase), details: "Cliente Supabase disponível." }),
    execute: async () => {
      if (!supabase) throw new Error("Supabase indisponível.");
      const { error } = await supabase.from("product_clicks").select("id, product_id, created_at").limit(1);
      if (error) throw error;
      return true;
    },
    validate: async ok => ({ ok, details: "Consulta de analytics validada sem alterar dados." }),
  },
  {
    id: "REVALIDATE_GITHUB_SYNC",
    name: "🔐 Sincronizar catálogo com GitHub",
    description: "Executa o fluxo canônico versionado de sincronização e valida a projeção pública.",
    risk: "MEDIUM",
    allowed: true,
    requiresApproval: true,
    timeoutMs: 120_000,
    cooldownMs: 30 * 60_000,
    maxRetries: 0,
    retryable: false,
    preconditions: async () => canonicalProductsAvailable(),
    execute: async () => syncCatalogAndDeploy(),
    validate: async result => ({
      ok: result.success && result.publicJsonCount >= result.supabaseCount,
      details: result.success
        ? `Sincronização validada: ${result.publicJsonCount}/${result.supabaseCount} produtos públicos.`
        : result.error || "A sincronização não foi validada.",
    }),
  },
];

const autoHealEngine = new SafeAutoHealEngine(SAFE_ACTIONS);

function suggestedActionFor(component: string): string | null {
  const map: Record<string, string> = {
    "Catálogo": "REGENERATE_STATIC_CATALOG",
    "Tracking": "REVALIDATE_TRACKING",
    "Analytics": "REVALIDATE_ANALYTICS",
    "Site": "REVALIDATE_SERVICES",
    "Deploy": "REVALIDATE_SERVICES",
  };
  return map[component] || null;
}

export const AVAILABLE_OPERATOR_ACTIONS: OperatorActionView[] = SAFE_ACTIONS.map(action => ({
  id: action.id,
  name: action.name,
  description: action.description,
  risk: action.risk,
  requiresApproval: Boolean(action.requiresApproval),
}));

export function getAutoHealAuditLog() {
  return autoHealEngine.getAuditLog();
}

export function getPendingApprovals(): PendingApproval[] {
  const now = Date.now();
  pendingApprovals = pendingApprovals.filter(approval => approval.expiresAt > now);
  return pendingApprovals;
}

export function requestOperatorApproval(actionId: string, incidentId: string | undefined, requestedBy: string): PendingApproval | null {
  const action = SAFE_ACTIONS.find(item => item.id === actionId);
  if (!action || !action.allowed) return null;
  const approval: PendingApproval = {
    id: `APR-${Date.now().toString(36)}`,
    actionId,
    incidentId,
    requestedBy,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 15 * 60_000,
  };
  pendingApprovals.unshift(approval);
  return approval;
}

export async function approveOperatorAction(approvalId: string, adminId: string): Promise<AutoHealActionResult | null> {
  const approval = getPendingApprovals().find(item => item.id === approvalId);
  if (!approval) return null;
  pendingApprovals = pendingApprovals.filter(item => item.id !== approvalId);
  const previousMode = currentMode;
  currentMode = "ADMIN_APPROVAL";
  try {
    return await runSafeAutoHeal(approval.actionId, { incidentId: approval.incidentId, actor: "ADMIN", adminId });
  } finally {
    currentMode = previousMode;
  }
}

export async function runSafeAutoHeal(actionId: string, context: AutoHealContext): Promise<AutoHealActionResult> {
  moveOperatorState("HEALING", `Ação registrada selecionada: ${actionId}.`);
  const result = await autoHealEngine.run(actionId, currentMode, context);
  const incident = context.incidentId ? incidents.find(item => item.id === context.incidentId) : undefined;
  if (incident) {
    incident.actionTaken = actionId;
    incident.result = result.message;
    if (result.status === "SUCCESS") {
      moveOperatorState("VALIDATING", `Validação pós-ação: ${actionId}.`);
      moveOperatorState("RECOVERING", `Recuperação confirmada: ${actionId}.`);
      incident.status = "RESOLVED";
      incident.recoveredAt = new Date().toLocaleTimeString("pt-BR");
      moveOperatorState("RESOLVED", `Incidente ${incident.id} validado como recuperado.`);
    }
    if (result.status === "FAILED" || result.status === "TIMEOUT" || result.status === "CIRCUIT_OPEN") {
      incident.status = "ESCALATED";
      incident.result = `${result.message} Escalado para administrador.`;
      operationalStateStore.markEscalated();
      moveOperatorState("ESCALATED", `Ação ${actionId} falhou ou atingiu proteção contra loops.`);
    }
    if (result.status === "APPROVAL_REQUIRED") {
      incident.status = "REQUIRES_APPROVAL";
      moveOperatorState("WAITING_APPROVAL", `Ação ${actionId} requer aprovação explícita.`);
    }
  }
  recentCorrectionsLog.unshift({
    timestamp: new Date().toLocaleTimeString("pt-BR"),
    action: actionId,
    result: `${result.status}: ${result.message}`,
  });
  if (recentCorrectionsLog.length > 50) recentCorrectionsLog.length = 50;
  console.log(`[ACTION] ${actionId} => ${result.status}`);
  return result;
}

/**
 * Executa o ciclo completo de monitoramento contínuo (Heartbeat & Anomaly Detection)
 */
export async function runSystemHealthCheck(): Promise<OperatorSystemReport> {
  moveOperatorState("CHECKING", "Início de health check periódico ou manual.");
  const now = new Date().toISOString();
  const timeStr = new Date().toLocaleTimeString("pt-BR");
  lastCheckTimestamp = timeStr;
  
  const nextDate = new Date(Date.now() + CONFIG.checkIntervalMs);
  nextCheckTimestamp = nextDate.toLocaleTimeString("pt-BR");

  const components: Record<string, ComponentHealth> = {};

  // 1. Backend: endpoint canônico responde com coleção válida.
  const t0Backend = Date.now();
  try {
    const backendJson = await fetchJsonWithTimeout(BACKEND_PRODUCTS_URL);
    const backendProducts = backendJson.products || backendJson.data || backendJson;
    if (!Array.isArray(backendProducts)) throw new Error("Resposta não contém coleção de produtos.");
    components["Backend"] = {
      name: "Backend",
      status: "HEALTHY",
      latencyMs: Date.now() - t0Backend,
      timestamp: now,
      details: `API respondeu ${backendProducts.length} produtos.`,
    };
  } catch (err: any) {
    components["Backend"] = {
      name: "Backend",
      status: "DOWN",
      latencyMs: Date.now() - t0Backend,
      timestamp: now,
      error: err?.message || "Endpoint de backend indisponível.",
    };
  }

  // 2. Supabase
  const t0Supabase = Date.now();
  try {
    if (!supabase) throw new Error("Cliente Supabase não inicializado.");
    const { error } = await supabase.from("products").select("id").limit(1);
    const latency = Date.now() - t0Supabase;
    if (error) throw error;
    components["Supabase"] = {
      name: "Supabase",
      status: latency > 4000 ? "DEGRADED" : "HEALTHY",
      latencyMs: latency,
      timestamp: now
    };
  } catch (err: any) {
    components["Supabase"] = {
      name: "Supabase",
      status: "DOWN",
      latencyMs: Date.now() - t0Supabase,
      timestamp: now,
      error: err?.message || String(err)
    };
  }

  // 3. Produtos: fonte canônica e integridade mínima.
  let canonicalProducts: any[] = [];
  const t0Products = Date.now();
  try {
    canonicalProducts = await getProducts();
    const invalidProducts = canonicalProducts.filter(product => !product.id || !product.produto || !product.link);
    components["Produtos"] = {
      name: "Produtos",
      status: canonicalProducts.length > 0 && invalidProducts.length === 0 ? "HEALTHY" : "DEGRADED",
      latencyMs: Date.now() - t0Products,
      timestamp: now,
      details: `${canonicalProducts.length} produtos canônicos; ${invalidProducts.length} inválidos.`,
    };
  } catch (err: any) {
    components["Produtos"] = {
      name: "Produtos",
      status: "DOWN",
      latencyMs: Date.now() - t0Products,
      timestamp: now,
      error: err?.message || "Consulta de produtos falhou.",
    };
  }

  // 4. Catálogo: projeção pública versus produtos canônicos, sem modificar arquivo algum.
  const t0Catalog = Date.now();
  try {
    const staticCatalog = await fetchJsonWithTimeout(STATIC_CATALOG_URL);
    if (!Array.isArray(staticCatalog) || staticCatalog.length === 0) throw new Error("products.json ausente, vazio ou inválido.");
    const canonicalActive = canonicalProducts.filter(product => product.ativo !== false && product.status !== "pending");
    const jsonIds = new Set(staticCatalog.map((product: any) => product.id));
    const missing = canonicalActive.filter(product => !jsonIds.has(product.id));
    const invalidIdentity = staticCatalog.some((product: any) => !product.id || !product.slug || !product.produto || !product.link);
    components["Catálogo"] = {
      name: "Catálogo",
      status: missing.length === 0 && !invalidIdentity ? "HEALTHY" : "DEGRADED",
      latencyMs: Date.now() - t0Catalog,
      timestamp: now,
      details: `${staticCatalog.length}/${canonicalActive.length} produtos projetados; ${missing.length} ausentes.`,
    };
  } catch (err: any) {
    components["Catálogo"] = {
      name: "Catálogo",
      status: "DOWN",
      latencyMs: Date.now() - t0Catalog,
      timestamp: now,
      error: err?.message || String(err)
    };
  }

  // 4. Lifecycle: observação das propostas processadas nesta instância, sem atuar sobre produtos.
  const t0Lifecycle = Date.now();
  const lifecycle = getProductPipelineTelemetry();
  components["Lifecycle"] = {
    name: "Lifecycle",
    status: lifecycle.errors > 0 || lifecycle.pendingApproval > 25 ? "DEGRADED" : "HEALTHY",
    latencyMs: Date.now() - t0Lifecycle,
    timestamp: now,
    details: `${lifecycle.pendingApproval} aguardando aprovação; ${lifecycle.errors} com erro; ${lifecycle.published} publicados no ciclo atual.`,
  };

  // 5. Tracking
  components["Tracking"] = {
    name: "Tracking",
    status: "HEALTHY",
    latencyMs: 4,
    timestamp: now
  };

  // 6. Analytics
  const t0Analytics = Date.now();
  try {
    if (!supabase) throw new Error("Supabase inativo");
    const { error } = await supabase.from("product_clicks").select("id").limit(1);
    const latency = Date.now() - t0Analytics;
    if (error) throw error;
    components["Analytics"] = {
      name: "Analytics",
      status: "HEALTHY",
      latencyMs: latency,
      timestamp: now
    };
  } catch (err: any) {
    components["Analytics"] = {
      name: "Analytics",
      status: "DEGRADED",
      latencyMs: Date.now() - t0Analytics,
      timestamp: now,
      error: err?.message
    };
  }

  // 7. Telegram: API acessível, mantendo o token estritamente no servidor.
  const t0Telegram = Date.now();
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("Token não configurado.");
    const telegramInfo = await fetchJsonWithTimeout(`https://api.telegram.org/bot${token}/getMe`);
    if (!telegramInfo.ok) throw new Error("API do bot recusou a verificação.");
    components["Telegram"] = {
      name: "Telegram",
      status: "HEALTHY",
      latencyMs: Date.now() - t0Telegram,
      timestamp: now,
      details: "API do bot respondeu ao health check.",
    };
  } catch {
    components["Telegram"] = {
      name: "Telegram",
      status: "DEGRADED",
      latencyMs: Date.now() - t0Telegram,
      timestamp: now,
      error: "API Telegram indisponível ou não configurada.",
    };
  }

  // 8. Site e deploy: conteúdo público mínimo disponível.
  const t0Site = Date.now();
  try {
    const staticCatalog = await fetchJsonWithTimeout(STATIC_CATALOG_URL);
    const healthyPublicCatalog = Array.isArray(staticCatalog) && staticCatalog.length > 0;
    const latency = Date.now() - t0Site;
    components["Site"] = {
      name: "Site",
      status: healthyPublicCatalog ? "HEALTHY" : "DEGRADED",
      latencyMs: latency,
      timestamp: now,
      details: healthyPublicCatalog ? `${staticCatalog.length} produtos públicos.` : "Catálogo público inválido.",
    };
    components["Deploy"] = {
      name: "Deploy",
      status: healthyPublicCatalog ? "HEALTHY" : "DEGRADED",
      latencyMs: latency,
      timestamp: now,
      details: "Projeção pública do Static Site disponível.",
    };
  } catch (err: any) {
    components["Site"] = {
      name: "Site",
      status: "DEGRADED",
      latencyMs: Date.now() - t0Site,
      timestamp: now,
      error: "Falha ao alcançar site estático"
    };
    components["Deploy"] = {
      name: "Deploy",
      status: "UNKNOWN",
      latencyMs: Date.now() - t0Site,
      timestamp: now
    };
  }

  // 9. GitHub: branch main acessível e versão conhecida, sem escrita remota.
  const t0GitHub = Date.now();
  try {
    const branch = await fetchJsonWithTimeout(GITHUB_MAIN_URL);
    const sha = branch?.commit?.sha;
    if (!sha) throw new Error("SHA da branch main indisponível.");
    components["GitHub"] = {
      name: "GitHub",
      status: "HEALTHY",
      latencyMs: Date.now() - t0GitHub,
      timestamp: now,
      version: sha.slice(0, 7),
      details: "Branch main acessível.",
    };
  } catch {
    components["GitHub"] = {
      name: "GitHub",
      status: "UNKNOWN",
      latencyMs: Date.now() - t0GitHub,
      timestamp: now,
      error: "Não foi possível verificar a branch main.",
    };
  }

  // Registrar histórico e limitar retenção
  for (const [compName, comp] of Object.entries(components)) {
    healthHistory.unshift({
      timestamp: timeStr,
      component: compName,
      status: comp.status,
      latencyMs: comp.latencyMs,
      error: comp.error
    });
  }
  if (healthHistory.length > CONFIG.maxHistoryRecords) {
    healthHistory = healthHistory.slice(0, CONFIG.maxHistoryRecords);
  }

  // Calcular status global determinístico
  let overallStatus: HealthStatus = "HEALTHY";
  const statuses = Object.values(components).map(c => c.status);
  if (statuses.includes("DOWN")) {
    overallStatus = "DOWN";
  } else if (statuses.includes("DEGRADED") || statuses.includes("UNKNOWN")) {
    overallStatus = "DEGRADED";
  }

  moveOperatorState("DIAGNOSING", "Health check concluído; analisando anomalias e incidentes.");

  // Gerenciamento de Incidentes, Deduplicação por Fingerprint e Recovery Detection
  const currentlyDownOrDegraded = Object.entries(components).filter(([_, c]) => c.status === "DOWN" || c.status === "DEGRADED");
  const currentDownNames = new Set(currentlyDownOrDegraded.map(([name]) => name));

  // Verificar incidentes abertos para detectar recuperação (Recovery Detection)
  for (const inc of incidents) {
    if (inc.status === "OPEN" || inc.status === "INVESTIGATING") {
      if (!currentDownNames.has(inc.component)) {
        // O componente se recuperou!
        inc.status = "RESOLVED";
        inc.recoveredAt = timeStr;
        const startMs = new Date(`${new Date().toDateString()} ${inc.timestamp}`).getTime();
        inc.durationMs = !isNaN(startMs) ? Date.now() - startMs : 0;
        console.log(`[RECOVERY] Componente ${inc.component} recuperado com sucesso. Incidente ${inc.id} resolvido.`);
      }
    }
  }

  // Registrar novos incidentes com Deduplicação (Fingerprint) e padrão de falha persistente
  for (const [compName, comp] of currentlyDownOrDegraded) {
    consecutiveFailures[compName] = (consecutiveFailures[compName] || 0) + 1;
    const isPersistent = consecutiveFailures[compName] >= CONFIG.failureThresholdForError;
    const severity: IncidentSeverity = isPersistent ? "ERROR" : "WARNING";
    const fingerprint = `${compName}_${comp.status}_${comp.error || 'general'}`;

    const existingOpen = incidents.find(i => i.fingerprint === fingerprint && (i.status === "OPEN" || i.status === "INVESTIGATING"));
    if (!existingOpen) {
      const newInc: Incident = {
        id: `INC-${Date.now().toString().slice(-4)}`,
        fingerprint,
        type: `${compName}_${comp.status}`,
        severity,
        component: compName,
        detection: `Health check detectou status ${comp.status} (${consecutiveFailures[compName]}ª falha consecutiva)`,
        diagnosis: comp.error || "Degradação ou indisponibilidade de conexão",
        status: "OPEN",
        actionTaken: "Nenhuma (Monitorando falha)",
        result: "Pendente",
        timestamp: timeStr
      };
      incidents.unshift(newInc);
      if (incidents.length > CONFIG.maxIncidents) {
        incidents = incidents.slice(0, CONFIG.maxIncidents);
      }
      console.warn(`[INCIDENT] Novo incidente aberto: ${newInc.id} em ${compName} [${severity}]`);
      const suggestedAction = suggestedActionFor(compName);
      const action = suggestedAction ? AVAILABLE_OPERATOR_ACTIONS.find(item => item.id === suggestedAction) : undefined;
      const decision = decideRecovery({
        mode: currentMode,
        risk: action?.risk,
        hasRegisteredAction: Boolean(action),
        requiresApproval: action?.requiresApproval,
        circuitOpen: false,
        consecutiveFailures: consecutiveFailures[compName],
        maxFailures: CONFIG.failureThresholdForError,
      });

      if (decision === "AUTO_HEAL" && suggestedAction) {
        newInc.status = "AUTO_FIXING";
        void runSafeAutoHeal(suggestedAction, {
          incidentId: newInc.id,
          incidentFingerprint: newInc.fingerprint,
          actor: "CERBERUS",
        });
      } else if (decision === "WAIT_APPROVAL") {
        newInc.status = "REQUIRES_APPROVAL";
        newInc.actionTaken = suggestedAction || "Nenhuma ação autorizada";
        newInc.result = "Ação requer aprovação administrativa explícita.";
        moveOperatorState("WAITING_APPROVAL", `Incidente ${newInc.id} aguarda aprovação.`);
      } else if (decision === "ESCALATE") {
        newInc.status = "ESCALATED";
        newInc.result = "Sem ação segura disponível, falhas persistentes ou risco elevado. Escalado ao administrador.";
        operationalStateStore.markEscalated();
        moveOperatorState("ESCALATED", `Incidente ${newInc.id} não pode ser corrigido com segurança.`);
        console.warn(`[ESCALATION] ${newInc.id} escalado: ${newInc.result}`);
      }
    }
  }

  // Zerar contador de falhas para componentes saudáveis
  for (const compName of Object.keys(components)) {
    if (components[compName].status === "HEALTHY") {
      consecutiveFailures[compName] = 0;
    }
  }

  const activeIncidents = incidents.filter(i => ["OPEN", "INVESTIGATING", "AUTO_FIXING", "REQUIRES_APPROVAL", "ESCALATED"].includes(i.status));
  const incidentsByComponent = Object.fromEntries(activeIncidents.map(incident => [incident.component, incident.id]));
  const stateTransition = moveOperatorState(activeIncidents.length === 0 ? "RESOLVED" : operatorStateMachine.getState(), activeIncidents.length === 0 ? "Nenhuma anomalia ativa após diagnóstico." : "Estado operacional atualizado.");
  operationalStateStore.update(
    Object.values(components).map(component => ({
      name: component.name,
      status: component.status,
      timestamp: component.timestamp,
      latencyMs: component.latencyMs,
      error: component.error,
    })),
    incidentsByComponent,
    stateTransition,
  );
  const operationalState = getOperationalState();

  const report: OperatorSystemReport = {
    overallStatus,
    mode: currentMode,
    components,
    activeIncidentsCount: activeIncidents.length,
    recentCorrectionsCount: recentCorrectionsLog.length,
    lastCheckAt: lastCheckTimestamp,
    nextCheckAt: nextCheckTimestamp,
    autonomyLevel: operationalState.autonomyLevel,
    operatorState: operationalState.operatorState,
    escalationCount: operationalState.escalations,
  };

  lastReportCache = report;
  return report;
}

export function getLastReport(): OperatorSystemReport | null {
  return lastReportCache;
}

/**
 * Inicializa o Scheduler em background para monitoramento contínuo
 */
export function startOperatorScheduler(): void {
  if (schedulerTimer) return;
  console.log(`[OPERATOR SCHEDULER] Iniciando monitoramento contínuo a cada ${CONFIG.checkIntervalMs / 60000} minutos...`);
  schedulerTimer = setInterval(async () => {
    try {
      console.log("[OPERATOR HEARTBEAT] Executando verificação periódica agendada...");
      await runSystemHealthCheck();
    } catch (err) {
      console.error("[OPERATOR SCHEDULER] Erro no ciclo de verificação:", err);
    }
  }, CONFIG.checkIntervalMs);
}

export function stopOperatorScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}
