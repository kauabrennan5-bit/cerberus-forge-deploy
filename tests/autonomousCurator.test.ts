import test from "node:test";
import assert from "node:assert/strict";
import { AUTONOMOUS_CURATOR_PROFILES, queryForProfile } from "../server/services/autonomousCuratorProfiles";
import { cheapProfileScore, scoreAutonomousCandidate, tokenJaccard } from "../server/services/autonomousCuratorScoring";
import { runAutonomousCuratorDaily } from "../server/services/autonomousCurator";
import type { Product } from "../src/types";

const cleanCuration = {
  status: "ready" as const,
  rawImageUrls: ["https://img.example.com/raw.jpg"],
  primaryImageUrl: "https://img.example.com/clean.jpg",
  galleryImageUrls: [],
  assessments: [{ url: "https://img.example.com/clean.jpg", decision: "clean" as const, confidence: "HIGH" as const, reason: "Produto isolado, sem overlay." }],
};

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "p-1",
    ref: "REF-001",
    produto: "Abajur Cogumelo Bauhaus de Mesa",
    displayTitle: "Abajur Cogumelo Bauhaus de Mesa",
    categoria: "Iluminação",
    preco: 149.9,
    imagens: ["https://img.example.com/clean.jpg"],
    imageCuration: cleanCuration,
    imageEditorialStatus: "clean",
    link: "https://affiliate.example.com/a",
    ativo: true,
    destaque: false,
    status: "published",
    descricao: "Abajur compacto de linguagem retrô, com cúpula arredondada e presença gráfica.",
    ...overrides,
  };
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    autoPublishEnabled: true,
    autoPublishThreshold: 88,
    reviewThreshold: 72,
    maxDailyPerCategory: 1,
    maxSearchCandidates: 10,
    maxEnrichPerCategory: 1,
    ...overrides,
  } as any;
}

function lifecycle(outcome: "PASS" | "WARNING" = "PASS", recommendation: "PUBLISH" | "REVIEW" = "PUBLISH") {
  return {
    id: "life-1",
    candidate: {},
    state: "PENDING_APPROVAL",
    validation: { outcome, errors: [], warnings: outcome === "WARNING" ? ["similar"] : [] },
    curation: { score: 100, category: "Iluminação", confidence: "HIGH", reasons: [], risks: [], recommendation },
    audit: [],
  } as any;
}

function shopeeClient() {
  let searches = 0;
  return {
    async searchOffers() {
      searches += 1;
      if (searches !== 1) return { ok: true, items: [], httpStatus: 200, error: null };
      return {
        ok: true,
        items: [{
          shopId: "123",
          itemId: "456",
          name: "Abajur Cogumelo Bauhaus Retro",
          price: 149.9,
          productLink: "https://shopee.com.br/product/123/456",
          offerLink: "https://affiliate.example.com/123-456",
        }],
        httpStatus: 200,
        error: null,
      };
    },
    async acquireAffiliateLink() {
      return {
        status: "link_acquired",
        affiliateUrl: "https://affiliate.example.com/123-456",
        productLink: "https://shopee.com.br/product/123/456",
        shopId: "123",
        itemId: "456",
        name: "Abajur Cogumelo Bauhaus Retro",
        price: 149.9,
        raw: {},
        error: null,
      };
    },
  } as any;
}

function extractor() {
  return async () => ({
    success: true,
    data: {
      normalizedUrl: "https://shopee.com.br/product/123/456",
      marketplace: "Shopee",
      rawTitle: "Abajur Cogumelo Bauhaus Retro USB Oferta",
      displayTitle: "Abajur Cogumelo Bauhaus de Mesa",
      produto: "Abajur Cogumelo Bauhaus Retro USB Oferta",
      categoria: "Iluminação",
      preco: 149.9,
      imagens: ["https://img.example.com/clean.jpg"],
      imagensOriginais: ["https://img.example.com/raw.jpg"],
      imagemPrincipal: "https://img.example.com/clean.jpg",
      imagensGaleria: [],
      imageCuration: cleanCuration,
      imageEditorialStatus: "clean",
      descricao: "Abajur compacto de linguagem retrô, com cúpula arredondada e presença gráfica.",
      existingProduct: null,
    },
  } as any);
}

function persistence(overrides: Record<string, unknown> = {}) {
  const categoryRows = new Map<string, any>();
  return {
    categoryRows,
    openRun: async ({ dryRun }: any) => ({ run: { id: dryRun ? "dry-1" : "run-1", runDate: "2026-08-29", status: "running", dryRun }, resumed: false }),
    getCategoryResult: async (_runId: string, category: string) => categoryRows.get(category) || null,
    saveCategoryResult: async (row: any) => { categoryRows.set(row.category, row); },
    finishRun: async () => undefined,
    findSourceIdentity: async () => null,
    reserveSourceIdentity: async (input: any) => ({ reserved: true, identity: { ...input, productId: null } }),
    bindSourceIdentity: async () => undefined,
    releaseSourceIdentity: async () => undefined,
    saveImageReview: async () => undefined,
    ...overrides,
  };
}

