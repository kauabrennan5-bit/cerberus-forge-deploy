// ============================================================================
// Bloco N3 — Qualidade heurística de evidência.
// Regra declarada (NUNCA probabilidade): a qualidade descreve a posição
// do dado na cadeia de confiança, com justificativa explícita em texto.
// ============================================================================

import {
  EvidenceQuality,
  FieldState,
  SourceType,
} from "../../repositories/candidateEvidenceRepository";

export interface QualityDecision {
  quality: EvidenceQuality;
  rationale: string; // justificativa legível (metadata.quality_rationale)
}

/**
 * Qualidade heurística de uma evidência de campo.
 * - KNOWN + marketplace_page + http 200 → HIGH (observado direto da página)
 * - KNOWN + scrape/marketplace_page sem http confirmado → MEDIUM
 * - DERIVED / url_slug / search → LOW (valor derivado, não confirmado)
 * - UNKNOWN / COLLECTION_FAILED → UNKNOWN (nada observado)
 * - CONTRADICTED → MEDIUM (observação real, mas em conflito)
 */
export function assessEvidenceQuality(params: {
  fieldState: string;
  sourceType: string;
  httpStatus?: number | null;
  fromSearch?: boolean;
}): QualityDecision {
  const { fieldState, sourceType, httpStatus, fromSearch } = params;

  if (fieldState === "COLLECTION_FAILED") {
    return {
      quality: "UNKNOWN",
      rationale: `COLLECTION_FAILED: a coleta falhou (${httpStatus ?? "sem http"}); nada foi observado — estado descreve a falha, não o produto`,
    };
  }
  if (fieldState === "UNKNOWN") {
    return {
      quality: "UNKNOWN",
      rationale: `campo não observado na fonte (${sourceType}); ausência ≠ valor negativo`,
    };
  }
  if (fieldState === "CONTRADICTED") {
    return {
      quality: "MEDIUM",
      rationale: `observação real, porém CONTRADITA por evidência anterior do mesmo campo — conflito preservado, nenhum valor escolhido silenciosamente`,
    };
  }
  if (fieldState === "DERIVED" || sourceType === "url_slug") {
    return {
      quality: "LOW",
      rationale: `valor DERIVADO da URL/slug (${sourceType}); NÃO confirmado pelo marketplace — evidência de origem, não de conteúdo`,
    };
  }
  if (fromSearch) {
    return {
      quality: "LOW",
      rationale: `campo extraído de página de RESULTADOS (busca), não da página de item — menos confiável que leitura do anúncio`,
    };
  }
  if (fieldState === "KNOWN" && httpStatus === 200 && sourceType === "marketplace_page") {
    return {
      quality: "HIGH",
      rationale: `observado diretamente na página do anúncio (marketplace_page, http ${httpStatus}) com digest reprodutível`,
    };
  }
  // KNOWN de fonte não página (scrape/manual/api sem http confirmado)
  return {
    quality: "MEDIUM",
    rationale: `observado (${sourceType}, ${fieldState}), mas sem confirmação completa de página/http — confiança intermediária`,
  };
}

/**
 * Detecta contradição numérica/valor entre uma evidência nova e anteriores.
 * Compara apenas valores escalares comparáveis (price/rating/review_count) e
 * strings exatas (title/seller/category/availability).
 * Retorna os ids das evidências anteriores incompatíveis (vazio = sem conflito).
 */
export function detectContradictions(
  fieldName: string,
  newValue: unknown,
  previousEvidence: Array<{
    evidence_id: string;
    field_state: string;
    field_value: Record<string, unknown> | null;
  }>,
): string[] {
  if (newValue === null || newValue === undefined) return [];
  const conflictIds: string[] = [];
  for (const prev of previousEvidence) {
    if (prev.field_state === "COLLECTION_FAILED" || prev.field_state === "UNKNOWN")
      continue; // falha/ausência não contradiz
    const prevValue = prev.field_value?.value ?? prev.field_value;
    if (prevValue === null || prevValue === undefined) continue;

    if (typeof newValue === "number" && typeof prevValue === "number") {
      if (Math.abs(newValue - prevValue) > 1e-9) conflictIds.push(prev.evidence_id);
    } else if (typeof newValue === "string" && typeof prevValue === "string") {
      if (newValue.trim().toLowerCase() !== prevValue.trim().toLowerCase())
        conflictIds.push(prev.evidence_id);
    } else if (Array.isArray(newValue) && Array.isArray(prevValue)) {
      const a = JSON.stringify([...newValue].sort());
      const b = JSON.stringify([...prevValue].sort());
      if (a !== b) conflictIds.push(prev.evidence_id);
    }
  }
  return conflictIds;
}
