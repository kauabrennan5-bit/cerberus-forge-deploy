import test from "node:test";
import assert from "node:assert/strict";
import { runAutonomousCuratorDaily } from "../server/services/autonomousCurator";

type CuratorDeps = NonNullable<Parameters<typeof runAutonomousCuratorDaily>[1]>;

const cleanCuration = {
  status: "ready" as const,
  rawImageUrls: ["https://img.example.com/raw.jpg"],
  primaryImageUrl: "https://img.example.com/clean.jpg",
  galleryImageUrls: [],
  assessments: [{
    url: "https://img.example.com/clean.jpg",
    decision: "clean" as const,
    confidence: "HIGH" as const,
    reason: "Produto isolado, sem overlay.",
  }],
};

function shopeeClient() {
  let searches = 0;
  return {
    async searchOffers() {
      searches += 1;
      if (searches !== 1) {
        return { ok: true, items: [], httpStatus: 200, error: null };
      }
      return {
        ok: true,
        items: [{
          shopId: "123",
          itemId: "456",
          name: "Abajur Cogumelo Bauhaus Retro",
          price: 149.9,
          productLink: "https://shopee.com.br/product/123/456",
          offerLink: "https://affiliate.example.com/123-456",
          imageUrl: "https://img.example.com/clean.jpg",
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
        imageUrl: "https://img.example.com/clean.jpg",
        raw: {},
        error: null,
      };
    },
  };
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
  });
}

function lifecycle() {
  return {
    id: "life-1",
    candidate: {},
    state: "PENDING_APPROVAL",
    validation: { outcome: "PASS", errors: [], warnings: [] },
    curation: {
      score: 100,
      category: "Iluminação",
      confidence: "HIGH",
      reasons: [],
      risks: [],
      recommendation: "PUBLISH",
    },
    audit: [],
  };
}

function baseDeps(overrides: Record<string, unknown> = {}): CuratorDeps {
  const categoryRows = new Map<string, unknown>();
  return {
    env: {
      TELEGRAM_ADMIN_CHAT_ID: "12345",
      TELEGRAM_ALLOWED_USER_IDS: "12345",
    },
    now: new Date("2026-09-11T12:00:00-03:00"),
    shopeeClient: shopeeClient(),
    getConfig: async () => ({
      enabled: true,
      autoPublishEnabled: true,
      autoPublishThreshold: 88,
      reviewThreshold: 72,
      maxDailyPerCategory: 1,
      maxSearchCandidates: 10,
      maxEnrichPerCategory: 1,
    }),
    openRun: async ({ dryRun }: { dryRun: boolean }) => ({
      run: {
        id: dryRun ? "dry-issue-242" : "run-issue-242",
        runDate: "2026-09-11",
        status: "running",
        dryRun,
      },
      resumed: false,
    }),
    getCategoryResult: async (_runId: string, category: string) => categoryRows.get(category) ?? null,
    saveCategoryResult: async (row: { category: string }) => {
      categoryRows.set(row.category, row);
    },
    finishRun: async () => undefined,
    findSourceIdentity: async () => null,
    reserveSourceIdentity: async (input: Record<string, unknown>) => ({
      reserved: true,
      identity: { ...input, productId: null },
    }),
    bindSourceIdentity: async () => undefined,
    releaseSourceIdentity: async () => undefined,
    saveImageReview: async () => undefined,
    listReviewsByStatus: async () => [],
    productsLoader: async () => [],
    extractor: extractor(),
    pipelineFactory: () => ({ evaluate: async () => lifecycle() }),
    ...overrides,
  } as unknown as CuratorDeps;
}

