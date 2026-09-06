import test from "node:test";
import assert from "node:assert/strict";
import { ProductPipeline } from "../server/services/productPipeline";
import { runAutonomousCuratorDaily } from "../server/services/autonomousCurator";

const reviewRequiredCuration = {
  status: "review_required" as const,
  rawImageUrls: ["https://img.example.com/product.jpg"],
  galleryImageUrls: [],
  assessments: [],
  reason: "image_review_unavailable" as const,
};

function pipeline() {
  return new ProductPipeline({
    getProducts: async () => [],
    createCanonicalProduct: async () => { throw new Error("not used"); },
    syncAndValidatePublication: async () => ({ success: true }),
    pauseCanonicalProduct: async () => undefined,
  });
}

const validManualCandidate = {
  normalizedUrl: "https://shopee.com.br/product/123/456",
  link: "https://s.shopee.com.br/example",
  marketplace: "Shopee",
  produto: "Luminária Cogumelo de Mesa",
  rawTitle: "Luminária Cogumelo de Mesa",
  displayTitle: "Luminária Cogumelo de Mesa",
  descricao: "Luminária compacta de mesa com linguagem retrô e desenho arredondado.",
  categoria: "Iluminação",
  preco: 89.9,
  imagens: ["https://img.example.com/product.jpg"],
  imageCuration: { ...reviewRequiredCuration, primaryImageUrl: "https://img.example.com/product.jpg" },
  imageEditorialStatus: "review_required" as const,
};

test("human review demotes image editorial failure to warning but preserves hard validation", async () => {
  const ordinary = await pipeline().evaluate(validManualCandidate);
  assert.equal(ordinary.state, "ERROR");
  assert.equal(ordinary.validation.outcome, "FAIL");
  assert.ok(ordinary.validation.errors.includes("IMAGE_REVIEW_REQUIRED"));

  const manual = await pipeline().evaluate(validManualCandidate, { humanReview: true });
  assert.equal(manual.state, "PENDING_APPROVAL");
  assert.equal(manual.validation.outcome, "WARNING");
  assert.deepEqual(manual.validation.errors, []);
  assert.ok(manual.validation.warnings.includes("IMAGE_REVIEW_REQUIRED"));

  const invalidPrice = await pipeline().evaluate({ ...validManualCandidate, preco: 0 }, { humanReview: true });
  assert.equal(invalidPrice.state, "ERROR");
  assert.equal(invalidPrice.validation.outcome, "FAIL");
  assert.ok(invalidPrice.validation.errors.some(error => error.includes("Preço válido")));
});

test("manual curator sends best available card despite image warning, category mismatch and score below review threshold", async () => {
  let searches = 0;
  const shopeeClient = {
    async searchOffers() {
      searches += 1;
      if (searches !== 1) return { ok: true, items: [], httpStatus: 200, error: null };
      return {
        ok: true,
        items: [{
          shopId: "123",
          itemId: "456",
          name: "Abajur Cogumelo Bauhaus Retro",
          price: 89.9,
          productLink: "https://shopee.com.br/product/123/456",
          offerLink: "https://s.shopee.com.br/example",
        }],
        httpStatus: 200,
        error: null,
      };
    },
    async acquireAffiliateLink() {
      return {
        status: "link_acquired",
        affiliateUrl: "https://s.shopee.com.br/example",
        productLink: "https://shopee.com.br/product/123/456",
        shopId: "123",
        itemId: "456",
        name: "Abajur Cogumelo Bauhaus Retro",
        price: 89.9,
        raw: {},
        error: null,
      };
    },
  } as any;

  const categoryRows = new Map<string, any>();
  let savedReview: any = null;
  let photoCalls = 0;
  let productCreates = 0;

  const result = await runAutonomousCuratorDaily({ notify: false }, {
    env: { TELEGRAM_ADMIN_CHAT_ID: "123", TELEGRAM_ALLOWED_USER_IDS: "123" },
    now: new Date("2026-09-06T01:30:00-03:00"),
    shopeeClient,
    getConfig: async () => ({
      enabled: true,
      autoPublishEnabled: false,
      autoPublishThreshold: 88,
      reviewThreshold: 72,
      maxDailyPerCategory: 30,
      maxSearchCandidates: 10,
      maxEnrichPerCategory: 1,
    } as any),
    openRun: (async ({ dryRun }: any) => ({
      run: { id: "run-best-of-lot", runDate: "2026-09-06", status: "running", dryRun },
      resumed: false,
    })) as any,
    getCategoryResult: (async () => null) as any,
    saveCategoryResult: (async (row: any) => { categoryRows.set(row.category, row); }) as any,
    finishRun: (async () => undefined) as any,
    findSourceIdentity: (async () => null) as any,
    productsLoader: async () => [],
    extractor: (async () => ({
      success: true,
      data: {
        normalizedUrl: "https://shopee.com.br/product/123/456",
        marketplace: "Shopee",
        rawTitle: "Abajur Cogumelo Bauhaus Retro",
        displayTitle: "Luminária Cogumelo de Mesa Estilo Minimalista",
        produto: "Abajur Cogumelo Bauhaus Retro",
        categoria: "Decoração",
        preco: 89.9,
        imagens: ["https://img.example.com/product.jpg"],
        imageCuration: reviewRequiredCuration,
        imageEditorialStatus: "review_required",
        descricao: "Peça compacta com desenho arredondado para composição de interiores contemporâneos.",
        existingProduct: null,
      },
    })) as any,
    pipelineFactory: (() => ({
      evaluate: async (input: any) => ({
        id: "life-review",
        candidate: input,
        state: "PENDING_APPROVAL",
        validation: { outcome: "WARNING", errors: [], warnings: ["IMAGE_REVIEW_REQUIRED"] },
        curation: { score: 75, category: input.categoria, confidence: "MEDIUM", reasons: [], risks: [], recommendation: "REVIEW" },
        audit: [],
      }),
    })) as any,
    createProduct: (async () => { productCreates += 1; throw new Error("must not auto publish"); }) as any,
    savePendingReview: (async (review: any) => { savedReview = review; }) as any,
    sendPhoto: (async () => { photoCalls += 1; return { ok: true, result: { message_id: 1 } }; }) as any,
    sendMessage: (async () => ({ ok: true, result: { message_id: 2 } })) as any,
  });

  assert.equal(result.autoPublished, 0);
  assert.equal(result.reviewRequired, 1);
  assert.equal(productCreates, 0);
  assert.equal(photoCalls, 1);
  assert.ok(savedReview);
  assert.equal(savedReview.status, "pending");
  assert.equal(savedReview.categoria, "Decoração");
  assert.equal(savedReview.imageEditorialStatus, "review_required");
  assert.equal(savedReview.imagemPrincipal, "https://img.example.com/product.jpg");
  assert.equal(categoryRows.get("Iluminação")?.decision, "review_required");
  assert.equal(categoryRows.get("Iluminação")?.reason, "BEST_OF_LOT_WITH_EDITORIAL_WARNINGS");
  assert.ok(Array.isArray(categoryRows.get("Iluminação")?.scoreBreakdown?.warnings));
  assert.ok(categoryRows.get("Iluminação")?.scoreBreakdown?.warnings.some((warning: string) => warning.startsWith("CATEGORY_MISMATCH")));
  assert.ok(categoryRows.get("Iluminação")?.scoreBreakdown?.warnings.some((warning: string) => warning.startsWith("IMAGE_REVIEW_NOT_CLEAN_AFTER_REPAIR")));
});
