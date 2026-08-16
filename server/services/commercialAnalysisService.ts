/**
 * Cerberus Finds Archive — Bloco 14 — Cérebro Comercial V1
 * Serviço de análise comercial (FASE B+).
 *
 * Responsabilidade EXCLUSIVA: produzir artefatos analíticos (Analysis) a
 * partir das observações do Bloco 13 e dos cliques existentes.
 *
 * Fronteiras absolutas:
 *   MEMORY != AUTHORITY · OBSERVATION != FACT CANÔNICO
 *   SIGNAL != REVENUE · RECOMMENDATION != ACTION
 *   READ != WRITE (em products) · ANALYSIS != EXECUTION
 *
 * Este módulo NÃO publica, NÃO altera products, NÃO altera preço,
 * NÃO altera disponibilidade, NÃO executa jobs, NÃO chama Telegram
 * para ação, NÃO dispara o Operator e NÃO cria agentes.
 */
import {
  ANALYSIS_WINDOWS,
  AnalysisWindow,
  BANNED_COMMERCIAL_TERMS,
  COMMERCIAL_BRAIN_VERSION,
  CONFIDENCE_MODEL_VERSION,
  Evidence,
  EvidenceRef,
  OPPORTUNITY_SIGNAL_TYPES,
  PRIORITY_MODEL_VERSION,
  Recommendation,
  RISK_SIGNAL_TYPES,
  RECOMMENDATION_ID_PREFIX,
  SIGNAL_ID_PREFIX,
  Signal,
  SignalCategory,
  SignalType,
} from "../commercialBrain/types";
import {
  analyzeDivergence,
  analyzeOutlier,
  checkStaleness,
  computeBaseline,
  computePercentDelta,
  deriveConfidence,
  formatPercentDelta,
  FRESHNESS_LIMIT_DAYS,
} from "../commercialBrain/formulas";
import { buildEvidence } from "../commercialBrain/rules";
import {
  buildOpportunity,
  buildRecommendation,
  buildRisk,
  computePriorityBreakdownFromSignal,
  decideOpportunity,
  decideRisk,
  defaultSuggestedAction,
} from "../commercialBrain/rules";
import { getProductObservations } from "../repositories/productObservationsRepository";
import { getClient as getObservationsClient } from "../repositories/productObservationsRepository";
import {
  insertArtifact,
  insertSignal,
  setCommercialBrainClientForTests,
} from "../repositories/commercialBrainRepository";

export { setCommercialBrainClientForTests };

/**
 * Contagem de cliques de um produto nas últimas N horas, via product_clicks.
 * Lê SOMENTE product_clicks; não executa nenhuma mutação.
 */
export async function countClicksForProduct(
  productId: string,
  hours: number,
): Promise<{ count: number; windowHours: number }> {
  const supabase = getObservationsClient();
  if (!supabase) return { count: 0, windowHours: hours };
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("product_clicks")
    .select("id")
    .eq("product_id", productId)
    .gte("created_at", since);
  if (error || !data) return { count: 0, windowHours: hours };
  return { count: data.length, windowHours: hours };
}

/**
 * Deriva sinais a partir das observações do Bloco 13 e dos cliques.
 * Determinístico para (produto, janela, momento de avaliação).
 */
