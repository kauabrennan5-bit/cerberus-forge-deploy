import test from "node:test";
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
  const detail = mergeCerberusHistoryState({}, createProductHistoryState("produto-a", 321, { canGoBack: true, fromView: "catalog", relatedScrollX: 165.4 }));
  const catalogEntry = readCerberusHistoryEntry(catalog);
  const detailEntry = readCerberusHistoryEntry(detail);
  assert.equal((catalogEntry as any).scrollY, 900);
  assert.equal((detailEntry as any).scrollY, 321);
  assert.equal((detailEntry as any).relatedScrollX, 165);
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
