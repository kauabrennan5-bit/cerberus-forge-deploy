/**
 * Cerberus Finds Archive — Bloco 17 — Cockpit Comercial (render-only).
 *
 * Fronteiras: EXPERIMENT != EXECUTION · DECISION != ACTION
 *             MEMORY != AUTHORITY · RECOMMENDATION != ACTION
 *             SIGNAL != REVENUE · OBSERVATION != FACT CANÔNICO
 *
 * REGRA MÃE: este serviço NUNCA executa nada. Ele apenas LÊ estado e
 * FORMATA texto para exibição no Telegram. Não altera produtos, não
 * publica, não executa Telegram, não executa agentes, não executa
 * executores, não cria experimentos, não grava decisões.
 *
 * Cores (🟢/🟡/🔴) SEMPRE vinculadas a regra objetiva:
 *   🟢 = regra objetivamente satisfeita (documentada no comentário).
 *   🟡 = regra parcialmente satisfeita ou ausência de dados (nunca
 *        transformada em fato negativo: "sem dados" != "ruim").
 *   🔴 = regra objetivamente violada (com a violação documentada).
 *
 * Toda recomendação exibida é marcada como "SUGESTÃO".
 */

import * as productsRepository from "../repositories/productsRepository";
import * as experimentRepository from "../repositories/experimentRepository";
import {
  getArtifactsByPeriod,
  getArtifactsByType,
  type StoredArtifact,
} from "../repositories/commercialBrainRepository";
import * as cerberusOperator from "./cerberusOperator";
import { listAgents } from "../agentRegistry/agents";
import {
  listCandidateEvidence,
  listResearchSessions,
} from "../repositories/candidateEvidenceRepository";
import { listCandidateAssessments } from "../repositories/candidateAssessmentRepository";
import { deriveMinSampleSize, deriveConfidenceV2, DEFAULT_FDR } from "../commercialBrain/statisticalRigor";
import type { SignalConfidence } from "../commercialBrain/types";

const WINDOW_LABELS: Record<string, string> = {
  "1d": "últimas 24h",
  "7d": "últimos 7 dias",
  "30d": "últimos 30 dias",
};

function clamp<T extends string>(value: string | undefined | null, fallback: T, allowed: readonly T[]): T {
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  return fallback;
}

/** Janela temporal da leitura (padrão 7d), explicitada na saída. */
export function parseWindow(raw?: string): { window: string; label: string } {
  const allowed = ["1d", "7d", "30d"] as const;
  const window = raw ? clamp(raw, "7d", allowed) : "7d";
  return { window, label: WINDOW_LABELS[window] ?? "7d" };
}

function daysInWindow(window: string): number {
  if (window === "1d") return 1;
  if (window === "30d") return 30;
  return 7;
}

/**
 * Formata a base de amostra exigida pelo Bloco 17:
 * cada oportunidade DEVE exibir amostra, baseline, janela, confidence,
 * modelo/versionamento e correção de múltiplas comparações quando
 * houver comparação real entre múltiplos produtos.
 */
interface ClickStats {
  windowClicks: number;
  windowDays: number;
}

async function productClicksWindow(
  productName: string,
  window: string,
): Promise<ClickStats> {
  // Leitura real via productsRepository (produto_clicks). Não cria dado.
  const stats = await productsRepository.getProductAnalytics(productName, window).catch(() => null);
  // getProductAnalytics retorna TODOS os contadores da base; seleciona o
  // contador correspondente à janela pedida (regra: sempre exibir janela).
  const windowClicks = Number(
    window === "1d"
      ? stats?.todayClicks ?? 0
      : window === "30d"
        ? stats?.clicks30d ?? stats?.totalClicks ?? 0
        : stats?.clicks7d ?? stats?.todayClicks ?? 0,
  ) || 0;
  return { windowClicks, windowDays: daysInWindow(window) };
}

/**
 * Confidence do cockpit = confidence_model_v2 (Bloco 17):
 *   gate de amostra mínima (teto LOW) → sobrevivência à correção BH.
 * O cockpit NUNCA exibe a confiança sem a base que a sustenta.
 */
function cockpitConfidence(windowClicks: number, minSample: number, nComparisons: number): {
  confidence: SignalConfidence;
  basis: string;
} {
  const derived = deriveConfidenceV2({
    recordCount: windowClicks,
    minSampleRequired: minSample,
    fdr: DEFAULT_FDR,
  });
  // Correção múltipla: quando há comparação simultânea entre produtos,
  // o teto de confiança desce 1 nível por grupo de m>=2 comparações.
  let level = derived.confidence;
  const basis: string[] = [derived.confidenceBasis];
  if (nComparisons >= 2) {
    const down: SignalConfidence = level === "HIGH" ? "MEDIUM" : level === "MEDIUM" ? "LOW" : "LOW";
    if (down !== level) {
      basis.push(`correção múltipla: teto rebaixado para ${down} (m=${nComparisons} comparações simultâneas)`);
      level = down;
    }
  }
  return { confidence: level, basis: basis.join("; ") };
}

