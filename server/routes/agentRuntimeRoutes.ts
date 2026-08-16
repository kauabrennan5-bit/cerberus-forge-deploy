/**
 * Bloco 16 — Fase D — Superfície administrativa do Agent Runtime.
 *
 * PORTAS ÚNICAS de invocação do runtime em produção:
 *   POST /api/agent-runtime/execute      — submete uma execução governada;
 *   POST /api/agent-runtime/approve      — cria/revoga aprovação oficial;
 *   GET  /api/agent-runtime/executions   — journal read-only.
 *
 * Todas admin-only (requireAdminAuth + rate limit herdado de server.ts).
 *
 * Fronteiras preservadas:
 *   AGENT != AUTHORITY · POLICY != EXECUTION · ALLOW != EXECUTION
 *   EXECUTOR != AUTHORITY · REQUIRES_APPROVAL != APPROVAL
 *
 * Nenhuma rota write cria agentes, habilita agentes, conecta executores
 * reais ou executa ações comerciais. O executor só executa na ROTA DE
 * PROVA (executeProof=true, EXPLICITAMENTE IDENTIFICADO), e o resultado
 * é gravado como EXECUTED no journal para demonstrar o loop fechado.
 *
 * POLICY != EXECUTION: toda aprovação exige RE-AVALIAÇÃO da política
 * antes de qualquer execução; sem re-avaliação, nada executa.
 */

import type { Express, Request, Response } from "express";
import { executeRuntime } from "../agentRuntime/runtime";
import {
  APPROVAL_TTL_MS,
  InMemoryApprovalStore,
  OfficialApprovalProvider,
  type ApprovalStore,
  type RuntimeApproval,
} from "../agentRuntime/approvalPersisted";
import {
  getAgentExecutionClientState,
  insertExecution,
  listExecutions,
  updateExecutionState,
  validateExecutionRecord,
  type ExecutionInsertInput,
  type ExecutionWriteResult,
} from "../repositories/agentExecutionsRepository";
import { evaluatePolicy } from "../policyEngine/policyEngine";
import type { PolicyDecision } from "../policyEngine/types";
import { RUNTIME_VERSION } from "../agentRuntime/runtime";

// ============================================================================
// Estado global oficial (admin-only; TEST-ONLY via setApprovalStoreForTests)
// ============================================================================
let officialApprovalStore: ApprovalStore = new InMemoryApprovalStore();
/** TEST-ONLY: substituir o store oficial por um controlado. */
export function setApprovalStoreForTests(store: ApprovalStore | null): void {
  officialApprovalStore = store ?? new InMemoryApprovalStore();
}

// Prova viva de loop fechado: somente para a rota de PROVA explícita.
// NUNCA usado por requisições de agente em produção.
function proofExecutor(input: unknown): { success: true; reference: string } {
  return { success: true, reference: "proof-executed-explicit-admin-test" };
}

interface RuntimeRouteDeps {
  app: Express;
  requireAdminAuth: (req: Request, res: Response, next: () => void) => void;
}

