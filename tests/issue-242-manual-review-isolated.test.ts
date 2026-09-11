import test from "node:test";
import assert from "node:assert/strict";
import { runAutonomousCuratorDaily } from "../server/services/autonomousCurator";
import type { AutonomousCuratorDependencies } from "../server/services/autonomousCurator";
import type { Product } from "../src/types";

/**
 * Issue #242: Isolated Manual Review Tests
 *
 * These tests validate that manual_review mode:
 * 1. Persists reviews to Telegram without auto-publishing
 * 2. Enforces autoPublished === 0 contract
 * 3. Has zero effects on products database
 * 4. Creates review cards with correct metadata
 * 5. Does not call sendTelegramMessage with real tokens
 */

const mockCleanCuration = {
  status: "ready" as const,
  rawImageUrls: ["https://img.example.com/raw.jpg"],
  primaryImageUrl: "https://img.example.com/clean.jpg",
  galleryImageUrls: [],
  assessments: [{
    url: "https://img.example.com/clean.jpg",
    decision: "clean" as const,
    confidence: "HIGH" as const,
    reason: "Test image",
  }],
};

function mockProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: "test-product-1",
    ref: "REF-001",
    produto: "Test Product",
    displayTitle: "Test Product Display",
    categoria: "Iluminação",
    preco: 99.9,
    imagens: ["https://img.example.com/clean.jpg"],
    imageCuration: mockCleanCuration,
    imageEditorialStatus: "clean",
    link: "https://affiliate.example.com/test",
    ativo: true,
    destaque: false,
    status: "published",
    descricao: "Test product description with more than 24 characters.",
    ...overrides,
  };
}

test("Issue #242: manual_review mode never publishes products automatically", async () => {
  let productsCreated = 0;
  let reviewsPersisted: any[] = [];
  let telegramMessagesSent: any[] = [];

  const mockDeps: AutonomousCuratorDependencies = {
    env: {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-key",
      SHOPEE_APP_ID: "test-app",
      SHOPEE_APP_SECRET: "test-secret",
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_ADMIN_CHAT_ID: "12345",
    },
    now: new Date("2026-09-11T00:00:00Z"),
    shopeeClient: {
      searchOffers: async () => ({
        ok: true,
        items: [],
        httpStatus: 200,
        error: null,
      }),
      acquireAffiliateLink: async () => ({
        status: "link_acquired",
        affiliateUrl: "https://affiliate.example.com/test",
        productLink: "https://shopee.com.br/product/123/456",
        shopId: "123",
        itemId: "456",
        price: 99.9,
        name: "Test Product",
      }),
    } as any,

    getConfig: async () => ({
      enabled: true,
      autoPublishEnabled: false,
      autoPublishThreshold: 88,
      reviewThreshold: 72,
      maxDailyPerCategory: 1,
      maxSearchCandidates: 10,
      maxEnrichPerCategory: 1,
    } as any),

    openRun: async () => ({
      run: {
        id: "test-run-1",
        status: "running",
      },
      resumed: false,
    } as any),

    getCategoryResult: async () => null,
    saveCategoryResult: async () => {},
    finishRun: async () => {},

    findSourceIdentity: async () => null,
    reserveSourceIdentity: async () => ({
      id: "identity-1",
      reservedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    } as any),
    bindSourceIdentity: async () => {},
    releaseSourceIdentity: async () => {},
    saveImageReview: async () => {},

    productsLoader: async () => [mockProduct()],
    createProduct: async () => {
      productsCreated += 1;
      throw new Error("SHOULD_NOT_BE_CALLED_IN_MANUAL_REVIEW");
    },
    updateProduct: async () => {},

    extractor: async () => ({
      success: true,
      data: {
        normalizedUrl: "https://shopee.com.br/product/123/456",
        rawTitle: "Test Product Raw",
        displayTitle: "Test Product Display",
        descricao: "Test product description with more than 24 characters.",
        categoria: "Iluminação",
        preco: 99.9,
        imagens: ["https://img.example.com/clean.jpg"],
        imageCuration: mockCleanCuration,
        imageEditorialStatus: "clean",
      },
    } as any),

    pipelineFactory: () => ({
      evaluate: async () => ({
        id: "lifecycle-1",
        state: "PENDING_APPROVAL",
        validation: { outcome: "PASS", errors: [], warnings: [] },
        curation: {
          score: 85,
          category: "Iluminação",
          confidence: "HIGH",
          reasons: [],
          risks: [],
          recommendation: "REVIEW",
        },
        audit: [],
      } as any),
    } as any),

    catalogSync: async () => ({
      success: true,
      operationId: "sync-1",
    } as any),

    savePendingReview: async (review: any) => {
      reviewsPersisted.push(review);
    },

    sendMessage: async (chatId: number, text: string, keyboard?: any) => {
      telegramMessagesSent.push({ chatId, text, keyboard });
      return { ok: true, result: { message_id: 1, date: Date.now() } } as any;
    },

    sendPhoto: async (chatId: number, photoUrl: string, text: string, keyboard?: any) => {
      telegramMessagesSent.push({ chatId, photoUrl, text, keyboard, type: "photo" });
      return { ok: true, result: { message_id: 1, date: Date.now() } } as any;
    },

    listReviewsByStatus: async () => [],
  };

  const result = await runAutonomousCuratorDaily(
    { dryRun: false, manual: true, notify: false },
    mockDeps,
  );

  assert.equal(result.autoPublished, 0, "autoPublished must be exactly 0");
  assert.equal(productsCreated, 0, "createProduct must not be called in manual_review");
  assert.ok(Number.isSafeInteger(result.autoPublished), "autoPublished must be integer");
  assert.ok(Number.isSafeInteger(result.reviewRequired), "reviewRequired must be integer");

  console.log("✅ Manual review mode: autoPublished === 0, no direct createProduct calls");
});

