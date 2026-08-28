from pathlib import Path
import re


def read(path: str) -> str:
    return Path(path).read_text(encoding='utf-8')


def write(path: str, text: str) -> None:
    Path(path).write_text(text, encoding='utf-8')


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 occurrence, found {count}')
    return text.replace(old, new, 1)


# ---------------------------------------------------------------------------
# Single public taxonomy resolver
# ---------------------------------------------------------------------------
path = 'src/lib/productCategory.ts'
text = read(path)
text = replace_once(
    text,
    '  casa: "Decoração",\n',
    '  casa: "Decoração",\n  "casa e decoracao": "Decoração",\n',
    'productCategory legacy alias',
)
insert_marker = '''export function isInternalProductCategory(category: string | null | undefined): boolean {
'''
addition = '''export function isPublicProductCategory(category: string | null | undefined): category is PublicProductCategory {
  if (typeof category !== "string" || !category.trim()) return false;
  const normalized = normalizeCategoryToken(category);
  return PUBLIC_PRODUCT_CATEGORIES.some((item) => normalizeCategoryToken(item) === normalized);
}

'''
text = replace_once(text, insert_marker, addition + insert_marker, 'productCategory public validator')
text = text.replace('): string {\n  const raw = typeof category', '): PublicProductCategory | "" {\n  const raw = typeof category', 1)
write(path, text)

# ---------------------------------------------------------------------------
# Frontend public projection: no Geral fallback; invalid public records are hidden.
# ---------------------------------------------------------------------------
path = 'src/services/api.ts'
text = read(path)
text = replace_once(
    text,
    'import { SOCIAL_LABELS, type SocialNetwork } from "../config/institutional";\n',
    'import { SOCIAL_LABELS, type SocialNetwork } from "../config/institutional";\nimport { resolvePublicProductCategory } from "../lib/productCategory";\n',
    'api product category import',
)
start = text.index('  console.log(`[Catalog] ${list.length} produtos carregados de /data/products.json.`);')
end = text.index('\n}\n\nexport async function verifyAdminPassword', start)
old = text[start:end]
new = '''  console.log(`[Catalog] ${list.length} produtos carregados de /data/products.json.`);
  const normalized = list.map((p: any) => ({
    ...p,
    id: String(p.id || ''),
    produto: p.produto || '',
    displayTitle: typeof (p.displayTitle || p.display_title) === 'string' ? (p.displayTitle || p.display_title).trim() : undefined,
    curatorNote: typeof (p.curatorNote || p.curator_note) === 'string' ? (p.curatorNote || p.curator_note).trim() : undefined,
    preco: Number(p.preco) || 0,
    imagens: Array.isArray(p.imagens)
      ? p.imagens
      : (typeof p.imagens === 'string' ? JSON.parse(p.imagens) : (p.imagem ? [p.imagem] : [])),
    link: p.link || p.url || '',
    categoria: resolvePublicProductCategory(p.categoria || p.category, {
      title: p.displayTitle || p.display_title || p.produto || p.title || p.name,
      description: p.descricao || p.description,
    }),
    createdAt: typeof (p.createdAt || p.created_at) === 'string' ? (p.createdAt || p.created_at) : undefined,
    ativo: p.ativo !== false,
    status: p.status || 'published'
  }));
  const publicProducts = normalized.filter((product: any) => Boolean(product.categoria));
  if (publicProducts.length !== normalized.length) {
    console.warn(`[Catalog] ${normalized.length - publicProducts.length} produto(s) omitido(s): PUBLIC_CATEGORY_REVIEW_REQUIRED.`);
  }
  return publicProducts;'''
text = text[:start] + new + text[end:]
write(path, text)