/** Registra as rotas administrativas do runtime (chamado uma vez em server.ts). */
export function registerAgentRuntimeRoutes(deps: RuntimeRouteDeps): void {
  const { app, requireAdminAuth } = deps;

  // ------------------------------------------------------------------
  // POST /api/agent-runtime/execute
  // Submete uma execução governada (admin-only, sem efeitos comerciais).
  // ------------------------------------------------------------------
  app.post("/api/agent-runtime/execute", requireAdminAuth, async (req, res) => {
    try {
      const body = req.body ?? {};
      const request = {
        agentId: String(body.agentId ?? ""),
        agentVersion: String(body.agentVersion ?? "1.0"),
        requestId: String(body.requestId ?? `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
        requestedTool: String(body.tool ?? body.requestedTool ?? ""),
        requestedAction: String(body.action ?? body.requestedAction ?? ""),
        targetTable: body.targetTable ? (String(body.targetTable) as never) : undefined,
        targetType: (String(body.targetType ?? "NONE") as never),
        targetId: body.targetId !== undefined ? String(body.targetId) : "",
        inputReference: String(body.inputReference ?? ""),
        correlationId: body.correlationId ? String(body.correlationId) : "",
        idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        requestedAt: new Date().toISOString(),
        requestedBy: (body.requestedBy === "operator-admin" ? "operator-admin" : "operator") as never,
        approvalContext: {
          requiresApproval: Boolean(body.approvalContext?.requiresApproval ?? false),
          approvalId: body.approvalContext?.approvalId ? String(body.approvalContext.approvalId) : null,
        },
        riskContext: {
          requestedRisk: (body.riskContext?.requestedRisk ?? "LOW") as never,
          // riskFloor:null = sem piso obrigatório (contrato da Fase C); a
          // política compara requestedRisk contra o max_risk do agente.
          riskFloor: (body.riskContext?.riskFloor === null || body.riskContext?.riskFloor === undefined
            ? null
            : body.riskContext.riskFloor) as never,
        },
        // Budget contract fechado da Fase C: valores numéricos >= 0; 0 =
        // orçamento não alocado → BUDGET_UNALLOCATED (fail-closed, deny).
        budgetContext: body.budgetContext ?? {
          tokenBudget: 0,
          timeBudgetMs: 0,
          toolCallBudget: 0,
          costBudget: 0,
        },
        memoryScope: Array.isArray(body.memoryScope) ? (body.memoryScope.map(String) as never) : (["NONE"] as never),
      };

      const nowIso = () => new Date().toISOString();
      const result = await executeRuntime(request as never, {
        deps: {
          evaluatePolicy: evaluatePolicy,
          clock: nowIso,
        },
      });

      const payload = buildExecutionPayload(request, result);
      const writeResult = await persistExecution(payload);

      // Loop pós-aprovação: REQUIRES_APPROVAL → approval oficial →
      // re-avaliação da política → execução. O executor só executa para a
      // ROTA DE PROVA explícita (executeProof=true).
      if (result.decision === "REQUIRES_APPROVAL" && result.executionId && body.executeProof === true) {
        const proofResponse = await handleProofExecution(request, result, writeResult, nowIso);
        if (proofResponse.ok) {
          return res.json({
            success: true,
            mode: "proof",
            execution: proofResponse.execution,
            journal: proofResponse.journalOutcome,
          });
        }
        return res.json({
          success: true,
          decision: result.decision,
          lifecycleState: result.lifecycleState,
          reason: `Aprovação não localizada ou inválida para a prova: ${proofResponse.error ?? "approval não encontrada"}`,
          reasonCode: "PROOF_APPROVAL_INVALID",
          deterministic: true,
        });
      }

      return res.json({
        success: true,
        executionId: result.executionId,
        intentionKey: result.intentionKey,
        decision: result.decision,
        reasonCode: result.reasonCode,
        lifecycleState: result.lifecycleState,
        executorStatus: result.executorStatus,
        deterministic: result.deterministic,
        persisted: writeResult.journalFailure ? false : true,
        policyVersion: result.policyEvaluation?.policyVersion ?? null,
        evaluationId: result.policyEvaluation?.evaluationId ?? null,
        runtimeVersion: RUNTIME_VERSION,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "erro desconhecido";
      return res.status(500).json({
        success: false,
        error: "AGENT_RUNTIME_ROUTE_ERROR",
        detail: message,
        deterministic: true,
      });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/agent-runtime/approve
  // Cria uma aprovação OFICIAL para uma execução registrada (admin-only).
  // NUNCA executa; só registra a intenção de aprovação. A execução real
  // só acontece por re-submissão com executeProof=true e re-avaliação.
  // ------------------------------------------------------------------
  app.post("/api/agent-runtime/approve", requireAdminAuth, async (req, res) => {
    try {
      const body = req.body ?? {};
      if (!body.executionId) {
        return res.status(400).json({ success: false, error: "executionId ausente" });
      }
      const executionId = String(body.executionId);
      // Busca o registro oficial no journal (fonte da verdade).
      const lookup = await listExecutions({ executionId });
      if (!lookup.success || !lookup.executions?.[0]) {
        return res.status(404).json({ success: false, error: "EXECUTION_NOT_FOUND" });
      }
      const execution = lookup.executions[0];
      if (execution.decision !== "REQUIRES_APPROVAL") {
        return res.status(409).json({
          success: false,
          error: "APPROVAL_NOT_REQUIRED_FOR_THIS_EXECUTION",
          detail: `decision=${execution.decision}; approval só é criada para REQUIRES_APPROVAL.`,
        });
      }
      const created = await officialApprovalStore.create({
        executionId,
        intentionKey: execution.intention_key,
        agentId: execution.agent_id,
        agentVersion: execution.agent_version,
        policyVersion: execution.policy_version,
        tool: execution.tool,
        action: execution.action,
        risk: execution.risk,
        evaluationId: execution.evaluation_id ?? "",
        approvedBy: "operator-admin",
        approvedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
        correlationId: execution.correlation_id,
      });
      if (created.outcome !== "created") {
        return res.status(409).json({ success: false, error: `APPROVAL_${created.outcome.toUpperCase()}` });
      }
      return res.json({
        success: true,
        approval: {
          approvalId: created.approval!.approvalId,
          executionId: created.approval!.executionId,
          intentionKey: created.approval!.intentionKey,
          expiresAt: created.approval!.expiresAt,
        },
        note: "Aprovação registrada. A execução real exige re-submissão do execute com re-avaliação da política (POLICY != EXECUTION).",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "erro desconhecido";
      return res.status(500).json({ success: false, error: "APPROVAL_ROUTE_ERROR", detail: message });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/agent-runtime/executions  (journal read-only)
  // ------------------------------------------------------------------
  app.get("/api/agent-runtime/executions", requireAdminAuth, async (req, res) => {
    try {
      const query = req.query ?? {};
      const params = {
        executionId: query.executionId ? String(query.executionId) : undefined,
        intentionKey: query.intentionKey ? String(query.intentionKey) : undefined,
        decision: query.decision ? String(query.decision) : undefined,
        lifecycleState: query.lifecycleState ? String(query.lifecycleState) : undefined,
        page: query.page ? Math.max(1, Math.min(Number(query.page) || 1, 100)) : 1,
        pageSize: query.pageSize
          ? Math.max(1, Math.min(Number(query.pageSize) || 20, 100))
          : 20,
      };
      const result = await listExecutions(params);
      if (!result.success) {
        return res.status(500).json({ success: false, error: "JOURNAL_QUERY_ERROR", detail: result.error });
      }
      return res.json({
        success: true,
        executions: result.executions ?? [],
        total: result.total ?? 0,
        page: params.page,
        pageSize: params.pageSize,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "erro desconhecido";
      return res.status(500).json({ success: false, error: "JOURNAL_ROUTE_ERROR", detail: message });
    }
  });
}

// ============================================================================
// Helpers internos
// ============================================================================

import type { AgentRuntimeRequest, RuntimeResult } from "../agentRuntime/contracts";
import type { ExecutionPlan } from "../agentRuntime/contracts";

interface RuntimeResultLike {
  executionId: string;
  intentionKey: string;
  decision: "ALLOW" | "DENY" | "REQUIRES_APPROVAL";
  lifecycleState: string;
  policyEvaluation: {
    evaluationId: string;
    policyVersion: string;
    agentVersion: string;
    tool: string;
    action: string;
    risk: string;
  } | null;
  executionPlan: ExecutionPlan | null;
  executorStatus: "NOT_CONNECTED" | "SKIPPED" | "EXECUTED";
  deterministic: boolean;
}

interface ExecutionRequestLike {
  agentId: string;
  agentVersion: string;
  requestId: string;
  requestedTool: string;
  requestedAction: string;
  targetTable?: string;
  targetType: string;
  targetId?: string;
  inputReference: string;
  correlationId?: string;
  requestedBy: string;
  riskContext: { requestedRisk: string };
  idempotencyKey: string;
}

function buildExecutionPayload(
  request: ExecutionRequestLike,
  result: RuntimeResultLike
): ExecutionInsertInput {
  const decision = result.decision;
  const policyVersion = result.policyEvaluation?.policyVersion ?? "unknown";
  return {
    executionId: result.executionId,
    intentionKey: result.intentionKey,
    agentId: request.agentId,
    agentVersion: request.agentVersion,
    policyVersion,
    runtimeVersion: RUNTIME_VERSION,
    tool: String(result.executionPlan?.tool ?? request.requestedTool),
    action: String(result.executionPlan?.action ?? request.requestedAction),
    risk: String(result.executionPlan?.risk ?? request.riskContext.requestedRisk),
    // O ExecutionPlan não armazena o alvo; a tabela canônica derivada pela
    // pipeline está no request declarativo desta rota (mesma derivada).
    targetTable: String(request.targetTable ?? "products"),
    targetType: String(request.targetType ?? "NONE"),
    targetId: request.targetId ? String(request.targetId) : null,
    decision,
    reasonCode: "POLICY_DECISION",
    approvalState: decision === "REQUIRES_APPROVAL" ? "PENDING" : decision === "ALLOW" ? "NOT_REQUIRED" : "NONE",
    approvalId: null,
    lifecycleState: result.lifecycleState,
    inputFingerprint: `${request.inputReference.length}-${request.inputReference.replace(/\s/g, "_").slice(0, 12)}`,
    inputReference: request.inputReference,
    identityContextDigest: `${request.requestedTool}|${request.requestedAction}|${request.agentId}|${request.agentVersion}`,
    executorStatus: result.executorStatus,
    correlationId: request.correlationId ?? null,
    requestId: request.requestId,
    requestedBy: request.requestedBy,
    evaluationId: result.policyEvaluation?.evaluationId ?? null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    metadata: { route: "agent-runtime/execute", deterministic: result.deterministic },
  };
}

async function persistExecution(payload: ExecutionInsertInput): Promise<ExecutionWriteResult> {
  const clientState = getAgentExecutionClientState();
  if (!clientState.configured) {
    return {
      outcome: "missing_supabase",
      error: "Execution journal client não configurado; execução não persistida (fail-closed explícito).",
      journalFailure: true,
    };
  }
  const validation = validateExecutionRecord({
    decision: payload.decision,
    lifecycleState: payload.lifecycleState,
    executorStatus: payload.executorStatus,
    risk: payload.risk,
    requestedBy: payload.requestedBy,
  });
  if (validation.valid === false) {
    return { outcome: "conflict_rejected", error: validation.error, journalFailure: true };
  }
  return insertExecution(payload);
}

/**
 * Rota de prova controlada: REQUIRES_APPROVAL + executeProof=true.
 * Re-avalia a política contra o estado atual; com aprovação oficial válida,
 * executa o proof executor (identificado explicitamente) e atualiza o
 * journal. NUNCA executa executor real.
 */
async function handleProofExecution(
  request: ExecutionRequestLike,
  result: RuntimeResultLike,
  writeResult: ExecutionWriteResult,
  nowIso: () => string
): Promise<{
  ok: boolean;
  error?: string;
  execution?: Record<string, unknown>;
  journalOutcome?: string;
}> {
  if (!result.executionId || !result.executionPlan) {
    return { ok: false, error: "PROOF_PLAN_UNAVAILABLE" };
  }
  // Re-avaliação obrigatória da política (POLICY_CHANGED → DENY).
  const reDecision: PolicyDecision = evaluatePolicy({
    agentId: request.agentId,
    agentVersion: request.agentVersion,
    policyVersion: result.policyEvaluation?.policyVersion ?? "unknown",
    tool: String(result.executionPlan.tool),
    action: String(result.executionPlan.action),
    targetTable: String(request.targetTable ?? "products"),
    risk: String(result.executionPlan.risk),
    memoryScope: "NONE",
    context: request.inputReference,
  });
  if (reDecision.decision !== "ALLOW") {
    return {
      ok: false,
      error: `RE-AVALIAÇÃO NEGADA: policy agora decide ${reDecision.decision} (${reDecision.reasonCode})`,
    };
  }
  // Provider oficial escopo: resolve contra o ApprovalStore com os dados
  // reais da execução (não o approvalId declarado pelo agente).
  const provider = new OfficialApprovalProvider(officialApprovalStore, {
    intentionKey: result.intentionKey,
    executionId: result.executionId,
    policyVersion: result.policyEvaluation?.policyVersion ?? "unknown",
    clock: nowIso,
  });
  const approvalState = await provider.resolve({
    requiresApproval: true,
    approvalId: null,
  });
  if (approvalState !== "APPROVED") {
    return { ok: false, error: `APROVAÇÃO NÃO VÁLIDA: ${approvalState}` };
  }
  // Prova controlada: executa APENAS o proof executor identificado.
  const proof = proofExecutor({ intentionKey: result.intentionKey });
  const startedAt = new Date().toISOString();
  const updateResult = await updateExecutionState(result.executionId, {
    lifecycleState: "SUCCEEDED",
    executorStatus: "EXECUTED",
    executorAdapterVersion: "proof-1.0",
    resultReference: proof.reference,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
  return {
    ok: true,
    execution: {
      executionId: result.executionId,
      intentionKey: result.intentionKey,
      lifecycleState: "SUCCEEDED",
      executorStatus: "EXECUTED",
      executorAdapterVersion: "proof-1.0",
      resultReference: proof.reference,
      decision: "ALLOW",
      reEvaluated: true,
      proofMode: true,
    },
    journalOutcome: updateResult.outcome,
  };
}
