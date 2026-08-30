from pathlib import Path


def replace_once(path: str, old: str, new: str):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"anchor not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "server/services/productImageRepair.ts",
    "    const interaction = await ai.interactions.create({\n",
    "    const interactions = (ai as any).interactions;\n    if (!interactions?.create) return null;\n    const interaction = await interactions.create({\n",
)

replace_once(
    "server/services/productAutomation.ts",
    'import { curateProductImages, type ProductImageAssessment, type ProductImageCuration } from "../../src/lib/productImageCuration";\n',
    'import { curateProductImages, type ProductImageAssessment, type ProductImageCuration } from "../../src/lib/productImageCuration";\nimport { repairProductImage } from "./productImageRepair";\n',
)
replace_once(
    "server/services/productAutomation.ts",
    "async function reviewScrapedImages(rawImages: string[], title: string): Promise<ProductImageCuration> {\n",
    "async function reviewScrapedImages(rawImages: string[], title: string, allowRepair = true): Promise<ProductImageCuration> {\n",
)
replace_once(
    "server/services/productAutomation.ts",
    "    return curateProductImages(rawImageUrls, assessments);\n",
    '''    const curation = curateProductImages(rawImageUrls, assessments);
    if (curation.status === "ready" || !allowRepair) return curation;

    const repaired = await repairProductImage({
      rawImageUrls,
      title,
      assessments,
    });
    if (!repaired) return curation;

    // Uma imagem gerada/editada nunca é auto-aprovada. Ela volta ao mesmo
    // reviewer multimodal e só entra no catálogo se for classificada clean.
    const repairedCuration = await reviewScrapedImages([repaired.url], title, false);
    if (repairedCuration.status !== "ready" || !repairedCuration.primaryImageUrl) return curation;
    return {
      status: "ready",
      rawImageUrls: [...rawImageUrls, repaired.url],
      primaryImageUrl: repairedCuration.primaryImageUrl,
      galleryImageUrls: repairedCuration.galleryImageUrls,
      assessments: [...assessments, ...repairedCuration.assessments],
    };
''',
)