# ---------------------------------------------------------------------------
# Canonical persistence: every write must resolve to the existing public taxonomy.
# ---------------------------------------------------------------------------
path = 'server/repositories/productsRepository.ts'
text = read(path)
marker = '''/**
 * Salva a lista de produtos diretamente na tabela public.products do Supabase
 */
'''
helper = '''export function resolveProductCategoryForPersistence(input: {
  categoria?: string | null;
  produto?: string | null;
  displayTitle?: string | null;
  rawTitle?: string | null;
  descricao?: string | null;
}): string {
  const category = resolvePublicProductCategory(input.categoria, {
    title: input.displayTitle || input.rawTitle || input.produto,
    description: input.descricao,
  });
  if (!category) throw new Error("PUBLIC_CATEGORY_REVIEW_REQUIRED");
  return category;
}

'''
text = replace_once(text, marker, helper + marker, 'productsRepository category helper')
text = replace_once(
    text,
    '  const formatted = products.map((p) => {\n    const productRow: Record<string, unknown> = {',
    '  const formatted = products.map((p) => {\n    const publicCategory = resolveProductCategoryForPersistence(p);\n    const productRow: Record<string, unknown> = {',
    'productsRepository save category resolve',
)
text = replace_once(text, '      categoria: p.categoria,\n', '      categoria: publicCategory,\n', 'productsRepository save canonical category')
text = replace_once(
    text,
    '  const products = await getProducts();\n  const inputLink = input.link.trim();\n',
    '  const products = await getProducts();\n  const publicCategory = resolveProductCategoryForPersistence(input);\n  const inputLink = input.link.trim();\n',
    'productsRepository create category gate',
)
text = text.replace('      categoria: input.categoria.trim(),', '      categoria: publicCategory,', 1)
text = text.replace('    categoria: input.categoria.trim(),', '    categoria: publicCategory,', 1)
old_update = '''  const updatedProduct: Product = {
    ...products[index],
    ...updateData,
    ...(updateData.produto ? { slug: generateSlug(updateData.produto) } : {})
  };
'''
new_update = '''  const mergedProduct: Product = {
    ...products[index],
    ...updateData,
    ...(updateData.produto ? { slug: generateSlug(updateData.produto) } : {})
  };
  const updatedProduct: Product = {
    ...mergedProduct,
    categoria: resolveProductCategoryForPersistence(mergedProduct),
  };
'''
text = replace_once(text, old_update, new_update, 'productsRepository update category gate')
write(path, text)

# ---------------------------------------------------------------------------
# Product automation returns the same readiness code as lifecycle/canonical.
# ---------------------------------------------------------------------------
path = 'server/services/productAutomation.ts'
text = read(path)
text = replace_once(
    text,
    'if (!curatedCategory) return { success: false, error: "CATEGORY_REVIEW_REQUIRED" };',
    'if (!curatedCategory) return { success: false, error: "PUBLIC_CATEGORY_REVIEW_REQUIRED" };',
    'productAutomation category code',
)
write(path, text)

# ---------------------------------------------------------------------------
# Governed publication: preflight resolves category to canonical taxonomy or fails closed.
# ---------------------------------------------------------------------------
path = 'server/commercial/publication/contract.ts'
text = read(path)
text = replace_once(
    text,
    '  | "MISSING_CATEGORY"\n',
    '  | "MISSING_CATEGORY"\n  | "PUBLIC_CATEGORY_REVIEW_REQUIRED"\n',
    'publication contract category failure code',
)
write(path, text)