test("Issue #242: manual_review creates a pending Telegram review and never publishes", async () => {
  let createCalls = 0;
  let updateCalls = 0;
  let syncCalls = 0;
  const reviews: any[] = [];
  const telegramDeliveries: any[] = [];

  const deps = baseDeps({
    createProduct: async () => {
      createCalls += 1;
      throw new Error("CREATE_PRODUCT_MUST_NOT_RUN");
    },
    updateProduct: async () => {
      updateCalls += 1;
      throw new Error("UPDATE_PRODUCT_MUST_NOT_RUN");
    },
    catalogSync: async () => {
      syncCalls += 1;
      throw new Error("CATALOG_SYNC_MUST_NOT_RUN");
    },
    savePendingReview: async (review: any) => {
      reviews.push(review);
    },
    sendPhoto: async (chatId: number, photoUrl: string, text: string, keyboard: any) => {
      telegramDeliveries.push({ kind: "photo", chatId, photoUrl, text, keyboard });
      return { ok: true, result: { message_id: 1 } };
    },
    sendMessage: async (chatId: number, text: string, keyboard: any) => {
      telegramDeliveries.push({ kind: "message", chatId, text, keyboard });
      return { ok: true, result: { message_id: 2 } };
    },
  });

  const result = await runAutonomousCuratorDaily(
    { dryRun: false, manual: true, notify: false },
    deps,
  );

  assert.equal(result.status, "completed");
  assert.equal(result.autoPublished, 0);
  assert.equal(result.reviewRequired, 1);
  assert.equal(createCalls, 0);
  assert.equal(updateCalls, 0);
  assert.equal(syncCalls, 0);

  assert.equal(reviews.length, 1, "a valid candidate must become exactly one pending review");
  const review = reviews[0];
  assert.match(review.id, /^autocur-/);
  assert.equal(review.status, "pending");
  assert.equal(review.chatId, 12345);
  assert.equal(review.produto, "Abajur Cogumelo Bauhaus de Mesa");
  assert.equal(review.normalizedUrl, "https://shopee.com.br/product/123/456");
  assert.equal(review.existingProduct?.source, "autonomous_curator");
  assert.equal(review.existingProduct?.affiliateUrl, "https://affiliate.example.com/123-456");

  assert.equal(telegramDeliveries.length, 1, "the review card must be delivered once");
  const delivery = telegramDeliveries[0];
  assert.equal(delivery.kind, "photo");
  assert.match(delivery.text, /REVISÃO HUMANA/);
  assert.match(delivery.text, /publicação é exclusivamente manual/i);
  assert.equal(delivery.keyboard.inline_keyboard[0][0].callback_data, `confirm_pub:${review.id}`);
  assert.equal(delivery.keyboard.inline_keyboard[1][0].callback_data, `cancel_rev:${review.id}`);
});

test("Issue #242: dry_run evaluates a real mocked candidate with zero review/product side effects", async () => {
  let createCalls = 0;
  let reviewWrites = 0;
  let telegramCalls = 0;
  let syncCalls = 0;

  const deps = baseDeps({
    createProduct: async () => {
      createCalls += 1;
      throw new Error("CREATE_PRODUCT_MUST_NOT_RUN_IN_DRY_RUN");
    },
    savePendingReview: async () => {
      reviewWrites += 1;
      throw new Error("REVIEW_WRITE_MUST_NOT_RUN_IN_DRY_RUN");
    },
    sendPhoto: async () => {
      telegramCalls += 1;
      throw new Error("TELEGRAM_MUST_NOT_RUN_IN_DRY_RUN");
    },
    sendMessage: async () => {
      telegramCalls += 1;
      throw new Error("TELEGRAM_MUST_NOT_RUN_IN_DRY_RUN");
    },
    catalogSync: async () => {
      syncCalls += 1;
      throw new Error("CATALOG_SYNC_MUST_NOT_RUN_IN_DRY_RUN");
    },
  });

  const result = await runAutonomousCuratorDaily(
    { dryRun: true, manual: true, notify: false },
    deps,
  );

  assert.equal(result.status, "dry_run");
  assert.equal(result.autoPublished, 0);
  assert.equal(result.reviewRequired, 1, "the candidate must reach the review decision path in dry-run");
  assert.equal(result.categories[0]?.decision, "review");
  assert.equal(createCalls, 0);
  assert.equal(reviewWrites, 0);
  assert.equal(telegramCalls, 0);
  assert.equal(syncCalls, 0);
});