export async function deriveSignals(params: {
  productId: string;
  productRef: string;
  window: AnalysisWindow;
  evaluatedAt: Date;
}): Promise<Signal[]> {
  const { productId, productRef, window, evaluatedAt } = params;
  const signals: Signal[] = [];

  const observationsResult = await getProductObservations(productId, 500);
  if (!observationsResult.ok) {
    // Indisponibilidade de dados → sinal de insuficiência, nunca invenção.
    signals.push(
      makeInsufficientSignal(productId, productRef, window, evaluatedAt, observationsResult.reason || "Observações indisponíveis."),
    );
    return signals;
  }
  const observations = observationsResult.value;

  const allPrices = observations.prices.filter((p) => Number.isFinite(p.observedPrice));
  const allAvailabilities = observations.availabilities;
  const allSources = observations.sources;

  const windowMs =
    window === "lifetime" ? Infinity : windowDurationMs(window);
  const windowStart = new Date(evaluatedAt.getTime() - windowMs);

  const pricesInWindow = allPrices.filter((p) => new Date(p.observedAt) >= windowStart);
  const availabilitiesInWindow = allAvailabilities.filter((a) => new Date(a.observedAt) >= windowStart);
  const sourcesInWindow = allSources.filter((s) => new Date(s.observedAt) >= windowStart);

  const windowPrices = pricesInWindow.map((p) => p.observedPrice);
  const previousPrices = allPrices.filter((p) => new Date(p.observedAt) < windowStart).map((p) => p.observedPrice);

  const detectedAt = evaluatedAt.toISOString();
  const displayTz = "America/Sao_Paulo";

  // ---- Sinais de preço ----
  if (windowPrices.length > 0) {
    const current = windowPrices[windowPrices.length - 1];
    // computeBaseline opera na janela imediatamente ANTERIOR (valor esperado
    // histórico). Por isso recebe TODAS as observações de preço, não apenas
    // as da janela atual.
    const baseline = computeBaseline(
      allPrices.map((p) => ({ value: p.observedPrice, observedAt: p.observedAt })),
      window,
      evaluatedAt,
    );
    const delta = computePercentDelta(current, baseline);
    const deltaStr = formatPercentDelta(delta);

    if (baseline !== null && windowPrices.length >= 2) {
      const baselineValue = baseline.toFixed(2);
      const ref = priceEvidenceRef(productId, observations.prices, windowPrices.length, window, detectedAt);
      const collectionConfidence = observations.prices
        .slice(0, 10)
        .map((p) => p.confidence);
      const singleSource = new Set(
        observations.prices.map((p) => p.sourceName.trim()).filter(Boolean),
      ).size <= 1;

      const confidence = deriveConfidence({
        recordCount: windowPrices.length,
        singleSource,
        collectionConfidence,
        ageDays: daysSince(observations.prices[0]?.observedAt ?? null, evaluatedAt),
        unresolvedContradiction: false,
      });

      if (delta !== null && delta < 0) {
        signals.push(
          makePriceSignal({
            signalType: "PRICE_IMPROVEMENT",
            category: "price",
            current,
            baselineValue,
            delta: deltaStr,
            window,
            baselineWindow: previousPrices.length > 0 ? window : null,
            evidenceRefs: [ref],
            confidence,
            recordCount: windowPrices.length,
            detectedAt,
            displayTz,
            productId,
            productRef,
            signals,
          }),
        );
      } else if (delta !== null && delta > 0) {
        signals.push(
          makePriceSignal({
            signalType: "PRICE_DETERIORATION",
            category: "price",
            current,
            baselineValue,
            delta: deltaStr,
            window,
            baselineWindow: previousPrices.length > 0 ? window : null,
            evidenceRefs: [ref],
            confidence,
            recordCount: windowPrices.length,
            detectedAt,
            displayTz,
            productId,
            productRef,
            signals,
          }),
        );
      }

      // Outlier vs banda da mediana histórica (somente com histórico mínimo)
      if (previousPrices.length >= 4) {
        const verdict = analyzeOutlier(current, previousPrices);
        if (verdict.isOutlier) {
          const confidence = deriveConfidence({
            recordCount: previousPrices.length + windowPrices.length,
            singleSource,
            collectionConfidence,
            ageDays: daysSince(observations.prices[0]?.observedAt ?? null, evaluatedAt),
            unresolvedContradiction: false,
          });
          signals.push({
            signalId: signalIdFromDate(detectedAt, "PRICE_OUTLIER", signals),
            analysisVersion: COMMERCIAL_BRAIN_VERSION,
            signalType: "PRICE_OUTLIER",
            category: "price",
            productId,
            productRef,
            metric: "observed_price_brl",
            currentValue: String(current),
            baselineValue: String(verdict.median.toFixed(2)),
            delta: `${verdict.low.toFixed(2)}..${verdict.high.toFixed(2)}`,
            window,
            baselineWindow: "lifetime",
            evidenceRefs: [priceEvidenceRef(productId, observations.prices, previousPrices.length + windowPrices.length, window, detectedAt)],
            confidence: confidence.confidence,
            confidenceBasis: trim(`${confidence.confidenceBasis}; outlier regra ${verdict.rule}`),
            detectedAt,
            inputSnapshot: {
              subject: productId,
              window,
              displayTz,
              recordCount: previousPrices.length + windowPrices.length,
              evaluatedAt: detectedAt,
            },
          });
        }
      }
    }

    // Divergência entre fontes (ex.: Shopee vs Mercado Livre)
    const bySource = new Map<string, number[]>();
    for (const p of pricesInWindow) {
      const src = (p.sourceName || "unknown").trim();
      const arr = bySource.get(src) || [];
      arr.push(p.observedPrice);
      bySource.set(src, arr);
    }
    const divergenceSources = Array.from(bySource.entries()).map(([source, values]) => ({
      source,
      value: values[0],
    }));
    if (divergenceSources.length >= 2) {
      const report = analyzeDivergence(divergenceSources);
      if (report.diverges) {
        const confidence = deriveConfidence({
          recordCount: windowPrices.length,
          singleSource: false,
          collectionConfidence: observations.prices
            .slice(0, 10)
            .map((p) => p.confidence),
          ageDays: daysSince(observations.prices[0]?.observedAt ?? null, evaluatedAt),
          unresolvedContradiction: true,
        });
        signals.push({
          signalId: signalIdFromDate(detectedAt, "SOURCE_DIVERGENCE", signals),
          analysisVersion: COMMERCIAL_BRAIN_VERSION,
          signalType: "SOURCE_DIVERGENCE",
          category: "source",
          productId,
          productRef,
          metric: "observed_price_brl",
          currentValue: String(current),
          baselineValue: String(report.median.toFixed(2)),
          delta: `banda ±10%: ${report.bandMin.toFixed(2)}..${report.bandMax.toFixed(2)}`,
          window,
          baselineWindow: null,
          evidenceRefs: [priceEvidenceRef(productId, observations.prices, windowPrices.length, window, detectedAt)],
          confidence: confidence.confidence,
          confidenceBasis: trim(`${confidence.confidenceBasis}; divergência entre fontes ${report.divergentSources.map((d) => d.source).join(",")}`),
          detectedAt,
          inputSnapshot: {
            subject: productId,
            window,
            displayTz,
            recordCount: windowPrices.length,
            evaluatedAt: detectedAt,
          },
        });
      }
    }
  }

  // ---- Sinais de disponibilidade ----
  const outOfStockInWindow = availabilitiesInWindow.filter((a) => a.observedAvailability === "OUT_OF_STOCK").length;
  if (outOfStockInWindow > 0) {
    const collectionConfidence = availabilitiesInWindow
      .slice(0, 10)
      .map((a) => a.confidence);
    const singleSource = new Set(
      availabilitiesInWindow.map((a) => a.sourceName.trim()).filter(Boolean),
    ).size <= 1;
    const confidence = deriveConfidence({
      recordCount: availabilitiesInWindow.length,
      singleSource,
      collectionConfidence,
      ageDays: daysSince(availabilitiesInWindow[0]?.observedAt ?? null, evaluatedAt),
      unresolvedContradiction: availabilitiesInWindow.some((a) => a.observedAvailability === "IN_STOCK"),
    });
    signals.push({
      signalId: signalIdFromDate(detectedAt, "AVAILABILITY_RISK", signals),
      analysisVersion: COMMERCIAL_BRAIN_VERSION,
      signalType: "AVAILABILITY_RISK",
      category: "availability",
      productId,
      productRef,
      metric: "availability_status",
      currentValue: `${outOfStockInWindow}/${availabilitiesInWindow.length} OUT_OF_STOCK`,
      baselineValue: "IN_STOCK",
      delta: `+${outOfStockInWindow} indisponibilidades na janela`,
      window,
      baselineWindow: null,
      evidenceRefs: [availabilityEvidenceRef(productId, observations.availabilities, window, detectedAt)],
      confidence: confidence.confidence,
      confidenceBasis: confidence.confidenceBasis,
      detectedAt,
      inputSnapshot: {
        subject: productId,
        window,
        displayTz,
        recordCount: availabilitiesInWindow.length,
        evaluatedAt: detectedAt,
      },
    });
  }

  // ---- Sinais de interesse (cliques) ----
  const interestWindowHours = window === "24h" ? 24 : window === "7d" ? 7 * 24 : window === "30d" ? 30 * 24 : 24 * 365 * 10;
  const clicks = await countClicksForProduct(productId, interestWindowHours);
  if (clicks.count > 0) {
    const baselineClicks = await countClicksForProduct(productId, interestWindowHours * 2);
    const previousClicks = Math.max(baselineClicks.count - clicks.count, 0);
    const delta = computePercentDelta(clicks.count, previousClicks > 0 ? previousClicks : null);
    const interestType: SignalType =
      previousClicks > 0
        ? delta !== null && delta >= 0
          ? "INTEREST_ABOVE_BASELINE"
          : "INTEREST_BELOW_BASELINE"
        : "INTEREST_NO_BASELINE";
    const confidence = deriveConfidence({
      recordCount: clicks.count,
      singleSource: true,
      collectionConfidence: ["MEDIUM"],
      ageDays: 0,
      unresolvedContradiction: false,
    });
    signals.push({
      signalId: signalIdFromDate(detectedAt, interestType, signals),
      analysisVersion: COMMERCIAL_BRAIN_VERSION,
      signalType: interestType,
      category: "interest",
      productId,
      productRef,
      metric: "click_count",
      currentValue: String(clicks.count),
      baselineValue: previousClicks > 0 ? String(previousClicks) : "sem baseline",
      delta: formatPercentDelta(delta),
      window,
      baselineWindow: previousClicks > 0 ? window : null,
      evidenceRefs: [clickEvidenceRef(productId, window, detectedAt)],
      confidence: confidence.confidence,
      confidenceBasis: trim(`${confidence.confidenceBasis}; fonte única (clicks)`),
      detectedAt,
      inputSnapshot: {
        subject: productId,
        window,
        displayTz,
        recordCount: clicks.count,
        evaluatedAt: detectedAt,
      },
    });
  }

  // ---- Sinal de frescor (última observação) ----
  const lastObserved = mostRecentDate([
    observations.prices[0]?.observedAt ?? null,
    observations.availabilities[0]?.observedAt ?? null,
    observations.sources[0]?.observedAt ?? null,
  ]);
  const staleness = checkStaleness(lastObserved, evaluatedAt);
  if (staleness.stale) {
    signals.push({
      signalId: signalIdFromDate(detectedAt, "OBSERVATION_STALE", signals),
      analysisVersion: COMMERCIAL_BRAIN_VERSION,
      signalType: "OBSERVATION_STALE",
      category: "freshness",
      productId,
      productRef,
      metric: "last_observed_age_days",
      currentValue: String(staleness.ageDays.toFixed(1)),
      baselineValue: `limite ${FRESHNESS_LIMIT_DAYS}d`,
      delta: `+${Math.max(0, staleness.ageDays - FRESHNESS_LIMIT_DAYS).toFixed(1)}d além do limite`,
      window: "lifetime",
      baselineWindow: null,
      evidenceRefs: lastObserved ? [priceEvidenceRef(productId, observations.prices, 1, "lifetime", detectedAt)] : [
        {
          sourceType: "product",
          sourceTable: "products",
          sourceIds: [productId],
        },
      ],
      confidence: staleness.ageDays > FRESHNESS_LIMIT_DAYS * 2 ? "HIGH" : "MEDIUM",
      confidenceBasis: `Dados com ${staleness.ageDays.toFixed(1)} dias desde a última observação.`,
      detectedAt,
      inputSnapshot: {
        subject: productId,
        window: "lifetime",
        displayTz,
        recordCount: allPrices.length + allAvailabilities.length + allSources.length,
        evaluatedAt: detectedAt,
      },
    });
  }

  // ---- Sem dados suficientes ----
  if (signals.length === 0) {
    signals.push(makeInsufficientSignal(productId, productRef, window, evaluatedAt, "Nenhuma observação relevante encontrada na janela."));
  }

  return signals;
}