path = 'server/commercial/publication/publicationExecutor.ts'
text = read(path)
import_marker = 'import type { ApprovalDecisionState } from "../../agentRuntime/types";\n'
text = replace_once(
    text,
    import_marker,
    import_marker + 'import { resolvePublicProductCategory } from "../../../src/lib/productCategory";\n',
    'publication executor category import',
)
old_gate = '''  if (!candidate.category || !candidate.category.trim()) {
    return { ok: false, candidate, assessment, failureCode: "MISSING_CATEGORY", reason: "categoria ausente" };
  }
'''
new_gate = '''  if (!candidate.category || !candidate.category.trim()) {
    return { ok: false, candidate, assessment, failureCode: "MISSING_CATEGORY", reason: "categoria ausente" };
  }
  const publicCategory = resolvePublicProductCategory(candidate.category, {
    title: candidate.title,
    description: candidate.description,
  });
  if (!publicCategory) {
    return {
      ok: false,
      candidate,
      assessment,
      failureCode: "PUBLIC_CATEGORY_REVIEW_REQUIRED",
      reason: "categoria não pertence à taxonomia pública e não pôde ser resolvida com confiança",
    };
  }
  const canonicalCandidate: CandidateForPublication = publicCategory === candidate.category.trim()
    ? candidate
    : Object.freeze({ ...candidate, category: publicCategory });
'''
text = replace_once(text, old_gate, new_gate, 'publication executor public category gate')
# After category gate, all success/failure paths must expose the normalized candidate.
# Replace the final successful return only; earlier failures intentionally preserve the raw candidate for diagnostics.
text = replace_once(text, '  return { ok: true, candidate, assessment };\n', '  return { ok: true, candidate: canonicalCandidate, assessment };\n', 'publication executor canonical candidate return')
text = replace_once(
    text,
    ': preflight.failureCode === "PRICE_UNKNOWN" || preflight.failureCode === "MISSING_TITLE" || preflight.failureCode === "MISSING_CATEGORY"\n          ? "MISSING_DATA"',
    ': preflight.failureCode === "PRICE_UNKNOWN" || preflight.failureCode === "MISSING_TITLE" || preflight.failureCode === "MISSING_CATEGORY"\n          ? "MISSING_DATA"\n        : preflight.failureCode === "PUBLIC_CATEGORY_REVIEW_REQUIRED"\n          ? "VALIDATION_FAILED"',
    'publication executor category outcome mapping',
)
write(path, text)

# ---------------------------------------------------------------------------
# Telegram review/editor: same resolver, canonical prompt, readiness gate.
# ---------------------------------------------------------------------------
path = 'server/services/telegramBot.ts'
text = read(path)
import_marker = 'import { resolveCanonicalProductImage } from "../../src/lib/productCanonical";\n'
text = replace_once(
    text,
    import_marker,
    import_marker + 'import { PUBLIC_PRODUCT_CATEGORIES, resolvePublicProductCategory } from "../../src/lib/productCategory";\n',
    'telegram category import',
)
interface_end = '}\n\nfunction formatPromotionCondition('
helper = '''}

export function resolveTelegramReviewCategory(
  review: Pick<PendingReview, "categoria" | "produto" | "rawTitle" | "displayTitle" | "descricao">,
  requestedCategory: string | null | undefined = review.categoria,
): string {
  return resolvePublicProductCategory(requestedCategory, {
    title: review.displayTitle || review.rawTitle || review.produto,
    description: review.descricao,
  });
}

function formatPromotionCondition('''
text = replace_once(text, interface_end, helper, 'telegram review category helper')
completeness_marker = '  const description = stripRawAffiliateProvenance(review.descricao || "").trim();\n'
completeness_addition = '''  const publicCategory = resolveTelegramReviewCategory(review);
  if (!publicCategory || publicCategory !== review.categoria.trim()) errors.push("PUBLIC_CATEGORY_REVIEW_REQUIRED");
'''
text = replace_once(text, completeness_marker, completeness_marker + completeness_addition, 'telegram completeness category gate')
old_prompt = '      if (chatId) await sendTelegramMessage(chatId, "📁 <b>DIGITE A NOVA CATEGORIA:</b>\\nExemplos: <code>Camisetas</code>, <code>Calças</code>, <code>Acessórios</code>, <code>Calçados</code>, <code>Jaquetas</code> ou <code>Moletons</code>.");'
new_prompt = '      if (chatId) await sendTelegramMessage(chatId, `📁 <b>DIGITE A CATEGORIA PÚBLICA:</b>\\nCategorias válidas: <code>${PUBLIC_PRODUCT_CATEGORIES.join("</code>, <code>")}</code>.`);'
text = replace_once(text, old_prompt, new_prompt, 'telegram category prompt')
old_manual = '''      if (category.length < 2 || category.length > 60) {
        if (chatId) await sendTelegramMessage(chatId, "❌ Categoria inválida. Digite um nome entre 2 e 60 caracteres.");
        return;
      }

      targetReview.categoria = category;
'''
new_manual = '''      if (category.length < 2 || category.length > 60) {
        if (chatId) await sendTelegramMessage(chatId, "❌ Categoria inválida. Digite um nome entre 2 e 60 caracteres.");
        return;
      }
      const publicCategory = resolveTelegramReviewCategory(targetReview, category);
      if (!publicCategory) {
        if (chatId) await sendTelegramMessage(chatId, `❌ PUBLIC_CATEGORY_REVIEW_REQUIRED. Use uma categoria pública válida: <code>${PUBLIC_PRODUCT_CATEGORIES.join("</code>, <code>")}</code>.`);
        return;
      }

      targetReview.categoria = publicCategory;
'''
text = replace_once(text, old_manual, new_manual, 'telegram review manual category')
text = replace_once(
    text,
    'if (chatId) await sendTelegramMessage(chatId, `✅ Categoria atualizada para <b>${category}</b>.`);',
    'if (chatId) await sendTelegramMessage(chatId, `✅ Categoria atualizada para <b>${targetReview.categoria}</b>.`);',
    'telegram review category confirmation',
)
generic_else = '''      } else {
        update[field] = text;
      }
      try {
        await productsRepository.updateProduct(prodId, update);
'''
generic_replacement = '''      } else if (field === "categoria") {
        const product = await productsRepository.getProductByIdOrSlug(prodId);
        const publicCategory = resolvePublicProductCategory(text, {
          title: product?.displayTitle || product?.rawTitle || product?.produto,
          description: product?.descricao,
        });
        if (!publicCategory) {
          if (chatId) await sendTelegramMessage(chatId, `❌ PUBLIC_CATEGORY_REVIEW_REQUIRED. Use uma categoria pública válida: <code>${PUBLIC_PRODUCT_CATEGORIES.join("</code>, <code>")}</code>.`);
          return;
        }
        update.categoria = publicCategory;
      } else {
        update[field] = text;
      }
      try {
        await productsRepository.updateProduct(prodId, update);
'''
text = replace_once(text, generic_else, generic_replacement, 'telegram published category edit')
write(path, text)

