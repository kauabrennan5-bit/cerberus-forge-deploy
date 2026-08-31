import type { Product } from "../../src/types";
import { PUBLIC_PRODUCT_CATEGORIES } from "../../src/lib/productCategory";
import { isPublicHttpsImageUrl, resolveCanonicalProductImage } from "../../src/lib/productCanonical";
import { isValidProductLink } from "../repositories/productsRepository";
import {
  DISPLAY_TITLE_REVIEW_VERSION,
  IMAGE_REVIEW_VERSION,
  imageUrlFingerprint,
} from "./productEditorialReview";
import { evaluateWeeklyProductEligibility, type WeeklyComposition } from "./newsletterWeeklyEditorial";
import type { WeeklyNewsletterCopy } from "./newsletterWeeklyCopy";

export const WEEKLY_DESIGN_TEST_PRODUCT_COUNT = 8;
const DESIGN_TEST_REVIEW_MODEL = "weekly-design-test-exception";

type DesignCandidate = {
  product: Product;
  primaryImageUrl: string;
  strictlyEligible: boolean;
};

export type WeeklyDesignTestSelection = {
  products: Product[];
  composition: WeeklyComposition;
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function validRef(value: unknown): boolean {
  const ref = clean(value);
  return Boolean(ref && /^[A-Za-z0-9][A-Za-z0-9._-]{1,119}$/.test(ref));
}

function candidateImage(product: Product): string {
  const canonical = resolveCanonicalProductImage(product).primaryImageUrl;
  if (canonical && isPublicHttpsImageUrl(canonical)) return canonical;
  return product.imagens.find(isPublicHttpsImageUrl) || "";
}

function designCandidate(product: Product, now: Date): DesignCandidate | null {
  if (product.ativo !== true || product.status !== "published") return null;
  if (!validRef(product.ref) || !isValidProductLink(product.link)) return null;
  if (!PUBLIC_PRODUCT_CATEGORIES.includes(clean(product.categoria) as (typeof PUBLIC_PRODUCT_CATEGORIES)[number])) return null;
  if (!Number.isFinite(Number(product.preco)) || Number(product.preco) <= 0) return null;
  const primaryImageUrl = candidateImage(product);
  if (!primaryImageUrl) return null;
  return {
    product,
    primaryImageUrl,
    strictlyEligible: evaluateWeeklyProductEligibility(product, now).eligible,
  };
}

function createdAtMs(product: Product): number {
  const parsed = product.createdAt ? Date.parse(product.createdAt) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function projectForDesignTest(candidate: DesignCandidate, position: number, now: Date): Product {
  if (candidate.strictlyEligible) return structuredClone(candidate.product);

  const title = `Seleção Cerberus ${position}`;
  const reviewedAt = now.toISOString();
  const primaryImageUrl = candidate.primaryImageUrl;
  return {
    ...structuredClone(candidate.product),
    produto: title,
    rawTitle: `Registro interno ${candidate.product.id}`,
    displayTitle: title,
    displayTitleStatus: "ready",
    displayTitleReviewedAt: reviewedAt,
    displayTitleReviewModel: DESIGN_TEST_REVIEW_MODEL,
    displayTitleReviewVersion: DISPLAY_TITLE_REVIEW_VERSION,
    descricao: "Conteúdo reservado para avaliação interna do layout.",
    curatorNote: "Card interno de prévia visual; não representa aprovação editorial de produção.",
    imagens: [primaryImageUrl],
    imageEditorialStatus: "clean",
    imageCuration: {
      status: "ready",
      rawImageUrls: [primaryImageUrl],
      primaryImageUrl,
      galleryImageUrls: [],
      assessments: [{
        url: primaryImageUrl,
        decision: "clean",
        confidence: "HIGH",
        reason: "Projeção efêmera autorizada exclusivamente para teste de design.",
      }],
    },
    imageReviewedAt: reviewedAt,
    imageReviewModel: DESIGN_TEST_REVIEW_MODEL,
    imageReviewVersion: IMAGE_REVIEW_VERSION,
    imageReviewFingerprint: imageUrlFingerprint(primaryImageUrl),
  };
}

/**
 * Exceção efêmera para um único design-test. Nunca grava em products e nunca
 * muda a elegibilidade canônica: somente a projeção retornada contém os campos
 * necessários para renderizar a edição editorial completa de oito cards no
 * email destinado ao administrador.
 */
export function selectWeeklyDesignTestProducts(
  products: readonly Product[],
  now = new Date(),
): WeeklyDesignTestSelection {
  const candidates = products
    .map(product => designCandidate(product, now))
    .filter((candidate): candidate is DesignCandidate => Boolean(candidate))
    .sort((a, b) => Number(b.strictlyEligible) - Number(a.strictlyEligible)
      || createdAtMs(b.product) - createdAtMs(a.product)
      || a.product.id.localeCompare(b.product.id));

  if (candidates.length < WEEKLY_DESIGN_TEST_PRODUCT_COUNT) {
    return { products: [], composition: { mode: "diversified", categories: [], products: [], duplicateProductIds: [] } };
  }

  const selected = candidates
    .slice(0, WEEKLY_DESIGN_TEST_PRODUCT_COUNT)
    .map((candidate, index) => projectForDesignTest(candidate, index + 1, now));
  const categories = [...new Set(selected.map(product => clean(product.categoria)))];
  const mode = categories.length === 1 ? "thematic" : "diversified";
  return {
    products: selected,
    composition: { mode, categories, products: selected, duplicateProductIds: [] },
  };
}

export function buildWeeklyDesignTestCopy(
  products: readonly Product[],
  now = new Date(),
): WeeklyNewsletterCopy {
  if (products.length !== WEEKLY_DESIGN_TEST_PRODUCT_COUNT) {
    throw new Error("WEEKLY_DESIGN_TEST_PRODUCT_COUNT_INVALID");
  }
  const secondaryCaptions = Object.fromEntries(
    products.slice(1).map(product => [
      product.id,
      "Card interno para revisar imagem, hierarquia, preço e ritmo visual.",
    ]),
  );
  const editionDate = now.toISOString().slice(0, 10);
  return {
    subject: `[Teste controlado] Novidades da semana — Edição ${editionDate} · 8 novos achados`,
    previewText: "Uma edição curta para descobrir o que saiu do óbvio.",
    heroHeadline: "UM OLHAR ATENTO PARA O QUE ENTRA.",
    heroBody: "Uma edição curta para descobrir o que saiu do óbvio.",
    secondaryCaptions,
  };
}
