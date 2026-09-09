export const PUBLIC_PRODUCT_SAFE_KEYS = [
  "id",
  "ref",
  "produto",
  "categoria",
  "preco",
  "imagens",
  "link",
  "ativo",
  "destaque",
  "status",
  "slug",
  "descricao",
  "paginaPonteUrl",
  "pagina_ponte_url",
  "createdAt",
  "created_at",
  "ofertaPromocional",
  "oferta_promocional",
  "displayTitle",
  "display_title",
] as const;

export type PublicProductDTO = Partial<Record<(typeof PUBLIC_PRODUCT_SAFE_KEYS)[number], unknown>>;

const SAFE_KEYS = new Set<string>(PUBLIC_PRODUCT_SAFE_KEYS);

export const PUBLIC_PRODUCT_FORBIDDEN_KEYS = new Set([
  "curator_note",
  "curatorNote",
  "rawTitle",
  "raw_title",
  "imageEditorialStatus",
  "image_editorial_status",
  "imageCuration",
  "image_curation",
  "imageReviewedAt",
  "image_reviewed_at",
  "imageReviewModel",
  "image_review_model",
  "imageReviewVersion",
  "image_review_version",
  "imageReviewFingerprint",
  "image_review_fingerprint",
  "displayTitleStatus",
  "display_title_status",
  "displayTitleReviewedAt",
  "display_title_reviewed_at",
  "displayTitleReviewModel",
  "display_title_review_model",
  "displayTitleReviewVersion",
  "display_title_review_version",
  "createdBy",
  "created_by",
  "publicationAuthorization",
  "publication_authorization",
  "sourceIdentity",
  "source_identity",
  "lifecycle",
  "diagnostic",
  "diagnostics",
  "operationId",
  "operation_id",
]);

function activePublished(row: Record<string, unknown>): boolean {
  return row.ativo === true && String(row.status || "") === "published";
}

/**
 * Single public catalog boundary. It is intentionally whitelist-based so newly
 * added internal/editorial/audit fields cannot leak unless explicitly reviewed
 * and added here.
 */
export function toPublicProductDTO(value: unknown): PublicProductDTO | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!activePublished(row)) return null;

  const dto: PublicProductDTO = {};
  for (const [key, raw] of Object.entries(row)) {
    if (!SAFE_KEYS.has(key)) continue;
    if (key === "descricao" && typeof raw === "string") {
      const normalized = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const containsRawMarker = [
        "[url final]",
        "[titulo identificado]",
        "[preco identificado]",
        "[total imagens oficiais]",
        "[imagens extraidas]",
        "[conteudo da pagina]",
      ].some(marker => normalized.includes(marker));
      (dto as Record<string, unknown>)[key] = containsRawMarker ? "" : raw;
      continue;
    }
    (dto as Record<string, unknown>)[key] = raw;
  }
  return dto;
}

export function toPublicProductList(values: readonly unknown[]): PublicProductDTO[] {
  return values.map(toPublicProductDTO).filter((value): value is PublicProductDTO => value !== null);
}

export function assertPublicProductDTO(value: unknown): asserts value is PublicProductDTO {
  if (!value || typeof value !== "object") throw new Error("PUBLIC_PRODUCT_DTO_INVALID");
  const row = value as Record<string, unknown>;
  if (!activePublished(row)) throw new Error("PUBLIC_PRODUCT_DTO_NOT_ACTIVE_PUBLISHED");
  for (const key of Object.keys(row)) {
    if (!SAFE_KEYS.has(key) || PUBLIC_PRODUCT_FORBIDDEN_KEYS.has(key)) {
      throw new Error(`PUBLIC_PRODUCT_DTO_FORBIDDEN_FIELD:${key}`);
    }
  }
}