function statusEmoji(ruleSatisfied: boolean | null): "🟢" | "🟡" | "🔴" {
  return ruleSatisfied === true ? "🟢" : ruleSatisfied === false ? "🔴" : "🟡";
}

// ============================================================================
// /opportunities — sinal relativo com base completa
// ============================================================================
export async function renderOpportunities(windowRaw?: string): Promise<string> {
  const { window, label } = parseWindow(windowRaw);
  const ranking = await productsRepository.getProductAnalyticsRanking(window).catch(() => []);
  const top = ranking.slice(0, 5);
  const derived = deriveMinSampleSize();
  const nVariants = top.length;

  const lines: string[] = [];
  lines.push("🎯 <b>OPORTUNIDADES (SINAL RELATIVO)</b>");
  lines.push(`Janela: <b>${label}</b> · Modelo: <b>confidence_model_v2 (${derived.rigorVersion})</b>`);
  lines.push(`Amostra mínima: <b>${derived.nPerVariant.toLocaleString("pt-BR")}</b> por variante · FDR: <b>${DEFAULT_FDR}</b>`);
  if (nVariants >= 2) {
    lines.push(`Correção de múltiplas comparações: <b>BH aplicada (m=${nVariants})</b>.`);
  }
  lines.push("━━━━━━━━━━━━━━━━━━");

  if (top.length === 0) {
    lines.push("🟡 Sem sinais de interesse capturados na janela.");
    lines.push("AUSÊNCIA DE DADOS ≠ FATO NEGATIVO.");
    lines.push("⚠️ Regra objetiva: sem amostra não há confidence acima de LOW.");
    return lines.join("\n");
  }

  let rank = 0;
  for (const item of top) {
    rank++;
    const stats = await productClicksWindow(item.product.produto, window);
    // Confiança derivada do modelo V2: base de amostra + correção múltipla.
    const conf = cockpitConfidence(stats.windowClicks, derived.nPerVariant, nVariants);
    const emoji = statusEmoji(
      stats.windowClicks >= derived.nPerVariant
        ? true
        : stats.windowClicks > 0
          ? null
          : false,
    );
    lines.push(`${emoji} <b>${rank}. ${item.product.produto}</b>`);
    lines.push(`   🛒 ${item.product.categoria} · R$ ${item.product.preco.toFixed(2).replace(".", ",")}`);
    lines.push(`   📈 Cliques (${label}): <b>${stats.windowClicks}</b> · Janela: <b>${stats.windowDays} dia(s)</b>`);
    lines.push(`   🧠 Confidence: <b>${conf.confidence}</b> — ${conf.basis}`);
    if (stats.windowClicks < derived.nPerVariant) {
      lines.push(`   ⚠️ Motivo: amostra abaixo do mínimo (${derived.nPerVariant.toLocaleString("pt-BR")} exigidas).`);
    }
    lines.push("");
  }

  lines.push(`📊 Janela: ${label} (${daysInWindow(window)} dia(s)) · Modelo: v2 (${derived.rigorVersion}) · FDR ${DEFAULT_FDR}`);
  lines.push("🧭 SINAL ≠ RECEITA. Nenhuma ação foi executada.");
  return lines.join("\n");
}