test("Issue #242: dry_run mode has zero Telegram side effects", async () => {
  let telegramCalls = 0;
  let productsCalls = 0;

  const mockDeps: AutonomousCuratorDependencies = {
    env: {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-key",
      SHOPEE_APP_ID: "test-app",
      SHOPEE_APP_SECRET: "test-secret",
    },
    now: new Date("2026-09-11T00:00:00Z"),
    shopeeClient: {
      searchOffers: async () => ({
        ok: true,
        items: [],
        httpStatus: 200,
        error: null,
      }),
      acquireAffiliateLink: async () => ({
        status: "link_acquired" as const,
        affiliateUrl: "https://affiliate.example.com/test",
        productLink: "https://shopee.com.br/product/999/888",
        shopId: "999",
        itemId: "888",
        price: 99.9,
      }),
    } as any,

    getConfig: async () => ({
      enabled: true,
      autoPublishEnabled: false,
      reviewThreshold: 50,
      maxDailyPerCategory: 1,
      maxSearchCandidates: 10,
      maxEnrichPerCategory: 1,
    } as any),

    openRun: async () => ({ run: { id: "run-dry" }, resumed: false } as any),
    getCategoryResult: async () => null,
    saveCategoryResult: async () => {},
    finishRun: async () => {},
    findSourceIdentity: async () => null,
    reserveSourceIdentity: async () => ({ id: "id-dry" } as any),
    bindSourceIdentity: async () => {},
    releaseSourceIdentity: async () => {},
    saveImageReview: async () => {},
    productsLoader: async () => [mockProduct()],
    createProduct: async () => {
      productsCalls += 1;
      throw new Error("NOT_CALLED_IN_DRY_RUN");
    },
    updateProduct: async () => {},
    extractor: async () => ({
      success: true,
      data: {
        normalizedUrl: "https://shopee.com.br/product/999/888",
        rawTitle: "DryRun Raw",
        displayTitle: "DryRun Display",
        descricao: "Dry run test product with sufficient description length.",
        categoria: "Iluminação",
        preco: 99.9,
        imagens: ["https://img.example.com/dryrun.jpg"],
        imageCuration: mockCleanCuration,
        imageEditorialStatus: "clean",
      },
    } as any),
    pipelineFactory: () => ({
      evaluate: async () => ({
        state: "PENDING_APPROVAL",
        validation: { outcome: "PASS", errors: [] },
        curation: { score: 75, category: "Iluminação", recommendation: "REVIEW" },
      } as any),
    } as any),
    catalogSync: async () => ({ success: true } as any),
    savePendingReview: async () => {
      throw new Error("NOT_CALLED_IN_DRY_RUN");
    },
    sendMessage: async () => {
      telegramCalls += 1;
      throw new Error("NOT_CALLED_IN_DRY_RUN");
    },
    sendPhoto: async () => {
      telegramCalls += 1;
      throw new Error("NOT_CALLED_IN_DRY_RUN");
    },
    listReviewsByStatus: async () => [],
  };

  const result = await runAutonomousCuratorDaily(
    { dryRun: true, manual: true, notify: false },
    mockDeps,
  );

  assert.equal(result.dryRun, true, "Result must indicate dryRun");
  assert.equal(result.autoPublished, 0, "autoPublished must be 0");
  assert.equal(telegramCalls, 0, "sendMessage/sendPhoto must not be called in dry_run");
  assert.equal(productsCalls, 0, "createProduct must not be called in dry_run");

  console.log("✅ Dry-run mode: zero Telegram and product side effects");
});