# ---------------------------------------------------------------------------
# Static build: execute through tsx so it can import the canonical TS taxonomy.
# ---------------------------------------------------------------------------
path = 'package.json'
text = read(path)
text = replace_once(
    text,
    '"build": "node scripts/generate-static-catalog.js && vite build',
    '"build": "tsx scripts/generate-static-catalog.js && vite build',
    'package build taxonomy loader',
)
write(path, text)

path = 'scripts/generate-static-catalog.js'
text = read(path)
text = replace_once(
    text,
    "import dotenv from 'dotenv';\n",
    "import dotenv from 'dotenv';\nimport { resolvePublicProductCategory } from '../src/lib/productCategory.ts';\n",
    'static catalog category import',
)
filter_marker = "    if (p.ativo === false || p.status !== 'published') return false;\n    return true;\n"
filter_new = '''    if (p.ativo === false || p.status !== 'published') return false;
    const publicCategory = resolvePublicProductCategory(p.categoria || p.category, {
      title: p.displayTitle || p.display_title || p.raw_title || p.produto || p.title || p.name,
      description: p.descricao || p.description,
    });
    if (!publicCategory) {
      console.warn(`[Build Catalog] Produto ${p.id || p.ref || 'sem-id'} omitido: PUBLIC_CATEGORY_REVIEW_REQUIRED.`);
      return false;
    }
    return true;
'''
text = replace_once(text, filter_marker, filter_new, 'static catalog category filter')
text = replace_once(
    text,
    "    categoria: p.categoria || 'Geral',\n",
    "    categoria: resolvePublicProductCategory(p.categoria || p.category, {\n      title: p.displayTitle || p.display_title || p.raw_title || p.produto || p.title || p.name,\n      description: p.descricao || p.description,\n    }),\n",
    'static catalog canonical category projection',
)
write(path, text)