// ============================================================================
// /risks — deterioração, obsolescência, inconsistência, incidentes
// ============================================================================
export async function renderRisks(): Promise<string> {
  const lines: string[] = [];
  lines.push("⚠️ <b>RISCOS E INCONSISTÊNCIAS</b>");
  lines.push("━━━━━━━━━━━━━━━━━━");

  // 1. Incidentes técnicos relevantes (regra objetiva: incidente ATIVO com
  //    descrição explícita — incidente sem descrição é indisponível, não fato)
  const incidents = cerberusOperator.getIncidents();
  const active = incidents
    .filter(inc => (inc as any).resolved !== true && (inc as any).state !== "RESOLVED")
    .filter(inc => Boolean((inc as any).description))
    .slice(0, 5);
  if (active.length > 0) {
    lines.push("🔴 <b>INCIDENTES TÉCNICOS ATIVOS</b> (regra: incidente não resolvido no snapshot operacional)");
    for (const inc of active) {
      lines.push(`   • ${(inc as any).component ?? (inc as any).title ?? "incidente"}: ${(inc as any).description}`);
    }
  } else {
    lines.push("🟡 Nenhum incidente ativo capturado no snapshot operacional.");
    lines.push("   (ausência de registro ≠ ausência de problema — regra de observação)");
  }

  // 2. Artefatos de risco do Bloco 14 (regra: artifact_type=risk e status ACTIVE)
  const riskArtifacts = await getArtifactsByType("risk", 5).catch(() => ({ outcome: "missing_supabase" as const, error: "" }));
  if (riskArtifacts.outcome === "inserted") {
    const records = (riskArtifacts.record ?? []) as StoredArtifact[];
    const activeRisks = records.filter((a) => a.status === "ACTIVE");
    if (activeRisks.length > 0) {
      lines.push("🔴 <b>RISCOS ANALÍTICOS ATIVOS</b> (regra: artifact_status=ACTIVE, persistidos pelo Bloco 14)");
      for (const a of activeRisks.slice(0, 5)) {
        lines.push(`   • ${a.subject} — ${a.suggested_action || "sem ação sugerida"} (confidence: ${a.confidence})`);
      }
    } else {
      lines.push("🟡 Nenhum risco analítico com status ACTIVE.");
    }
  } else {
    lines.push("🟡 Artefatos indisponíveis neste momento (sem leitura do repositório analítico).");
  }

  // 3. Observações antigas / estagnação (regra: produto ativo sem clique em 30 dias)
  try {
    const products = await productsRepository.getProducts();
    const active = products.filter(p => p.ativo !== false);
    const ranking30 = await productsRepository.getProductAnalyticsRanking("30d").catch(() => []);
    const clickedNames = new Set(ranking30.map(r => r.product.produto));
    const staleNames = active
      .filter(p => !clickedNames.has(p.produto))
      .map(p => p.produto)
      .slice(0, 5);
    if (staleNames.length > 0) {
      lines.push("🟡 <b>PRODUTOS SEM CLIQUES NA BASE CAPTURADA (30d)</b> (regra: 0 cliques registrados no período observado)");
      for (const name of staleNames) {
        lines.push(`   • ${name}`);
      }
      lines.push("   ⚠️ Ausência de dado capturado ≠ baixa qualidade do produto.");
    } else if (active.length > 0) {
      lines.push("🟢 Todos os produtos ativos possuem pelo menos um clique registrado na base (30d).");
    } else {
      lines.push("🟡 Sem produtos ativos para checagem de estagnação.");
    }
  } catch {
    lines.push("🟡 Catálogo indisponível para checagem de estagnação.");
  }

  lines.push("");
  lines.push("⚠️ Regra: NUNCA transformar ausência de dados em fato negativo.");
  return lines.join("\n");
}

// ============================================================================
// /experiments — estado do Experiment Registry
// ============================================================================
export async function renderExperiments(): Promise<string> {
  const lines: string[] = [];
  lines.push("🧪 <b>EXPERIMENTOS (EXPERIMENT REGISTRY)</b>");
  lines.push("━━━━━━━━━━━━━━━━━━");

  const list = await experimentRepository.listExperiments({ limit: 10 });
  if (!list.success) {
    if (list.missing_supabase) {
      lines.push("🟡 Registry indisponível (cliente Supabase ausente) — fail-closed, nada executado.");
    } else {
      lines.push("🟡 Leitura do registry indisponível neste momento.");
    }
    return lines.join("\n");
  }

  if (list.total === 0) {
    lines.push("🟡 Nenhum experimento registrado no registry.");
    lines.push(`📊 Amostra mínima por variante (derivada): <b>${deriveMinSampleSize().nPerVariant.toLocaleString("pt-BR")}</b> (${deriveMinSampleSize().rigorVersion})`);
    return lines.join("\n");
  }

  for (const record of list.experiments) {
    const emoji = statusEmoji(
      record.sample_size >= record.min_sample_size ? true : record.sample_size > 0 ? null : false,
    );
    lines.push(`${emoji} <b>${record.experiment_id}</b>`);
    lines.push(`   📝 Hipótese: ${record.hypothesis}`);
    lines.push(`   🅰️ A: ${record.variant_a_label} · 🅱️ B: ${record.variant_b_label}`);
    if (record.target_population) lines.push(`   🎯 População: ${record.target_population}`);
    if (record.success_metric) lines.push(`   📏 Métrica: ${record.success_metric}`);
    lines.push(`   📅 Período: ${record.start_date ?? "não iniciado"} → ${record.planned_end_date ?? "não declarado"}`);
    lines.push(`   🔬 Status: <code>${record.status}</code> · Amostra: <b>${record.sample_size}</b> / mínimo <b>${record.min_sample_size.toLocaleString("pt-BR")}</b>`);
    if (record.decision) {
      lines.push(`   ✅ Decisão registrada: <b>${record.decision}</b> (${record.decision_basis ?? "base documentada"})`);
    } else if (record.sample_size >= record.min_sample_size || (record.planned_end_date && new Date(record.planned_end_date).getTime() <= Date.now())) {
      lines.push("   ✅ Amostra/período atingidos — decisão JÁ É PERMITIDA (ainda não registrada).");
    } else {
      lines.push("   ⏳ Decisão AINDA NÃO PERMITIDA (gate estatístico ativo).");
    }
    lines.push("");
  }

  lines.push("🧭 EXPERIMENT != EXECUTION. Nenhuma variante está sendo executada por este comando.");
  return lines.join("\n");
}

