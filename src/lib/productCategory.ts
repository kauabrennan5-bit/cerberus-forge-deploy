export const PUBLIC_PRODUCT_CATEGORIES = [
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
] as const;

export type PublicProductCategory = (typeof PUBLIC_PRODUCT_CATEGORIES)[number];

function normalizeCategoryToken(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[&+]/g, " e ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CATEGORY_ALIASES: Record<string, PublicProductCategory> = {
  iluminacao: "Iluminação",
  luminarias: "Iluminação",
  luminaria: "Iluminação",
  lampadas: "Iluminação",
  lampada: "Iluminação",
  lustres: "Iluminação",
  decoracao: "Decoração",
  casa: "Decoração",
  design: "Decoração",
  moveis: "Móveis",
  movel: "Móveis",
  cozinha: "Cozinha & Mesa",
  mesa: "Cozinha & Mesa",
  "cozinha e mesa": "Cozinha & Mesa",
  "mesa posta": "Cozinha & Mesa",
  organizacao: "Organização",
  organizadores: "Organização",
  organizador: "Organização",
  vestuario: "Vestuário",
  roupas: "Vestuário",
  roupa: "Vestuário",
  jaqueta: "Vestuário",
  jaquetas: "Vestuário",
  calcados: "Calçados & Acessórios",
  calcado: "Calçados & Acessórios",
  acessorios: "Calçados & Acessórios",
  acessorio: "Calçados & Acessórios",
  tecnologia: "Tecnologia",
  eletronicos: "Tecnologia",
  eletronico: "Tecnologia",
  beleza: "Beleza & Bem-estar",
  "beleza e bem estar": "Beleza & Bem-estar",
  infantil: "Infantil",
  brinquedos: "Infantil",
};

const INTERNAL_CATEGORY_TOKENS = new Set([
  "afiliado",
  "affiliate",
  "affiliate preview",
  "affiliate_preview",
  "affiliate preview category",
  "preview",
  "internal",
  "tecnico",
  "technical",
]);

function includesAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(term));
}

/**
 * Infere somente categorias já existentes na taxonomia pública. A ordem é
 * deliberada: termos de produto específico vencem palavras genéricas como
 * "mesa" ou "casa".
 */
export function inferPublicProductCategory(input: {
  category?: string | null;
  title?: string | null;
  description?: string | null;
}): PublicProductCategory | "" {
  const category = normalizeCategoryToken(input.category || "");
  const title = normalizeCategoryToken(input.title || "");
  const description = normalizeCategoryToken(input.description || "");
  const text = [category, title, description].filter(Boolean).join(" ");

  const directAlias = CATEGORY_ALIASES[category];
  if (directAlias) return directAlias;

  if (includesAny(text, ["luminaria", "abajur", "pendente", "lampada", "lustre", "arandela", "led", "cogumelo"])) {
    return "Iluminação";
  }
  if (includesAny(text, ["talher", "cozinha", "mesa posta", "copos", "prato", "panela", "bandeja", "jantar"])) {
    return "Cozinha & Mesa";
  }
  if (includesAny(text, ["sofa", "cadeira", "estante", "armario", "rack", "banco", "movel"])) {
    return "Móveis";
  }
  if (includesAny(text, ["tenis", "sapato", "sandalia", "bolsa", "cinto", "acessorio", "oculos"])) {
    return "Calçados & Acessórios";
  }
  if (includesAny(text, ["camisa", "jaqueta", "vestido", "calca", "shorts", "blusa", "moletom", "roupa"])) {
    return "Vestuário";
  }
  if (includesAny(text, ["organizador", "caixa organizadora", "gaveteiro", "cabide"])) {
    return "Organização";
  }
  if (includesAny(text, ["fone", "carregador", "teclado", "mouse", "usb", "smart", "eletronico"])) {
    return "Tecnologia";
  }
  if (includesAny(text, ["creme", "serum", "maquiagem", "skincare", "perfume"])) {
    return "Beleza & Bem-estar";
  }
  if (includesAny(text, ["brinquedo", "infantil", "bebe", "crianca"])) {
    return "Infantil";
  }
  if (includesAny(text, ["vaso", "quadro", "espelho", "escultura", "decoracao", "decorativo"])) {
    return "Decoração";
  }

  return "";
}

export function isInternalProductCategory(category: string | null | undefined): boolean {
  const normalized = normalizeCategoryToken(category || "");
  return INTERNAL_CATEGORY_TOKENS.has(normalized) || normalized.includes("affiliate");
}

/**
 * Resolve uma categoria pública sem permitir que metadados internos como
 * AFILIADO cheguem à vitrine. Para categorias técnicas sem sinais suficientes,
 * retorna vazio para que o fluxo possa permanecer em revisão.
 */
export function resolvePublicProductCategory(
  category: string | null | undefined,
  context: { title?: string | null; description?: string | null } = {},
): string {
  const raw = typeof category === "string" ? category.trim() : "";
  if (!raw || isInternalProductCategory(raw)) {
    return inferPublicProductCategory({ category: raw, ...context });
  }

  const normalized = normalizeCategoryToken(raw);
  const exact = PUBLIC_PRODUCT_CATEGORIES.find((item) => normalizeCategoryToken(item) === normalized);
  if (exact) return exact;

  const contentCategory = inferPublicProductCategory({ category: "", ...context });
  return contentCategory || CATEGORY_ALIASES[normalized] || "";
}
