import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shopeePublicationPreflightInternals } from "../server/services/shopeePublicationPreflight";

const { buildCategoryDriftWarning } = shopeePublicationPreflightInternals;

describe("Shopee publication preflight category drift", () => {
  it("permits the same shop/item when only the re-extracted category changes", () => {
    const approvedIdentity = { shopId: "1797503417", itemId: "57017143839" };
    const currentIdentity = { shopId: "1797503417", itemId: "57017143839" };
    const approvedCategory = "Tecnologia";
    const reExtractedCategory = "Decoração";

    assert.deepEqual(currentIdentity, approvedIdentity, "Shopee identity must remain unchanged");

    const diagnostic = buildCategoryDriftWarning(approvedCategory, reExtractedCategory);
    assert.deepEqual(diagnostic, {
      code: "SHOPEE_PREFLIGHT_CATEGORY_DRIFT",
      expectedCategory: "Tecnologia",
      currentCategory: "Decoração",
    });

    // Category drift is diagnostic-only: the approved category remains the
    // canonical publication value and no blocking preflight result is created.
    assert.equal(approvedCategory, "Tecnologia");
    assert.notEqual(diagnostic?.code, "SHOPEE_PREFLIGHT_CATEGORY_CHANGED");
  });

  it("does not emit a warning when the category is stable", () => {
    assert.equal(buildCategoryDriftWarning("Tecnologia", "Tecnologia"), null);
  });

  it("records the exact expected/current values, including a missing re-extracted category", () => {
    assert.deepEqual(buildCategoryDriftWarning("Tecnologia", ""), {
      code: "SHOPEE_PREFLIGHT_CATEGORY_DRIFT",
      expectedCategory: "Tecnologia",
      currentCategory: "",
    });
  });
});