test("perfis cobrem todas as categorias públicas e query diária é determinística", () => {
  assert.equal(AUTONOMOUS_CURATOR_PROFILES.length, 10);
  const categories = new Set(AUTONOMOUS_CURATOR_PROFILES.map(profile => profile.category));
  assert.equal(categories.size, 10);
  for (const profile of AUTONOMOUS_CURATOR_PROFILES) {
    assert.equal(queryForProfile(profile, "2026-08-29"), queryForProfile(profile, "2026-08-29"));
  }
});

test("scoring privilegia novidade e bloqueia spam de perfil", () => {
  const profile = AUTONOMOUS_CURATOR_PROFILES[0];
  assert.ok(cheapProfileScore(profile, "Abajur Cogumelo Bauhaus Retro") > 0);
  assert.equal(tokenJaccard("abajur cogumelo bauhaus", "abajur cogumelo bauhaus"), 1);
  const breakdown = scoreAutonomousCandidate({
    profile,
    rawTitle: "Abajur Cogumelo Bauhaus Retro",
    displayTitle: "Abajur Cogumelo Bauhaus de Mesa",
    description: "Peça retrô compacta com cúpula arredondada e presença gráfica para iluminação pontual.",
    category: "Iluminação",
    price: 149.9,
    imageCuration: cleanCuration,
    pipelineScore: 100,
    existingProducts: [],
  });
  assert.ok(breakdown.finalScore >= 88);
  assert.equal(breakdown.novelty, 100);
});

test("dry-run percorre as categorias sem criar produto, review ou catálogo", async () => {
  const repo = persistence();
  let createCalls = 0;
  let reviewCalls = 0;
  let syncCalls = 0;
  const result = await runAutonomousCuratorDaily({ dryRun: true, notify: false }, {
    env: {},
    now: new Date("2026-08-29T12:00:00-03:00"),
    shopeeClient: shopeeClient(),
    getConfig: async () => config(),
    openRun: repo.openRun as any,
    getCategoryResult: repo.getCategoryResult as any,
    saveCategoryResult: repo.saveCategoryResult as any,
    finishRun: repo.finishRun as any,
    findSourceIdentity: repo.findSourceIdentity as any,
    productsLoader: async () => [],
    extractor: extractor() as any,
    pipelineFactory: (() => ({ evaluate: async () => lifecycle() })) as any,
    createProduct: (async () => { createCalls += 1; return product(); }) as any,
    savePendingReview: (async () => { reviewCalls += 1; }) as any,
    catalogSync: (async () => { syncCalls += 1; return { success: true }; }) as any,
  });
  assert.equal(result.status, "dry_run");
  assert.equal(result.categories.length, 10);
  assert.equal(result.categories[0].decision, "auto");
  assert.equal(createCalls, 0);
  assert.equal(reviewCalls, 0);
  assert.equal(syncCalls, 0);
});