p = Path("server/services/autonomousCurator.ts")
text = p.read_text()
replacements = [
    (
        '    const blocked = hasBlockedProfileTerm(input.profile, `${rawTitle} ${displayTitle} ${description}`);\n    if (blocked) return { candidate: null, decision: "reject", reason: `PROFILE_BLOCKED_TERM:${blocked}`, rawTitle, shopId, itemId, sourceUrl };\n',
        '    const blocked = hasBlockedProfileTerm(input.profile, `${rawTitle} ${displayTitle} ${description}`);\n    if (blocked) {\n      lastReason = `PROFILE_BLOCKED_TERM:${blocked}`;\n      continue;\n    }\n',
    ),
    (
        '    if (!displayTitle || displayTitle === rawTitle || description.length < 24) {\n      return { candidate: null, decision: "reject", reason: "EDITORIAL_COPY_INCOMPLETE", rawTitle, shopId, itemId, sourceUrl };\n    }\n',
        '    if (!displayTitle || displayTitle === rawTitle || description.length < 24) {\n      lastReason = "EDITORIAL_COPY_INCOMPLETE";\n      continue;\n    }\n',
    ),
    (
        '    if (category !== input.profile.category) {\n      return { candidate: null, decision: "reject", reason: `CATEGORY_MISMATCH:${category || "unknown"}`, rawTitle, shopId, itemId, sourceUrl };\n    }\n',
        '    if (category !== input.profile.category) {\n      lastReason = `CATEGORY_MISMATCH:${category || "unknown"}`;\n      continue;\n    }\n',
    ),
    (
        '    const price = Number(data.preco);\n',
        '''    const scrapedPrice = Number(data.preco);
    const acquisitionPrice = Number(acquisition.price);
    const discoveryPrice = Number(item.price);
    const price = Number.isFinite(scrapedPrice) && scrapedPrice > 0
      ? scrapedPrice
      : Number.isFinite(acquisitionPrice) && acquisitionPrice > 0
        ? acquisitionPrice
        : Number.isFinite(discoveryPrice) && discoveryPrice > 0
          ? discoveryPrice
          : Number.NaN;
''',
    ),
    (
        '    if (!Number.isFinite(price) || price <= 0) {\n      return { candidate: null, decision: "reject", reason: "SCRAPER_PRICE_UNVERIFIED", rawTitle, shopId, itemId, sourceUrl };\n    }\n',
        '    if (!Number.isFinite(price) || price <= 0) {\n      lastReason = "PRICE_UNVERIFIED_AFTER_OFFICIAL_SHOPEE_FALLBACK";\n      continue;\n    }\n',
    ),
    (
        '    if (data.imageEditorialStatus !== "clean" || !imageCuration || imageCuration.status !== "ready" || image.status !== "ready" || !image.primaryImageUrl) {\n      return { candidate: null, decision: "reject", reason: "IMAGE_REVIEW_NOT_CLEAN", rawTitle, shopId, itemId, sourceUrl };\n    }\n',
        '    if (data.imageEditorialStatus !== "clean" || !imageCuration || imageCuration.status !== "ready" || image.status !== "ready" || !image.primaryImageUrl) {\n      lastReason = "IMAGE_REVIEW_NOT_CLEAN_AFTER_REPAIR";\n      continue;\n    }\n',
    ),
    (
        '    if (lifecycle.validation.outcome === "FAIL" || lifecycle.state === "ERROR" || lifecycle.state === "REJECTED") {\n      return { candidate: null, decision: "reject", reason: `PIPELINE_REJECTED:${lifecycle.validation.errors.join("|")}`, rawTitle, shopId, itemId, sourceUrl };\n    }\n',
        '    if (lifecycle.validation.outcome === "FAIL" || lifecycle.state === "ERROR" || lifecycle.state === "REJECTED") {\n      lastReason = `PIPELINE_REJECTED:${lifecycle.validation.errors.join("|")}`;\n      continue;\n    }\n',
    ),
    (
        '    if (breakdown.maximumCatalogSimilarity >= 0.82) {\n      return { candidate: null, decision: "duplicate", reason: `CATALOG_SIMILARITY:${breakdown.maximumCatalogSimilarity}`, rawTitle, shopId, itemId, sourceUrl };\n    }\n\n    return {\n',
        '    if (breakdown.maximumCatalogSimilarity >= 0.82) {\n      lastReason = `CATALOG_SIMILARITY:${breakdown.maximumCatalogSimilarity}`;\n      continue;\n    }\n    if (breakdown.finalScore < input.config.reviewThreshold) {\n      lastReason = `BELOW_REVIEW_THRESHOLD:${breakdown.finalScore}`;\n      continue;\n    }\n\n    return {\n',
    ),
]
for old, new in replacements:
    if old not in text:
        raise SystemExit(f"autonomousCurator anchor not found: {old[:100]!r}")
    text = text.replace(old, new, 1)
p.write_text(text)

