/**
 * The single public product boundary used by Edge, Render, static export and
 * the storefront.  It is intentionally a whitelist: adding an internal column
 * to `products` can never make that column public by accident.
 */

const PUBLIC_PRODUCT_CATEGORIES = new Set([
  "Iluminação",
  "Decoração",
  "Móveis",
  "Cozinha & Mesa",
  "Organização",
  "Vestuário",
  "Calçados & Acessórios",
  "Tecnologia",
  "Beleza & Bem-estar",
  "Infantil",
]);

const RAW_PAYLOAD_MARKERS = [
  "[url final]",
  "[titulo identificado]",
  "[preco identificado]",
  "[total imagens oficiais]",
  "[imagens extraidas]",
  "[conteudo da pagina]",
];

export type PublicProductDTO = {
  id: string;
  ref?: string;
  slug: string;
  produto: string;
  displayTitle?: string;
  categoria: string;
  preco: number;
  imagens: string[];
  link: string;
  destaque: boolean;
  descricao: string;
  paginaPonteUrl: string;
  createdAt?: string;
  ofertaPromocional?: Record<string, unknown>;
  ativo: true;
  status: "published";
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function first(record: Record<string, unknown>, camel: string, snake: string): unknown {
  return record[camel] ?? record[snake];
}

function validHttpsUrl(value: unknown): boolean {
  try {
    return new URL(text(value)).protocol === "https:";
  } catch {
    return false;
  }
}

function validShopeeLink(value: unknown): boolean {
  try {
    const url = new URL(text(value));
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "shopee.com.br" || host.endsWith(".shopee.com.br"));
  } catch {
    return false;
  }
}

function isHumanGovernedCreator(value: unknown): boolean {
  const creator = text(value).toLowerCase();
  return creator === "telegram_manual"
    || creator === "telegram_rotation_candidate"
    || creator.includes("autonomous_curator");
}

function hasCurrentHumanApproval(row: Record<string, unknown>, primaryImageUrl: string): boolean {
  const approvedAt = text(first(row, "humanEditorialApprovedAt", "human_editorial_approved_at"));
  return text(first(row, "humanEditorialImageUrl", "human_editorial_image_url")) === primaryImageUrl
    && Boolean(approvedAt && Number.isFinite(Date.parse(approvedAt)))
    && Boolean(text(first(row, "humanEditorialReviewId", "human_editorial_review_id")))
    && Boolean(text(first(row, "humanEditorialAuthorizationId", "human_editorial_authorization_id")))
    && /^sha256:[0-9a-f]{64}$/.test(text(first(row, "humanEditorialImageFingerprint", "human_editorial_image_fingerprint")));
}

function publicImages(value: unknown): string[] {
  let input = value;
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { input = []; }
  }
  if (!Array.isArray(input)) return [];
  return input
    .filter((image): image is string => typeof image === "string" && validHttpsUrl(image))
    .map(image => image.trim())
    .filter((image, index, images) => images.indexOf(image) === index);
}

function publicDescription(value: unknown): string {
  const description = text(value);
  const normalized = description.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return RAW_PAYLOAD_MARKERS.some(marker => normalized.includes(marker)) ? "" : description;
}

function publicPromotion(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const offer = value as Record<string, unknown>;
  const price = Number(offer.price);
  const confirmedAt = Number(offer.confirmedAt);
  const expiresAt = Number(offer.expiresAt);
  const condition = text(offer.condition);
  if (!Number.isFinite(price) || price <= 0) return undefined;
  if (!["pix", "pix_with_coupon", "coupon", "other"].includes(condition)) return undefined;
  if (offer.source !== "admin_confirmed") return undefined;
  if (!Number.isFinite(confirmedAt) || confirmedAt <= 0) return undefined;
  if (!Number.isFinite(expiresAt) || expiresAt <= confirmedAt) return undefined;
  const benefits = Array.isArray(offer.benefits)
    ? offer.benefits.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map(item => item.trim()).slice(0, 8)
    : [];
  return { price, condition, benefits, source: "admin_confirmed", confirmedAt, expiresAt };
}

export function toPublicProductDTO(value: unknown): PublicProductDTO | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.ativo !== true || row.status !== "published") return null;

  const id = text(row.id);
  const produto = text(row.produto);
  const displayTitle = text(first(row, "displayTitle", "display_title"));
  const categoria = text(row.categoria ?? row.category);
  const preco = Number(row.preco ?? row.price);
  const imagens = publicImages(row.imagens);
  const link = text(row.link ?? row.affiliate_url);
  if (!id || !produto || !PUBLIC_PRODUCT_CATEGORIES.has(categoria)) return null;
  if (!Number.isFinite(preco) || preco <= 0 || imagens.length === 0 || !validShopeeLink(link)) return null;
  const createdBy = first(row, "createdBy", "created_by");
  if (isHumanGovernedCreator(createdBy) && !hasCurrentHumanApproval(row, imagens[0])) return null;

  const dto: PublicProductDTO = {
    id,
    slug: text(row.slug) || id,
    produto,
    categoria,
    preco,
    imagens,
    link,
    destaque: row.destaque === true,
    descricao: publicDescription(row.descricao ?? row.description),
    paginaPonteUrl: text(first(row, "paginaPonteUrl", "pagina_ponte_url")),
    ativo: true,
    status: "published",
  };
  const ref = text(row.ref ?? row.ref_code);
  const createdAt = text(first(row, "createdAt", "created_at"));
  const promotion = publicPromotion(first(row, "ofertaPromocional", "oferta_promocional"));
  if (ref) dto.ref = ref;
  if (displayTitle) dto.displayTitle = displayTitle;
  if (createdAt) dto.createdAt = createdAt;
  if (promotion) dto.ofertaPromocional = promotion;
  return dto;
}

export function toPublicProductDTOs(values: unknown): PublicProductDTO[] {
  if (!Array.isArray(values)) return [];
  return values.map(toPublicProductDTO).filter((item): item is PublicProductDTO => item !== null);
}

export const PUBLIC_PRODUCT_DTO_FIELDS = Object.freeze([
  "id", "ref", "slug", "produto", "displayTitle", "categoria", "preco", "imagens", "link",
  "destaque", "descricao", "paginaPonteUrl", "createdAt", "ofertaPromocional", "ativo", "status",
] as const);