// ============================================================================
// /agents — estado REAL do registry (sem inferência operacional)
// ============================================================================
export async function renderAgents(): Promise<string> {
  const lines: string[] = [];
  lines.push("🤖 <b>AGENTES (ESTADO REAL DO REGISTRY)</b>");
  lines.push("━━━━━━━━━━━━━━━━━━");
  lines.push("📏 Regra: exibir SOMENTE o estado declarado no registry. NUNCA inferir estado operacional.");

  for (const agent of listAgents()) {
    const emoji = statusEmoji(agent.enabled ? true : false);
    // Regra: estado REAL do registry — todos os agentes são DRAFT/enabled
    // declarado, e NENHUM executor real está conectado (EXECUTOR_NOT_CONNECTED).
    lines.push(`${emoji} <b>${agent.agentId}</b> v${agent.version} · <code>${agent.status}</code> ${agent.enabled ? "(enabled)" : "(DRAFT/disabled)"}`);
    lines.push(`   ⚙️ Executor: <b>EXECUTOR_NOT_CONNECTED</b> (regra do Bloco 16 — sem executor real)`);
    const tools = agent.allowedTools.slice(0, 4).join(", ");
    lines.push(`   🔧 Ferramentas permitidas: ${tools}${agent.allowedTools.length > 4 ? ` (+${agent.allowedTools.length - 4} mais)` : ""}`);
    lines.push(`   🛡️ Risco máximo: ${agent.maxRisk} · Escopo de memória: ${agent.memoryScope.join(", ") || "nenhum"}`);
    lines.push("");
  }

  lines.push("🧭 AGENT != EXECUTION. Nenhum agente foi executado por este comando.");
  return lines.join("\n");
}

// ============================================================================
// /decisions — somente decisões derivadas de experimentos formalmente concluídos
// ============================================================================
export async function renderDecisions(): Promise<string> {
  const lines: string[] = [];
  lines.push("⚖️ <b>DECISÕES (SOMENTE FORMAIIS DO REGISTRY)</b>");
  lines.push("━━━━━━━━━━━━━━━━━━");
  lines.push("📏 Regra: opinião textual NÃO é decisão. Somente registros do Experiment Registry contam.");

  const decisions = await experimentRepository.listDecisions().catch(() => null);
  if (!decisions || !decisions.success) {
    lines.push("🟡 Leitura do registry indisponível neste momento.");
    return lines.join("\n");
  }
  if (decisions.total === 0) {
    lines.push("🟡 Nenhuma decisão formal registrada.");
    return lines.join("\n");
  }

  for (const record of decisions.experiments) {
    lines.push(`✅ <b>${record.experiment_id}</b> → <b>${record.decision ?? "DECISION_NAO_REGISTRADA"}</b>`);
    if (record.decision_basis) lines.push(`   📜 Base: ${record.decision_basis}`);
    if (record.decided_by) lines.push(`   👤 Registrada por: ${record.decided_by}`);
    lines.push("");
  }

  lines.push("🧭 DECISION != ACTION. Nenhuma decisão foi executada por este comando.");
  return lines.join("\n");
}

// ============================================================================
// /recommendations — sempre marcado como SUGESTÃO
// ============================================================================
export async function renderRecommendations(): Promise<string> {
  const lines: string[] = [];
  lines.push("💡 <b>RECOMENDAÇÕES — TODAS MARCADAS COMO «SUGESTÃO»</b>");
  lines.push("━━━━━━━━━━━━━━━━━━");
  lines.push("📏 Regra: SUGESTÃO ≠ ORDEM. Nenhuma recomendação é executada automaticamente.");

  const window = "30d";
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 86400000).toISOString();
  const artifacts = await getArtifactsByPeriod({ from, to: now.toISOString(), limit: 5 }).catch(() => ({ outcome: "missing_supabase" as const }));
  const records: StoredArtifact[] =
    artifacts.outcome === "inserted" && Array.isArray(artifacts.record)
      ? (artifacts.record as StoredArtifact[])
      : [];

  const recs = records.filter(a => a.artifact_type === "recommendation").slice(0, 5);
  if (recs.length === 0) {
    lines.push("🟡 Nenhuma recomendação persistida nos últimos 30 dias.");
    lines.push("   (ausência de registro ≠ ausência de oportunidade)");
    return lines.join("\n");
  }

  for (const a of recs) {
    const emoji = statusEmoji(a.priority_level === "HIGH" ? true : a.priority_level === "NO_ACTION" ? false : null);
    lines.push(`${emoji} SUGESTÃO: ${a.subject}`);
    lines.push(`   📋 Ação sugerida: ${a.suggested_action || "n/a"}`);
    lines.push(`   🧠 Confidence: <b>${a.confidence}</b> · Prioridade: ${a.priority_level ?? "n/a"}`);
    lines.push(`   🔬 Modelo: ${a.scoring_version} / ${a.confidence_version}`);
    lines.push("");
  }

  lines.push("🧭 RECOMMENDATION != ACTION. Nenhuma recomendação foi executada.");
  return lines.join("\n");
}

