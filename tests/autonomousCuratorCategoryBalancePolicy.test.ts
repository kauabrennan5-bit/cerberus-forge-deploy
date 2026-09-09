import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { Product } from "../src/types";
import { calculateCategoryCoveragePolicy } from "../server/services/autonomousCuratorCategoryPolicy";

const coordinator = fs.readFileSync("server/services/autonomousCuratorContinuousV2.ts", "utf8");
const base = fs.readFileSync("server/services/autonomousCuratorContinuousV2Base.ts", "utf8");

test("coordinator uses the five-item coverage floor unless configuration explicitly raises it", () => {
  assert.match(coordinator, /function dailyTargetPerCategory/);
  assert.match(coordinator, /MIN_PUBLIC_PRODUCTS_PER_CATEGORY = 5/);
  assert.match(coordinator, /function configuredDailyFloor/);
  assert.match(coordinator, /AUTONOMOUS_CURATOR_DAILY_TARGET_PER_CATEGORY/);
  assert.match(coordinator, /return configuredDailyFloor\(env\)/);
  assert.doesNotMatch(coordinator, /Math\.max\(configuredFloor, today - start \+ 1\)/);
  assert.match(coordinator, /AUTONOMOUS_CURATOR_GROWTH_START_DATE/);
  assert.match(coordinator, /daily_target_per_category/);
  assert.match(coordinator, /growth_day/);
  assert.doesNotMatch(coordinator, /const LIVE_TARGET_PER_CATEGORY = 2/);
  assert.doesNotMatch(coordinator, /function retirementCandidates/);
  assert.doesNotMatch(coordinator, /published \? "published" : "archived"/);
  assert.match(coordinator, /function archiveProduct/);
  assert.doesNotMatch(coordinator, /category_balance_retired_ids/);
});

test("deficient categories create only pending cards and never autonomous publications", () => {
  assert.match(coordinator, /recoveryMode = beforePolicy\.totalCardsNeeded > 0/);
  assert.match(coordinator, /burstCoverage\.totalCardsNeeded/);
  assert.match(coordinator, /burstCoverage\.prioritizedCategories/);
  assert.match(coordinator, /activeBefore \+ burstCoverage\.totalCardsNeeded/);
  assert.match(coordinator, /const burstLimit = 1/);
  assert.match(coordinator, /REVIEW_ONLY_NO_PUBLIC_CATALOG_MUTATION/);
  assert.match(coordinator, /result\.publishedThisCycle = publishedAcrossBurst/);
  assert.match(base, /const publishedThisCycle = 0/);
  assert.doesNotMatch(base, /publishProductWithGate/);
  assert.match(coordinator, /category_growth_over_target_publication_ids:\s*\[\]/);
  assert.match(coordinator, /const CATEGORY_GROWTH_VERSION = "6"/);
});

test("daily target uses public plus actionable pending coverage", () => {
  assert.match(coordinator, /daily_target_invariant/);
  assert.match(coordinator, /daily_target_satisfied/);
  assert.match(coordinator, /post_publication_category_validation/);
  assert.match(coordinator, /public_runtime_validation/);
  assert.match(coordinator, /afterPolicy\.totalCardsNeeded === 0/);
  assert.match(coordinator, /publicValidation\.success/);
  assert.match(coordinator, /META DO DIA NÃO CUMPRIDA/);
});

test("editorial findings rank the V2 lot while objective integrity remains hard", () => {
  assert.match(base, /IMAGE_REVIEW_NOT_CLEAN_AFTER_REPAIR/);
  assert.match(base, /softWarnings\.push\(`CATALOG_SIMILARITY/);
  assert.match(base, /softWarnings\.push\(`BELOW_REVIEW_THRESHOLD/);
  assert.match(base, /PIPELINE_HARD_BLOCK/);
  assert.match(base, /AFFILIATE_IDENTITY_MISMATCH/);
  assert.match(base, /PRICE_UNVERIFIED_AFTER_OFFICIAL_SHOPEE_FALLBACK/);
  assert.match(base, /PUBLIC_CATEGORY_INVALID/);
  assert.match(base, /IMAGE_USABLE_MISSING/);
  assert.doesNotMatch(base, /BELOW_AUTO_PUBLISH_THRESHOLD/);
});

function publicProduct(id: string, categoria: Product["categoria"]): Product {
  const image = `https://cdn.example/${id}.jpg`;
  return {
    id,
    produto: `Produto ${id}`,
    displayTitle: `Produto editorial ${id}`,
    displayTitleStatus: "reviewed",
    categoria,
    preco: 100,
    imagens: [image],
    imageEditorialStatus: "clean",
    imageCuration: { status: "ready", rawImageUrls: [image], primaryImageUrl: image, galleryImageUrls: [], assessments: [] },
    link: `https://s.shopee.com.br/${id}`,
    ativo: true,
    destaque: false,
    status: "published",
    createdBy: "system",
  };
}

test("coverage distinguishes public, actionable, expired and orphan states and prioritizes cards_needed", () => {
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  const products = [
    ...Array.from({ length: 4 }, (_, index) => publicProduct(`light-${index}`, "Iluminação")),
    ...Array.from({ length: 5 }, (_, index) => publicProduct(`decor-${index}`, "Decoração")),
  ];
  const policy = calculateCategoryCoveragePolicy(products, [
    { categoria: "Iluminação", status: "pending", expiresAt: now + 60_000 },
    { categoria: "Móveis", status: "pending", expiresAt: now + 60_000 },
    { categoria: "Móveis", status: "pending", expiresAt: now - 1 },
    { categoria: "Móveis", status: "expired", expiresAt: now - 1 },
    { categoria: "Móveis", status: "rejected" },
    { categoria: "Móveis", status: "cancelled" },
    { categoria: "Móveis", status: "error" },
    { categoria: "Móveis", status: "publishing", updatedAt: now - 60_000, lifecycle: { operationId: "PUB-active" } },
    { categoria: "Móveis", status: "publishing", updatedAt: now - 60 * 60_000, lifecycle: { operationId: "PUB-stale" } },
    { categoria: "Móveis", status: "publishing", updatedAt: now - 60_000 },
  ], 5, now);

  assert.deepEqual(policy.categoryCoverage["Iluminação"], {
    public_count: 4,
    public_deficit: 1,
    actionable_pending: 1,
    expired_pending: 0,
    coverage: 5,
    cards_needed: 0,
  });
  assert.deepEqual(policy.categoryCoverage["Móveis"], {
    public_count: 0,
    public_deficit: 5,
    actionable_pending: 2,
    expired_pending: 2,
    coverage: 2,
    cards_needed: 3,
  });
  const needs = policy.prioritizedCategories.map(category => policy.cardsNeeded[category]);
  assert.deepEqual(needs, [...needs].sort((left, right) => right - left));
  assert.ok(policy.prioritizedCategories.indexOf("Tecnologia") < policy.prioritizedCategories.indexOf("Móveis"));
  assert.ok(policy.prioritizedCategories.indexOf("Móveis") < policy.prioritizedCategories.indexOf("Iluminação"));
});

test("growth messaging promises accumulation instead of rotating healthy products away", () => {
  assert.match(coordinator, /piso operacional permanece/);
  assert.match(coordinator, /nenhuma peça saudável é removida só para manter limite/);
  assert.match(coordinator, /already-published healthy pieces are never retired to keep a cap/);
});