/**
 * Orquestra a análise V1 completa: sinais → oportunidades/riscos →
 * recomendações → Analysis. Persiste sinais e artefatos como memória
 * analítica (insertSignal/insertArtifact) e retorna o Analysis.
 *
 * persist=false retorna a análise sem gravar (leitura analítica pura).
 */
export async function runCommercialAnalysis(params: {
  productId: string;
  productRef: string;
  window?: AnalysisWindow;
  evaluatedAt?: Date;
  persist?: boolean;
  analysisId?: string;
  correlationId?: string;
}): Promise<{ analysis: AnalysisOutput; persisted: boolean }> {
  const { productId, productRef } = params;
  const window: AnalysisWindow =
    params.window && ANALYSIS_WINDOWS.includes(params.window) ? params.window : "7d";
  const evaluatedAt = params.evaluatedAt ?? new Date();
  const persist = params.persist !== false;
  const analysisId = params.analysisId || buildAnalysisId(evaluatedAt);
  const correlationId = params.correlationId || analysisId;
  const now = () => evaluatedAt.toISOString();

  const signals = await deriveSignals({ productId, productRef, window, evaluatedAt });

  const opportunities = [];
  const risks = [];
  const recommendations: Recommendation[] = [];

  for (const signal of signals) {
    const lastEvidenceAgeDays = daysSince(
      signal.detectedAt,
      evaluatedAt,
    );

    // Persistência do sinal como memória analítica.
    if (persist) {
      const signalOutcome = await insertSignal({
        signalId: signal.signalId,
        productId: signal.productId,
        signalType: signal.signalType,
        signalCategory: signal.category,
        metric: signal.metric,
        currentValue: signal.currentValue,
        baselineValue: signal.baselineValue,
        delta: signal.delta,
        window: signal.window,
        baselineWindow: signal.baselineWindow,
        evidenceRefs: signal.evidenceRefs,
        confidence: signal.confidence,
        confidenceBasis: signal.confidenceBasis,
        analysisVersion: COMMERCIAL_BRAIN_VERSION,
        inputSnapshot: signal.inputSnapshot,
        detectedAt: signal.detectedAt,
        correlationId,
        idempotencyKey: idempotencyKeyFor(productId, window, "signal", signal.signalType, evaluatedAt),
        metadata: { analysisId, source: "commercial_brain_v1" },
      });
      if (signalOutcome.outcome === "missing_supabase") {
        // Banco indisponível: a análise analítica continua, mas a memória
        // falha explicitamente (sem fallback silencioso). O caller decide.
        throw new Error(
          `persist_signal_failed: cliente Supabase indisponível para signal_id ${signal.signalId}`,
        );
      }
    }

    // Oportunidade
    if (signal.productId !== null && OPPORTUNITY_SIGNAL_TYPES.includes(signal.signalType)) {
      const decision = decideOpportunity({ signal, lastEvidenceAgeDays });
      if (decision.qualified) {
        const opportunity = buildOpportunity({
          opportunityId: artifactIdFromDate(signal.detectedAt, "opp", opportunities.length + 1),
          signal,
          lastEvidenceAgeDays,
          now,
        });
        if (opportunity) {
          opportunities.push(opportunity);
          const recommendation = buildRecommendation({
            recommendationId: artifactIdFromDate(signal.detectedAt, "rec", recommendations.length + 1),
            signal,
            evidence: signalsToEvidence(signal),
            lastEvidenceAgeDays,
            now,
          });
          recommendations.push(recommendation);
          if (persist) {
            await persistRecommendation({
              recommendation,
              productId: signal.productId,
              signal,
              window,
              evaluatedAt,
              analysisId,
              correlationId,
              artifactType: "opportunity",
            });
          }
          continue;
        }
      }
    }

    // Risco
    if (signal.productId !== null && RISK_SIGNAL_TYPES.includes(signal.signalType)) {
      const decision = decideRisk({ signal, lastEvidenceAgeDays });
      if (decision.qualified) {
        const risk = buildRisk({
          riskId: artifactIdFromDate(signal.detectedAt, "risk", risks.length + 1),
          signal,
          lastEvidenceAgeDays,
          now,
        });
        if (risk) {
          risks.push(risk);
          const recommendation = buildRecommendation({
            recommendationId: artifactIdFromDate(signal.detectedAt, "rec", recommendations.length + 1),
            signal,
            evidence: signalsToEvidence(signal),
            lastEvidenceAgeDays,
            now,
          });
          recommendations.push(recommendation);
          if (persist) {
            await persistRecommendation({
              recommendation,
              productId: signal.productId,
              signal,
              window,
              evaluatedAt,
              analysisId,
              correlationId,
              artifactType: "risk",
            });
          }
          continue;
        }
      }
    }

    // Sinais sem oportunidade/risco qualificado: recomendação de manutenção.
    const maintenanceSignal =
      signal.signalType === "OBSERVATION_STALE" ||
      signal.signalType === "INTEREST_NO_BASELINE" ||
      signal.signalType === "SOURCE_CONVERGENCE";
    if (maintenanceSignal && signal.productId !== null) {
      const recommendation = buildRecommendation({
        recommendationId: artifactIdFromDate(signal.detectedAt, "rec", recommendations.length + 1),
        signal,
        evidence: signalsToEvidence(signal),
        lastEvidenceAgeDays,
        now,
      });
      recommendations.push(recommendation);
      if (persist) {
        await persistRecommendation({
          recommendation,
          productId: signal.productId,
          signal,
          window,
          evaluatedAt,
          analysisId,
          correlationId,
          artifactType: "recommendation",
        });
      }
    }
  }

  const analysis: AnalysisOutput = {
    analysisId,
    analysisVersion: COMMERCIAL_BRAIN_VERSION,
    scoringVersion: PRIORITY_MODEL_VERSION,
    confidenceVersion: CONFIDENCE_MODEL_VERSION,
    evidenceVersion: "evidence_model_v1",
    input: {
      subject: productId,
      window,
      displayTz: "America/Sao_Paulo",
      evaluatedAt: evaluatedAt.toISOString(),
    },
    signals,
    opportunities,
    risks,
    recommendations,
    producedAt: evaluatedAt.toISOString(),
  };

  return { analysis, persisted: persist };
}