// ============================================================================
// /priority — visão executiva consolidada (sem autoridade de execução)
// ============================================================================
export async function renderPriority(): Promise<string> {
  const lines: string[] = [];
  lines.push("🎯 <b>COCKPIT COMERCIAL — VISÃO EXECUTIVA (/priority)</b>");
  lines.push("━━━━━━━━━━━━━━━━━━");

  // Saúde operacional (regra: OperatorSystemReport do Bloco 15)
  try {
    const report = await cerberusOperator.runSystemHealthCheck();
    const operational = cerberusOperator.getOperationalState();
    const healthyCount = Object.values(report.components).filter(c => c.status === "HEALTHY").length;
    const totalCount = Object.keys(report.components).length;
    const overall = statusEmoji(report.overallStatus === "HEALTHY" ? true : report.overallStatus === "DEGRADED" ? null : false);
    lines.push(`${overall} <b>SAÚDE OPERACIONAL</b>: <code>${report.overallStatus}</code> (${healthyCount}/${totalCount} componentes OK)`);
    lines.push(`   🧠 Operator: <code>${operational.operatorState}</code> · Incidentes ativos: <b>${report.activeIncidentsCount}</b>`);
  } catch {
    lines.push("🟡 Saúde operacional indisponível (regra: exibir indisponibilidade, não inferir).");
  }

  // Oportunidade topo (regra: maior cliques na janela, com base exibida)
  try {
    const ranking = await productsRepository.getProductAnalyticsRanking("7d");
    const top = ranking[0];
    if (top) {
      lines.push(`🟢 <b>TOP OPORTUNIDADE</b>: ${top.product.produto} — ${top.count} cliques (7d)`);
    } else {
      lines.push("🟡 Top oportunidade: sem cliques capturados na janela de 7d.");
    }
  } catch {
    lines.push("🟡 Top oportunidade: base de cliques indisponível.");
  }

  // Risco resumo (regra: incidentes ativos = risco real)
  try {
    const incidents = cerberusOperator.getIncidents();
    const active = incidents.filter(inc => (inc as any).resolved !== true && (inc as any).state !== "RESOLVED");
    if (active.length > 0) {
      lines.push(`🔴 <b>PRINCIPAL RISCO</b>: ${active.length} incidente(s) ativo(s) — ver /risks`);
    } else {
      lines.push("🟡 Principal risco: nenhum incidente ativo registrado (ausência ≠ ausência de problema).");
    }
  } catch {
    lines.push("🟡 Principal risco: snapshot operacional indisponível.");
  }

  // Experimentos ativos (regra: status=RUNNING no registry)
  try {
    const experiments = await experimentRepository.listExperiments({ limit: 5 });
    const active = experiments.experiments.filter(e => e.status === "RUNNING");
    if (active.length > 0) {
      const first = active[0];
      lines.push(`🧪 <b>EXPERIMENTOS ATIVOS</b>: ${active.length} — principal: <code>${first.experiment_id}</code> (${first.sample_size}/${first.min_sample_size.toLocaleString("pt-BR")} amostra)`);
    } else {
      lines.push("🟡 Experimentos ativos: nenhum em execução.");
    }
  } catch {
    lines.push("🟡 Experimentos: registry indisponível.");
  }

  // Estado dos agentes (regra: enabled status do registry; executores reais nunca conectados)
  const enabledCount = listAgents().filter(a => a.enabled).length;
  const totalCountAgents = listAgents().length;
  lines.push(`🤖 <b>AGENTES</b>: ${enabledCount}/${totalCountAgents} habilitados no registry (EXECUTOR_NOT_CONNECTED — nenhum executor real).`);

  lines.push("");
  lines.push("🧭 COCKPIT = INFORMAÇÃO, NÃO AUTORIDADE. Nenhum comando executa ação.");
  lines.push("   USE: /opportunities · /risks · /experiments · /agents · /decisions · /recommendations · /discover");
  return lines.join("\n");
}