test("candidato de alta confiança auto-publica uma vez e sincroniza o catálogo uma vez", async () => {
  const repo = persistence();
  let createCalls = 0;
  let updateCalls = 0;
  let syncCalls = 0;
  let imageAuditCalls = 0;
  const result = await runAutonomousCuratorDaily({ notify: false }, {
    env: {},
    now: new Date("2026-08-29T12:00:00-03:00"),
    shopeeClient: shopeeClient(),
    getConfig: async () => config(),
    openRun: repo.openRun as any,
    getCategoryResult: repo.getCategoryResult as any,
    saveCategoryResult: repo.saveCategoryResult as any,
    finishRun: repo.finishRun as any,
    findSourceIdentity: repo.findSourceIdentity as any,
    reserveSourceIdentity: repo.reserveSourceIdentity as any,
    bindSourceIdentity: repo.bindSourceIdentity as any,
    releaseSourceIdentity: repo.releaseSourceIdentity as any,
    saveImageReview: (async () => { imageAuditCalls += 1; }) as any,
    productsLoader: async () => [],
    extractor: extractor() as any,
    pipelineFactory: (() => ({ evaluate: async () => lifecycle() })) as any,
    createProduct: (async (input: any) => { createCalls += 1; return product({ id: "auto-1", produto: input.produto, displayTitle: input.displayTitle, link: input.link, status: "approved" }); }) as any,
    updateProduct: (async (id: string) => { updateCalls += 1; return product({ id, status: "published" }); }) as any,
    catalogSync: (async () => { syncCalls += 1; return { success: true, operationId: "SYNC-1", supabaseCount: 1, jsonCount: 1, staticSiteUrl: "https://example.com" }; }) as any,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.autoPublished, 1);
  assert.equal(createCalls, 1);
  assert.equal(updateCalls, 1);
  assert.equal(syncCalls, 1);
  assert.equal(imageAuditCalls, 1);
  assert.equal(repo.categoryRows.get("Iluminação")?.decision, "auto_published");
});

test("warning do pipeline impede auto-publicação e cai em revisão humana", async () => {
  const repo = persistence();
  let createCalls = 0;
  let reviewCalls = 0;
  const result = await runAutonomousCuratorDaily({ notify: false }, {
    env: { TELEGRAM_ADMIN_CHAT_ID: "123", TELEGRAM_ALLOWED_USER_IDS: "123" },
    now: new Date("2026-08-29T12:00:00-03:00"),
    shopeeClient: shopeeClient(),
    getConfig: async () => config(),
    openRun: repo.openRun as any,
    getCategoryResult: repo.getCategoryResult as any,
    saveCategoryResult: repo.saveCategoryResult as any,
    finishRun: repo.finishRun as any,
    findSourceIdentity: repo.findSourceIdentity as any,
    productsLoader: async () => [],
    extractor: extractor() as any,
    pipelineFactory: (() => ({ evaluate: async () => lifecycle("WARNING", "REVIEW") })) as any,
    createProduct: (async () => { createCalls += 1; return product(); }) as any,
    savePendingReview: (async () => { reviewCalls += 1; }) as any,
    sendPhoto: (async () => ({ ok: true, result: { message_id: 1 } })) as any,
    sendMessage: (async () => ({ ok: true, result: { message_id: 1 } })) as any,
  });
  assert.equal(result.reviewRequired, 1);
  assert.equal(createCalls, 0);
  assert.equal(reviewCalls, 1);
  assert.equal(repo.categoryRows.get("Iluminação")?.decision, "review_required");
});

test("identidade Shopee já publicada é descartada antes de Gemini/scraper", async () => {
  const repo = persistence({ findSourceIdentity: async () => ({ marketplace: "Shopee", shopId: "123", itemId: "456", sourceProductUrl: "https://shopee.com.br/product/123/456", productId: "existing", reservedRunId: null, reservedUntil: null }) });
  let extractorCalls = 0;
  const result = await runAutonomousCuratorDaily({ dryRun: true, notify: false }, {
    env: {},
    now: new Date("2026-08-29T12:00:00-03:00"),
    shopeeClient: shopeeClient(),
    getConfig: async () => config(),
    openRun: repo.openRun as any,
    getCategoryResult: repo.getCategoryResult as any,
    saveCategoryResult: repo.saveCategoryResult as any,
    finishRun: repo.finishRun as any,
    findSourceIdentity: repo.findSourceIdentity as any,
    productsLoader: async () => [],
    extractor: (async () => { extractorCalls += 1; return { success: false }; }) as any,
  });
  assert.equal(extractorCalls, 0);
  assert.equal(result.categories[0].decision, "duplicate");
});


test("identidade Shopee reservada por review ativa é descartada antes de Gemini/scraper", async () => {
  const repo = persistence({
    findSourceIdentity: async () => ({
      marketplace: "Shopee",
      shopId: "123",
      itemId: "456",
      sourceProductUrl: "https://shopee.com.br/product/123/456",
      productId: null,
      reviewId: "autocur-review-1",
      reservedRunId: "run-existing",
      reservedUntil: new Date(Date.now() + 60_000).toISOString(),
    }),
  });
  let extractorCalls = 0;
  const result = await runAutonomousCuratorDaily({ dryRun: true, notify: false }, {
    env: {},
    now: new Date("2026-08-29T12:00:00-03:00"),
    shopeeClient: shopeeClient(),
    getConfig: async () => config(),
    openRun: repo.openRun as any,
    getCategoryResult: repo.getCategoryResult as any,
    saveCategoryResult: repo.saveCategoryResult as any,
    finishRun: repo.finishRun as any,
    findSourceIdentity: repo.findSourceIdentity as any,
    productsLoader: async () => [],
    extractor: (async () => { extractorCalls += 1; return { success: false }; }) as any,
  });
  assert.equal(extractorCalls, 0);
  assert.equal(result.categories[0].decision, "duplicate");
});


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
      const extracted = await baseExtractor();
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
          { shopId: "123", itemId: "456", name: "Abajur Cogumelo Bauhaus Retro Ruim", price: 119.9, productLink: "https://shopee.com.br/product/123/456", offerLink: "https://affiliate.example.com/123-456" },
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
        name: itemId === "456" ? "Abajur Cogumelo Bauhaus Retro Ruim" : "Abajur Cogumelo Bauhaus Retro",
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