# ---------------------------------------------------------------------------
# Tests: taxonomy, publication preflight, repository persistence and Telegram path.
# ---------------------------------------------------------------------------
path = 'tests/telegramAndMarketplace.test.ts'
text = read(path)
text = replace_once(
    text,
    'import { buildProductListView } from "../server/services/telegramBot";\n',
    'import { buildProductListView, resolveTelegramReviewCategory } from "../server/services/telegramBot";\n',
    'telegram test helper import',
)
insert_before = 'test("rawContent técnico em descricao é detectado e limpo na normalização", () => {'
new_test = '''test("Telegram resolve edição de categoria somente para a taxonomia pública", () => {
  const review = {
    categoria: "affiliate_preview",
    produto: "Abajur LED Cogumelo",
    rawTitle: "Abajur LED Cogumelo",
    displayTitle: "Abajur LED Cogumelo",
    descricao: "Luminária retrô para mesa",
  };
  assert.equal(resolveTelegramReviewCategory(review as any), "Iluminação");
  assert.equal(resolveTelegramReviewCategory({ ...review, produto: "Produto sem sinais", rawTitle: "Produto sem sinais", displayTitle: "Produto sem sinais", descricao: "" } as any, "AFILIADO"), "");
  assert.equal(resolveTelegramReviewCategory(review as any, "Acessórios"), "Iluminação");
});

test("Telegram não aceita mais categoria livre no caminho de review/publicação", () => {
  const source = readFileSync(new URL("../server/services/telegramBot.ts", import.meta.url), "utf8");
  assert.match(source, /PUBLIC_PRODUCT_CATEGORIES/);
  assert.match(source, /resolveTelegramReviewCategory\(targetReview, category\)/);
  assert.match(source, /PUBLIC_CATEGORY_REVIEW_REQUIRED/);
  assert.doesNotMatch(source, /targetReview\.categoria = category;/);
});

'''
text = replace_once(text, insert_before, new_test + insert_before, 'telegram category tests')
# The static generator now uses the shared TS resolver and is launched by tsx.
text = text.replace('new URL("../scripts/generate-static-catalog.js", import.meta.url)', 'new URL("../scripts/generate-static-catalog.js", import.meta.url)')
write(path, text)

Path('tests/publicCategoryPipeline.test.ts').write_text(r'''import test from "node:test";
import assert from "node:assert/strict";
import { PUBLIC_PRODUCT_CATEGORIES, isPublicProductCategory, resolvePublicProductCategory } from "../src/lib/productCategory";
import { resolveProductCategoryForPersistence } from "../server/repositories/productsRepository";
import { preflightPublication, type PublicationRepositoryAdapter } from "../server/commercial/publication/publicationExecutor";

test("taxonomia pública resolve exemplos obrigatórios sem inventar categoria", () => {
  assert.equal(resolvePublicProductCategory("", { title: "Abajur LED Cogumelo" }), "Iluminação");
  assert.equal(resolvePublicProductCategory("", { title: "Organizador Porta-Talher" }), "Cozinha & Mesa");
  assert.equal(resolvePublicProductCategory("AFILIADO", { title: "Abajur LED Cogumelo" }), "Iluminação");
  assert.equal(resolvePublicProductCategory("affiliate_preview", { title: "Produto sem sinais" }), "");
  assert.equal(resolvePublicProductCategory("Acessórios", { title: "Bolsa feminina" }), "Calçados & Acessórios");
  assert.equal(resolvePublicProductCategory("Categoria inventada", { title: "Produto sem sinais" }), "");
  assert.equal(isPublicProductCategory("Iluminação"), true);
  assert.equal(isPublicProductCategory("AFILIADO"), false);
  assert.equal(isPublicProductCategory("Acessórios"), false);
  assert.ok(PUBLIC_PRODUCT_CATEGORIES.every(isPublicProductCategory));
});

test("persistência canônica normaliza alias e falha closed quando não há categoria pública", () => {
  assert.equal(resolveProductCategoryForPersistence({ categoria: "Acessórios", produto: "Bolsa de couro" }), "Calçados & Acessórios");
  assert.equal(resolveProductCategoryForPersistence({ categoria: "affiliate_preview", produto: "Abajur LED retrô" }), "Iluminação");
  assert.throws(
    () => resolveProductCategoryForPersistence({ categoria: "AFILIADO", produto: "Produto sem sinais" }),
    /PUBLIC_CATEGORY_REVIEW_REQUIRED/,
  );
});

function mockRepo(category: string, title = "Produto sem sinais"): PublicationRepositoryAdapter {
  return {
    async getCandidate() {
      return {
        candidateId: "candidate-category-test",
        status: "APPROVED",
        promotedProductId: null,
        sourceUrl: "https://example.com/produto/123",
        marketplace: "Teste",
        title,
        description: "",
        category,
        observedPrice: 10,
        images: ["https://example.com/product.jpg"],
        slug: "produto-category-test",
        ref: "REF-CATEGORY",
      };
    },
    async getLatestActionableAssessment() {
      return {
        assessmentId: "assessment-category-test",
        candidateId: "candidate-category-test",
        filterVersion: "1",
        classification: "APPROVED",
        isActionable: true,
        recommendation: "PROMOTE",
        recommendationBasis: "fixture",
        priorityLevel: "HIGH",
        priorityScore: 100,
        unknowns: [],
        contradictions: [],
        collectionFailures: [],
        evidenceRefs: [],
        inputSnapshot: {},
      };
    },
    async findDuplicateProduct() { return null; },
    async createCanonicalProduct() { throw new Error("not used in preflight"); },
    async linkPromotion() { return { ok: true }; },
    async restoreCreatedProduct() { return { ok: true }; },
    async recordOperationalEvent() { return { ok: true }; },
  };
}

test("publication preflight canonicaliza categoria antes da escrita", async () => {
  const resolved = await preflightPublication({ candidateId: "candidate-category-test", affiliateUrl: null }, mockRepo("affiliate_preview", "Abajur LED Cogumelo"));
  assert.equal(resolved.ok, true);
  assert.equal(resolved.candidate?.category, "Iluminação");
});

test("publication preflight bloqueia categoria sem classificação pública", async () => {
  const blocked = await preflightPublication({ candidateId: "candidate-category-test", affiliateUrl: null }, mockRepo("AFILIADO", "Produto sem sinais"));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.failureCode, "PUBLIC_CATEGORY_REVIEW_REQUIRED");
});
''', encoding='utf-8')