// ============================================================================
// /discover — funil de candidatos do Bloco N1 (render-only)
// ============================================================================
export async function renderDiscover(): Promise<string> {
  const lines: string[] = [];
  lines.push("🔭 <b>DESCOBERTA — FUNIL DE CANDIDATOS (NÃO CANÔNICOS)</b>");
  lines.push("━━━━━━━━━━━━━━━━━━");
  lines.push("📏 Regra: CANDIDATE != FACT CANÔNICO. Candidato é projeção descoberta; nenhum candidato abaixo é produto publicado.");

  const summary: Array<{ status: string; label: string }> = [];
  let anyRead = false;
  for (const status of ["DISCOVERED", "REVIEWING", "APPROVED", "REJECTED", "INCONCLUSIVE", "WITHDRAWN"] as const) {
    try {
      const list = await import("../repositories/candidatesRepository").then(m => m.listCandidates({ status }));
      anyRead = true;
      const count = list.total;
      const emoji = status === "REJECTED" || status === "INCONCLUSIVE" ? "🔴" : status === "APPROVED" ? "🟢" : "🟡";
      lines.push(`${emoji} <b>${status}</b>: ${count} candidato(s)`);
      summary.push({ status, label: `${status}: ${count}` });
    } catch {
      lines.push("🟡 Funil indisponível neste momento (leitura recusada — nenhuma inferência).");
      return lines.join("\n");
    }
  }

  if (!anyRead) {
    lines.push("🟡 Funil de descoberta indisponível.");
    return lines.join("\n");
  }

  // Top candidates recentes (não aprovados) — sem dados ≠ fato negativo
  try {
    const pending = await import("../repositories/candidatesRepository").then(m =>
      m.listCandidates({ status: "REVIEWING", limit: 3 }),
    );
    if (pending.candidates.length > 0) {
      for (const c of pending.candidates) {
        lines.push(`   🔎 <b>${c.title || c.candidate_id}</b> (${c.marketplace}) — preço observado: ${c.observed_price ?? "n/a"}`);
      }
    } else {
      lines.push("🟡 Nenhum candidato em revisão agora (ausência ≠ rejeição).");
    }
  } catch {
    lines.push("🟡 Lista de revisão indisponível.");
  }

  lines.push("");
  lines.push("🧭 OBSERVATION != FACT CANÔNICO. Nenhum candidato foi promovido ou publicado por este comando.");
  return lines.join("\n");
}

// ============================================================================
// /research — pesquisa + evidência do Bloco N3 (RENDER-ONLY)
// Estado da pesquisa de um candidato: sessões, evidências, UNKNOWNs,
// contradições e qualidade geral. NUNCA executa coleta ou mutação.
// ============================================================================
export async function renderResearch(candidateId?: string): Promise<string> {
  const lines: string[] = [];
  lines.push("🔬 <b>PESQUISA + EVIDÊNCIA — BLOCO N3 (RENDER-ONLY)</b>");
  lines.push("━━━━━━━━━━━━━━━━━━");
  lines.push("📏 Regra: EVIDENCE != FACT CANÔNICO · OBSERVATION != FACT CANÔNICO. RESEARCH != PUBLICATION · RESEARCH != PROMOTION. Nenhuma pesquisa abaixo é produto publicado.");

  if (!candidateId) {
    lines.push("⚠️ Uso: /research &lt;candidate_id&gt; (ex: /research can-abc123...)");
    lines.push("   Para ver o funil geral: /discover");
    return lines.join("\n");
  }

  let sessions: Array<{ evidence_id: string; research_id: string; field_state: string; evidence_note: string; created_at: string; observed_at: string }> = [];
  let evidence: Array<{ evidence_id: string; research_id: string; kind: string; field_name: string | null; field_state: string; field_value: Record<string, unknown> | null; quality: string; evidence_note: string; created_at: string }> = [];
  let anyRead = false;
  try {
    const s = await listResearchSessions(candidateId);
    const e = await listCandidateEvidence(candidateId);
    anyRead = true;
    if (s.ok) sessions = s.sessions;
    if (e.ok) evidence = e.evidence;
  } catch {
    lines.push("🟡 Registry de evidências indisponível neste momento (leitura recusada — nenhuma inferência).");
    return lines.join("\n");
  }

  if (!anyRead) {
    lines.push("🟡 Pesquisa indisponível.");
    return lines.join("\n");
  }

  const contradictions = evidence.filter(ev => ev.field_state === "CONTRADICTED").length;
  const unknowns = evidence.filter(ev => ev.field_state === "UNKNOWN" || ev.field_state === "COLLECTION_FAILED").length;
  const failed = evidence.filter(ev => ev.field_state === "COLLECTION_FAILED").length;

  lines.push(`🆔 <b>Candidato</b>: ${candidateId}`);
  lines.push(`📚 Sessões de pesquisa: ${sessions.length}`);
  lines.push(`🧩 Evidências: ${evidence.length}`);
  lines.push(`🔴 Contradições preservadas: ${contradictions}`);
  lines.push(`🟡 UNKNOWN/COLLECTION_FAILED: ${unknowns}`);
  if (failed > 0) {
    lines.push(`❗ Coletas que FALHARAM (identificáveis): ${failed} — ausência ≠ dado negativo`);
  }

  // Últimas evidências por campo (não contraditas, KNOWN ou DERIVED)
  const fieldEvidence = evidence.filter(ev => ev.kind === "FIELD");
  const byField = new Map<string, typeof fieldEvidence>();
  for (const ev of fieldEvidence) {
    const list = byField.get(ev.field_name ?? "") ?? [];
    list.push(ev);
    byField.set(ev.field_name ?? "", list);
  }
  if (byField.size > 0) {
    lines.push("🧪 <b>Campos pesquisados</b>:");
    for (const [field, evs] of byField) {
      const latest = evs[0];
      const emoji = latest.field_state === "CONTRADICTED" ? "🔴" : latest.field_state === "KNOWN" ? "🟢" : latest.field_state === "DERIVED" ? "🟠" : "🟡";
      const value = latest.field_value?.value ?? (latest.field_state === "COLLECTION_FAILED" ? "COLETA FALHOU" : "—");
      lines.push(`   ${emoji} ${field}: ${typeof value === "string" && value.length > 60 ? value.slice(0, 60) + "…" : String(value)} (${latest.field_state} · qualidade ${latest.quality})`);
    }
  } else {
    lines.push("🟡 Nenhuma evidência de campo ainda (ausência ≠ rejeição — nenhuma pesquisa iniciada).");
  }

  lines.push("");
  lines.push("🧭 EVIDENCE != FACT CANÔNICO. Nenhuma evidência abaixo é produto canônico; nenhuma ação de publicação foi executada.");
  return lines.join("\n");
}