replace_once(
    "server/services/autonomousCurator.ts",
    '''  for (const profile of AUTONOMOUS_CURATOR_PROFILES) {
    const query = queryForProfile(profile, runDate);
    const previous = await getPrevious(open.run.id, profile.category);
''',
    '''  for (const profile of AUTONOMOUS_CURATOR_PROFILES) {
    const primaryQuery = queryForProfile(profile, runDate);
    let query = primaryQuery;
    const previous = await getPrevious(open.run.id, profile.category);
''',
)
replace_once(
    "server/services/autonomousCurator.ts",
    '''      const prepared = await prepareCategoryCandidate({ profile, query, runId: open.run.id, config, existingProducts, client, deps });
      if (!prepared.candidate) {
''',
    '''      const queryOrder = [primaryQuery, ...profile.queries.filter(candidateQuery => candidateQuery !== primaryQuery)];
      let prepared: Awaited<ReturnType<typeof prepareCategoryCandidate>> | null = null;
      for (const candidateQuery of queryOrder) {
        query = candidateQuery;
        prepared = await prepareCategoryCandidate({ profile, query, runId: open.run.id, config, existingProducts, client, deps });
        if (prepared.candidate) break;
        // Source-level failures affect every query; candidate-level rejections
        // continue through the remaining deterministic alternatives.
        if (prepared.decision === "failed") break;
      }
      if (!prepared) throw new Error("AUTONOMOUS_CURATOR_QUERY_CYCLE_EMPTY");
      if (!prepared.candidate) {
''',
)
replace_once(
    "server/services/autonomousCuratorProfiles.ts",
    'export const AUTONOMOUS_CURATOR_PROFILE_VERSION = "1.0";\n',
    'export const AUTONOMOUS_CURATOR_PROFILE_VERSION = "1.1";\n',
)