// ============================================================================
// Helpers internos (não exportados para rotas; analíticos puros)
// ============================================================================

export interface AnalysisOutput {
  analysisId: string;
  analysisVersion: typeof COMMERCIAL_BRAIN_VERSION;
  scoringVersion: typeof PRIORITY_MODEL_VERSION;
  confidenceVersion: typeof CONFIDENCE_MODEL_VERSION;
  evidenceVersion: "evidence_model_v1";
  input: { subject: string; window: AnalysisWindow; displayTz: string; evaluatedAt: string };
  signals: Signal[];
  opportunities: unknown[];
  risks: unknown[];
  recommendations: Recommendation[];
  producedAt: string;
}

function buildAnalysisId(evaluatedAt: Date): string {
  const date = evaluatedAt.toISOString().slice(0, 10).replace(/-/g, "");
  return `ana-${date}-1`;
}

function signalIdFromDate(detectedAt: string, signalType: SignalType, siblings: Signal[]): string {
  const date = detectedAt.slice(0, 10).replace(/-/g, "");
  const seq = siblings.filter((s) => s.signalType === signalType).length + 1;
  return `${SIGNAL_ID_PREFIX}-${date}-${seq}`;
}

function artifactIdFromDate(detectedAt: string, prefix: string, seq: number): string {
  const date = detectedAt.slice(0, 10).replace(/-/g, "");
  return `${prefix}-${date}-${seq}`;
}