// ============================================================================
// /affiliates — estado do Affiliate Registry (Blocos N6/N7, RENDER-ONLY)
// REGISTRY = DADOS, NÃO AUTORIDADE. Nenhum comando abaixo valida, ativa,
// revoga, registra ou executa link — apenas LÊ o estado atual do registry.
// AFFILIATE LINK != AUTHORITY · VALID != AUTORIZA PUBLICAÇÃO (exige DECISION
// + Policy Engine + ApprovalStore do N5).
// ============================================================================
export async function renderAffiliates(arg?: string): Promise<string> {
  const lines: string[] = [];
  lines.push("🛒 <b>AFILIADOS — AFFILIATE REGISTRY (BLOCO N6/N7, RENDER-ONLY)</b>");
  lines.push("━━━━━━━━━━━━━━━━━━");
  lines.push("📏 Regra: VALID == DADOS ESTRUTURAIS · NÃO AUTORIZA PUBLICAÇÃO. Nenhuma ação de escrita é executada por este comando.");

  const affiliateRepo = await import("../commercial/affiliate/affiliateRepository").catch(() => null);
  if (!affiliateRepo) {
    lines.push("🟡 Registry indisponível neste momento (leitura recusada — nenhuma inferência).");
    return lines.join("\n");
  }

  const idArg = typeof arg === "string" ? arg.trim() : "";
  if (idArg) {
    // /affiliates <affiliate_link_id ou provider_code> — detalhe de um registro
    const link = await affiliateRepo.getLink(idArg).catch(() => null);
    if (link) {
      const l = link as Record<string, unknown>;
      lines.push(`🆔 Link: <code>${String(l.link_id ?? idArg)}</code>`);
      lines.push(`📦 Provider: ${String(l.provider_id ?? l.providerId ?? "—")}`);
      lines.push(`🌐 Marketplace: ${String(l.marketplace ?? "—")}`);
      lines.push(`🧪 Validação: <code>${String(l.validation_state ?? l.validationState ?? "UNVALIDATED")}</code>`);
      lines.push(`⏱️ Expira: ${String(l.expires_at ?? l.expiresAt ?? "—")}`);
      lines.push(`🔑 Digest: <code>${String(l.digest ?? "—").slice(0, 12)}…</code>`);
      lines.push("⚠️ Link VALID ≠ publicação autorizada (exige decision + policy + approval do N5).");
      return lines.join("\n");
    }
    const providers = await affiliateRepo.listProviders().catch(() => []);
    const provider = (providers ?? []).find((p: Record<string, unknown>) =>
      String(p.provider_code ?? p.providerCode ?? "").toLowerCase() === idArg.toLowerCase() ||
      String(p.provider_id ?? p.providerId ?? "").toLowerCase() === idArg.toLowerCase()
    );
    if (provider) {
      const p = provider as Record<string, unknown>;
      lines.push(`📦 Provider: <code>${String(p.provider_code ?? p.providerCode ?? "—")}</code>`);
      lines.push(`🏷️ Nome: ${String(p.name ?? "—")}`);
      lines.push(`🟢 Status: <code>${String(p.status ?? "—")}</code>`);
      lines.push(`🌐 Marketplace: ${String(p.marketplace ?? "—")}`);
      return lines.join("\n");
    }
    lines.push(`🟡 Registro <code>${idArg}</code> não encontrado no Affiliate Registry.`);
    return lines.join("\n");
  }

  // Lista geral: resumo do registry (sem expor URLs rastreadas — leitura de estado).
  try {
    const providers = (await affiliateRepo.listProviders()) as Array<Record<string, unknown>>;
    // listLinksByCandidate exige um candidate_id específico; para o resumo
    // geral o comando lista providers e aceita /affiliates <link_id> para o
    // detalhe de um link (sem varredura em massa do registry).
    if (!providers.length) {
      lines.push("🟡 Nenhum provider ou link afiliado registrado no registry.");
      lines.push("   (ausência de registro ≠ ausência de oportunidade)");
    } else {
      lines.push(`📦 <b>Providers:</b> ${providers.length}`);
      for (const p of providers) {
        lines.push(`• <code>${String(p.provider_code ?? p.providerCode ?? "—")}</code> [${String(p.status ?? "—")}] · ${String(p.marketplace ?? "—")}`);
      }
    }
  } catch {
    lines.push("🟡 Registry indisponível neste momento (leitura recusada — nenhuma inferência).");
  }

  lines.push("");
  lines.push("USE: /affiliates &lt;affiliate_link_id ou provider_code&gt;");
  lines.push("🧭 AFFILIATE LINK != AUTHORITY. Nenhuma validação, ativação ou revogação foi executada.");
  return lines.join("\n");
}