Path('tests/catalogNavigation.test.ts').write_text(r'''import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CATALOG_VIEW_STATE,
  createCatalogHistoryState,
  createProductHistoryState,
  mergeCerberusHistoryState,
  readCerberusHistoryEntry,
} from "../src/lib/catalogNavigation";

test("scroll e filtros pertencem à entrada determinística do catálogo", () => {
  const state = createCatalogHistoryState({ selectedCategory: "Iluminação", searchQuery: "abajur", isCategoryPanelOpen: false }, false, 1432.4);
  const entry = readCerberusHistoryEntry(state);
  assert.equal(entry?.view, "catalog");
  if (entry?.view !== "catalog") throw new Error("catalog entry missing");
  assert.equal(entry.scrollY, 1432);
  assert.equal(entry.catalog.selectedCategory, "Iluminação");
  assert.equal(entry.catalog.searchQuery, "abajur");
});

test("posição de detalhe não vaza para outra página", () => {
  const catalog = mergeCerberusHistoryState({ unrelated: "preserved" }, createCatalogHistoryState(DEFAULT_CATALOG_VIEW_STATE, false, 900));
  const detail = mergeCerberusHistoryState({}, createProductHistoryState("produto-a", 321, { canGoBack: true, fromView: "catalog" }));
  const catalogEntry = readCerberusHistoryEntry(catalog);
  const detailEntry = readCerberusHistoryEntry(detail);
  assert.equal((catalogEntry as any).scrollY, 900);
  assert.equal((detailEntry as any).scrollY, 321);
  assert.equal((detailEntry as any).productKey, "produto-a");
  assert.equal((catalog as any).unrelated, "preserved");
});

test("history state inválido volta a defaults sem reutilizar scroll de outra rota", () => {
  assert.equal(readCerberusHistoryEntry({ cerberus: { view: "product-detail", productKey: "", scrollY: 999 } }), null);
  const state = createCatalogHistoryState({ selectedCategory: "", searchQuery: "x".repeat(300), isCategoryPanelOpen: true }, true, -50);
  const entry = readCerberusHistoryEntry(state);
  assert.equal(entry?.view, "catalog");
  if (entry?.view !== "catalog") throw new Error("catalog entry missing");
  assert.equal(entry.scrollY, 0);
  assert.equal(entry.catalog.selectedCategory, "Todos");
  assert.equal(entry.catalog.searchQuery.length, 200);
});
''', encoding='utf-8')

print('CATEGORY_PATCH_APPLIED')