function idempotencyKeyFor(productId: string, window: AnalysisWindow, kind: string, signalType: string, evaluatedAt: Date): string {
  return `brain-1-${productId}-${window}-${kind}-${signalType}-${evaluatedAt.toISOString().slice(0, 13)}`;
}

function daysSince(observedAt: string | null, evaluatedAt: Date): number {
  if (!observedAt) return Infinity;
  const d = new Date(observedAt);
  if (Number.isNaN(d.getTime())) return Infinity;
  return (evaluatedAt.getTime() - d.getTime()) / (24 * 60 * 60 * 1000);
}

function mostRecentDate(dates: Array<string | null>): string | null {
  const valid = dates.filter((d): d is string => !!d).map((d) => new Date(d)).filter((d) => !Number.isNaN(d.getTime()));
  if (valid.length === 0) return null;
  return new Date(Math.max(...valid.map((d) => d.getTime()))).toISOString();
}

function trim(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

interface PriceSignalParams {
  signalType: Extract<SignalType, "PRICE_IMPROVEMENT" | "PRICE_DETERIORATION">;
  category: SignalCategory;
  current: number;
  baselineValue: string;
  delta: string;
  window: AnalysisWindow;
  baselineWindow: AnalysisWindow | null;
  evidenceRefs: EvidenceRef[];
  confidence: { confidence: Signal["confidence"]; confidenceBasis: string };
  recordCount: number;
  detectedAt: string;
  displayTz: string;
  productId: string;
  productRef: string;
  signals: Signal[];
}

function makePriceSignal(params: PriceSignalParams): Signal {
  const {
    signalType,
    category,
    current,
    baselineValue,
    delta,
    window,
    baselineWindow,
    evidenceRefs,
    confidence,
    recordCount,
    detectedAt,
    displayTz,
    productId,
    productRef,
    signals,
  } = params;
  return {
    signalId: signalIdFromDate(detectedAt, signalType, signals),
    analysisVersion: COMMERCIAL_BRAIN_VERSION,
    signalType,
    category,
    productId,
    productRef,
    metric: "observed_price_brl",
    currentValue: String(current),
    baselineValue,
    delta,
    window,
    baselineWindow,
    evidenceRefs,
    confidence: confidence.confidence,
    confidenceBasis: confidence.confidenceBasis,
    detectedAt,
    inputSnapshot: {
      subject: productId,
      window,
      displayTz,
      recordCount,
      evaluatedAt: detectedAt,
    },
  };
}

function priceEvidenceRef(
  productId: string,
  prices: Array<{ observationId: string }>,
  recordCount: number,
  window: AnalysisWindow,
  detectedAt: string,
): EvidenceRef {
  return {
    sourceType: "price_observation",
    sourceTable: "product_price_observed",
    sourceIds: prices.slice(0, Math.min(recordCount, 5)).map((p) => p.observationId).filter(Boolean),
  };
}

function availabilityEvidenceRef(
  productId: string,
  availabilities: Array<{ observationId: string }>,
  _window: AnalysisWindow,
  _detectedAt: string,
): EvidenceRef {
  return {
    sourceType: "availability_observation",
    sourceTable: "product_availability_observed",
    sourceIds: availabilities.slice(0, 5).map((a) => a.observationId).filter(Boolean),
  };
}

function clickEvidenceRef(productId: string, _window: AnalysisWindow, _detectedAt: string): EvidenceRef {
  return {
    sourceType: "click",
    sourceTable: "product_clicks",
    sourceIds: [productId],
  };
}

function makeInsufficientSignal(productId: string, productRef: string, window: AnalysisWindow, evaluatedAt: Date, reason: string): Signal {
  const detectedAt = evaluatedAt.toISOString();
  return {
    signalId: `${SIGNAL_ID_PREFIX}-${evaluatedAt.toISOString().slice(0, 10).replace(/-/g, "")}-1`,
    analysisVersion: COMMERCIAL_BRAIN_VERSION,
    signalType: "INTEREST_NO_BASELINE",
    category: "interest",
    productId,
    productRef,
    metric: "data_sufficiency",
    currentValue: "0",
    baselineValue: "sem baseline",
    delta: "sem dados",
    window,
    baselineWindow: null,
    evidenceRefs: [
      {
        sourceType: "product",
        sourceTable: "products",
        sourceIds: [productId],
      },
    ],
    confidence: "INSUFFICIENT_EVIDENCE",
    confidenceBasis: reason,
    detectedAt,
    inputSnapshot: {
      subject: productId,
      window,
      displayTz: "America/Sao_Paulo",
      recordCount: 0,
      evaluatedAt: detectedAt,
    },
  };
}

function signalsToEvidence(signal: Signal): Evidence[] {
  const base = {
    sourceTable: signal.evidenceRefs[0]?.sourceTable || "unknown",
    metric: signal.metric,
    value: signal.currentValue,
    baseline: signal.baselineValue,
    window: signal.window,
    observedAt: signal.detectedAt,
  };
  return signal.evidenceRefs.map((ref, index) =>
    buildEvidence({
      evidenceId: index === 0 ? `ev-${signal.signalId}` : `ev-${signal.signalId}-${index + 1}`,
      sourceType: ref.sourceType,
      sourceTable: ref.sourceTable,
      sourceIds: ref.sourceIds,
      metric: base.metric,
      value: base.value,
      baseline: base.baseline,
      window: base.window,
      observedAt: base.observedAt,
    }),
  );
}

async function persistRecommendation(params: {
  recommendation: Recommendation;
  productId: string;
  signal: Signal;
  window: AnalysisWindow;
  evaluatedAt: Date;
  analysisId: string;
  correlationId: string;
  artifactType: "opportunity" | "risk" | "recommendation";
}): Promise<void> {
  const { recommendation, productId, signal, window, evaluatedAt, analysisId, correlationId, artifactType } = params;
  const breakdown = computePriorityBreakdownFromSignal(signal);
  const outcome = await insertArtifact({
    artifactId: recommendation.recommendationId,
    productId,
    artifactType,
    subject: recommendation.subject,
    subjectRef: recommendation.subjectRef,
    signalType: signal.signalType,
    signalId: signal.signalId,
    suggestedAction: recommendation.suggestedAction,
    confidence: recommendation.confidence,
    confidenceBasis: recommendation.confidenceBasis,
    priority: { ...breakdown },
    priorityLevel: breakdown.level,
    priorityScore: breakdown.score,
    impact: recommendation.impact,
    cost: recommendation.cost,
    risk: recommendation.risk,
    status: "ACTIVE",
    baselineStatement: recommendation.baselineStatement,
    reviewDeadline: recommendation.reviewDeadline,
    evidence: recommendation.evidence,
    scoringVersion: recommendation.scoringVersion,
    confidenceVersion: recommendation.confidenceVersion,
    analysisVersion: recommendation.analysisVersion,
    correlationId,
    idempotencyKey: idempotencyKeyFor(productId, window, artifactType, signal.signalType, evaluatedAt),
    metadata: { analysisId, source: "commercial_brain_v1" },
  });
  if (outcome.outcome === "missing_supabase") {
    throw new Error(`persist_artifact_failed: cliente Supabase indisponível para ${recommendation.recommendationId}`);
  }
}

/**
 * Varredura lexical do vocabulário proibido (venda/receita/lucro) em qualquer
 * texto da análise. Retorna os termos encontrados, se houver.
 */
export function scanBannedTerms(payload: unknown): string[] {
  const found: Set<string> = new Set();
  const walk = (node: unknown) => {
    if (typeof node === "string") {
      const lower = node.toLowerCase();
      for (const term of BANNED_COMMERCIAL_TERMS) {
        if (lower.includes(term.toLowerCase())) found.add(term);
      }
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      Object.values(node as Record<string, unknown>).forEach(walk);
    }
  };
  walk(payload);
  return Array.from(found).sort();
}

function windowDurationMs(window: AnalysisWindow): number {
  switch (window) {
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return 30 * 24 * 60 * 60 * 1000;
    case "lifetime":
      return Infinity;
  }
}