// ============================================================================
// /assess — avaliação do Bloco N4 (RENDER-ONLY)
// Renderiza a ÚLTIMA avaliação de um candidato (candidato → 9 eixos →
// classificação → recomendação → prioridade explicável). NUNCA executa o
// filtro, nunca publica, nunca promove e nunca executa ação.
// ============================================================================
export async function renderAssessment(candidateId?: string): Promise<string> {
  const lines: string[] = [];
  lines.push("🎯 <b>FILTRO + PRIORIZAÇÃO — BLOCO N4 (RENDER-ONLY)</b>");
  lines.push("━━━━━━━━━━━━━━━━━━");
  lines.push("📏 Regra: CANDIDATE != FACT CANÔNICO · RECOMMENDATION != ACTION. Nenhuma avaliação abaixo é produto publicado nem ação executada.");

  if (!candidateId) {
    lines.push("⚠️ Uso: /assess &lt;candidate_id&gt; (ex: /assess can-abc123...)");
    return lines.join("\n");
  }

  let assessments: Array<{ classification: string | null; recommendation: string | null; classification_basis: string; recommendation_basis: string; priority: Record<string, unknown> | null; priority_level: string | null; priority_score: number | null; unknowns: unknown[]; contradictions: unknown[]; collection_failures: unknown[]; created_at: string }> = [];
  let anyRead = false;
  try {
    const list = await listCandidateAssessments({ candidateId, limit: 1 });
    anyRead = true;
    if (list.ok) assessments = list.assessments as typeof assessments;
  } catch {
    lines.push("🟡 Filtro Cerberus indisponível neste momento (leitura recusada — nenhuma inferência).");
    return lines.join("\n");
  }

  if (!anyRead || assessments.length === 0) {
    lines.push("🆔 <b>Candidato</b>: " + candidateId);
    lines.push("🟡 Nenhuma avaliação registrada ainda — execute a avaliação administrativa primeiro (/assess não a executa, apenas renderiza).");
    return lines.join("\n");
  }

  const a = assessments[0];
  const unknowns = Array.isArray(a.unknowns) ? a.unknowns.length : 0;
  const contradictions = Array.isArray(a.contradictions) ? a.contradictions.length : 0;
  const failures = Array.isArray(a.collection_failures) ? a.collection_failures.length : 0;

  lines.push(`🆔 <b>Candidato</b>: ${candidateId}`);
  lines.push(`🏷️ Classificação: <b>${a.classification ?? "—"}</b>`);
  lines.push(`🧭 Recomendação: <b>${a.recommendation ?? "—"}</b> (is_actionable=false — RECOMMENDATION != ACTION)`);
  if (a.priority_level) lines.push(`⚖️ Prioridade: ${a.priority_level}${a.priority_score !== null && a.priority_score !== undefined ? ` (${a.priority_score.toFixed(4)})` : ""} — nunca exibida sem os eixos`);
  if (contradictions > 0) lines.push(`🔴 Contradições preservadas: ${contradictions}`);
  if (unknowns > 0) lines.push(`🟡 Incertezas declaradas (UNKNOWN): ${unknowns}`);
  if (failures > 0) lines.push(`❗ Falhas de coleta declaradas: ${failures}`);
  lines.push(`📝 Base da classificação: ${a.classification_basis || "—"}`);
  lines.push(`📝 Base da recomendação: ${a.recommendation_basis || "—"}`);
  if (a.priority && typeof a.priority === "object") {
    const explanation = (a.priority as { explanation?: string }).explanation;
    if (explanation) lines.push(`📐 Explicação da prioridade: ${explanation}`);
  }
  lines.push("");
  lines.push("🧭 CANDIDATE != FACT CANÔNICO · RECOMMENDATION != ACTION. Nenhuma avaliação abaixo é produto canônico; nenhuma ação de publicação foi executada.");
  return lines.join("\n");
}