test_path = Path("tests/autonomousCurator.test.ts")
test_text = test_path.read_text()
test_text += r'''

test("usa preço oficial Shopee quando o scraper não consegue verificar preço", async () => {
  const repo = persistence();
  const baseExtractor = extractor();
  const result = await runAutonomousCuratorDaily({ dryRun: true, notify: false }, {
    env: {},
    now: new Date("2026-08-29T12:00:00-03:00"),
    shopeeClient: shopeeClient(),
    getConfig: async () => config({ maxEnrichPerCategory: 2 }),
    openRun: repo.openRun as any,
    getCategoryResult: repo.getCategoryResult as any,
    saveCategoryResult: repo.saveCategoryResult as any,
    finishRun: repo.finishRun as any,
    findSourceIdentity: repo.findSourceIdentity as any,
    productsLoader: async () => [],
    extractor: (async (url: string) => {
      const extracted = await baseExtractor(url);
      return { ...extracted, data: extracted.data ? { ...extracted.data, preco: null } : extracted.data };
    }) as any,
    pipelineFactory: (() => ({ evaluate: async () => lifecycle() })) as any,
  });
  assert.equal(result.categories[0].decision, "auto");
});

test("rejeição do primeiro item não encerra a categoria e o próximo item é avaliado", async () => {
  const repo = persistence();
  let searchCalls = 0;
  let extractorCalls = 0;
  const client = {
    async searchOffers() {
      searchCalls += 1;
      if (searchCalls !== 1) return { ok: true, items: [], httpStatus: 200, error: null };
      return {
        ok: true,
        items: [
          { shopId: "123", itemId: "456", name: "Abajur Bauhaus ruim", price: 119.9, productLink: "https://shopee.com.br/product/123/456", offerLink: "https://affiliate.example.com/123-456" },
          { shopId: "123", itemId: "457", name: "Abajur Cogumelo Bauhaus Retro", price: 149.9, productLink: "https://shopee.com.br/product/123/457", offerLink: "https://affiliate.example.com/123-457" },
        ],
        httpStatus: 200,
        error: null,
      };
    },
    async acquireAffiliateLink({ itemId }: any) {
      return {
        status: "link_acquired",
        affiliateUrl: `https://affiliate.example.com/123-${itemId}`,
        productLink: `https://shopee.com.br/product/123/${itemId}`,
        shopId: "123",
        itemId,
        name: itemId === "456" ? "Abajur Bauhaus ruim" : "Abajur Cogumelo Bauhaus Retro",
        price: itemId === "456" ? 119.9 : 149.9,
        raw: {},
        error: null,
      };
    },
  } as any;
  const result = await runAutonomousCuratorDaily({ dryRun: true, notify: false }, {
    env: {},
    now: new Date("2026-08-29T12:00:00-03:00"),
    shopeeClient: client,
    getConfig: async () => config({ maxEnrichPerCategory: 2 }),
    openRun: repo.openRun as any,
    getCategoryResult: repo.getCategoryResult as any,
    saveCategoryResult: repo.saveCategoryResult as any,
    finishRun: repo.finishRun as any,
    findSourceIdentity: repo.findSourceIdentity as any,
    productsLoader: async () => [],
    extractor: (async (url: string) => {
      extractorCalls += 1;
      if (url.endsWith("/456")) return { success: false, error: "IMAGE_REVIEW_REQUIRED:no_images" } as any;
      return {
        success: true,
        data: {
          normalizedUrl: "https://shopee.com.br/product/123/457",
          marketplace: "Shopee",
          rawTitle: "Abajur Cogumelo Bauhaus Retro USB Oferta",
          displayTitle: "Abajur Cogumelo Bauhaus de Mesa",
          produto: "Abajur Cogumelo Bauhaus Retro USB Oferta",
          categoria: "Iluminação",
          preco: null,
          imagens: ["https://img.example.com/clean.jpg"],
          imagensOriginais: ["https://img.example.com/raw.jpg"],
          imagemPrincipal: "https://img.example.com/clean.jpg",
          imagensGaleria: [],
          imageCuration: cleanCuration,
          imageEditorialStatus: "clean",
          descricao: "Abajur compacto de linguagem retrô, com cúpula arredondada e presença gráfica.",
          existingProduct: null,
        },
      } as any;
    }) as any,
    pipelineFactory: (() => ({ evaluate: async () => lifecycle() })) as any,
  });
  assert.equal(extractorCalls, 2);
  assert.equal(result.categories[0].decision, "auto");
  assert.equal(result.categories[0].title, "Abajur Cogumelo Bauhaus de Mesa");
});

test("quando a primeira query não encontra itens tenta as queries alternativas da categoria", async () => {
  const repo = persistence();
  let searchCalls = 0;
  const client = shopeeClient() as any;
  const originalSearch = client.searchOffers.bind(client);
  client.searchOffers = async (input: any) => {
    searchCalls += 1;
    if (searchCalls === 1) return { ok: true, items: [], httpStatus: 200, error: null };
    return originalSearch(input);
  };
  const result = await runAutonomousCuratorDaily({ dryRun: true, notify: false }, {
    env: {},
    now: new Date("2026-08-29T12:00:00-03:00"),
    shopeeClient: client,
    getConfig: async () => config({ maxEnrichPerCategory: 2 }),
    openRun: repo.openRun as any,
    getCategoryResult: repo.getCategoryResult as any,
    saveCategoryResult: repo.saveCategoryResult as any,
    finishRun: repo.finishRun as any,
    findSourceIdentity: repo.findSourceIdentity as any,
    productsLoader: async () => [],
    extractor: extractor() as any,
    pipelineFactory: (() => ({ evaluate: async () => lifecycle() })) as any,
  });
  assert.ok(searchCalls >= 2);
  assert.equal(result.categories[0].decision, "auto");
});
'''
test_path.write_text(test_text)

Path("tests/productImageRepair.test.ts").write_text(r'''import test from "node:test";
import assert from "node:assert/strict";
import { productImageRepairInternals } from "../server/services/productImageRepair";

test("repair escolhe primeiro uma imagem com defeito editorial corrigível", () => {
  const raw = ["https://img.example.com/unknown.jpg", "https://img.example.com/promo.jpg"];
  const chosen = productImageRepairInternals.chooseRepairSource(raw, [
    { url: raw[0], decision: "unknown", confidence: "LOW", reason: "incerto" },
    { url: raw[1], decision: "promotional", confidence: "HIGH", reason: "overlay" },
  ] as any);
  assert.equal(chosen, raw[1]);
});

test("repair rejeita fonte privada/local", () => {
  assert.equal(productImageRepairInternals.chooseRepairSource(["http://localhost/a.png"], []), null);
});
''')
