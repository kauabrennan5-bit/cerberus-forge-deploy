export interface CatalogViewState {
  selectedCategory: string;
  searchQuery: string;
  isCategoryPanelOpen: boolean;
}

export const DEFAULT_CATALOG_VIEW_STATE: CatalogViewState = {
  selectedCategory: 'Todos',
  searchQuery: '',
  isCategoryPanelOpen: false,
};

export interface CatalogHistoryEntry {
  view: 'catalog';
  catalog: CatalogViewState;
  showOnlyFavorites: boolean;
  scrollY: number;
}

export interface ProductHistoryEntry {
  view: 'product-detail';
  productKey: string;
  scrollY: number;
  relatedScrollX: number;
  canGoBack: boolean;
  fromView: 'catalog' | 'product-detail' | 'other';
}

export type CerberusHistoryEntry = CatalogHistoryEntry | ProductHistoryEntry;

export interface CerberusHistoryState {
  cerberus: CerberusHistoryEntry;
}

function normalizeScrollY(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

export function normalizeCatalogViewState(value: unknown): CatalogViewState {
  if (!value || typeof value !== 'object') return { ...DEFAULT_CATALOG_VIEW_STATE };
  const candidate = value as Partial<CatalogViewState>;
  return {
    selectedCategory: typeof candidate.selectedCategory === 'string' && candidate.selectedCategory.trim()
      ? candidate.selectedCategory.trim()
      : 'Todos',
    searchQuery: typeof candidate.searchQuery === 'string' ? candidate.searchQuery.slice(0, 200) : '',
    isCategoryPanelOpen: candidate.isCategoryPanelOpen === true,
  };
}

export function createCatalogHistoryState(
  catalog: CatalogViewState,
  showOnlyFavorites: boolean,
  scrollY: unknown,
): CerberusHistoryState {
  return {
    cerberus: {
      view: 'catalog',
      catalog: normalizeCatalogViewState(catalog),
      showOnlyFavorites: showOnlyFavorites === true,
      scrollY: normalizeScrollY(scrollY),
    },
  };
}

export function createProductHistoryState(
  productKey: string,
  scrollY: unknown,
  options: { canGoBack: boolean; fromView: ProductHistoryEntry['fromView']; relatedScrollX?: unknown },
): CerberusHistoryState {
  return {
    cerberus: {
      view: 'product-detail',
      productKey: String(productKey || '').trim(),
      scrollY: normalizeScrollY(scrollY),
      relatedScrollX: normalizeScrollY(options.relatedScrollX),
      canGoBack: options.canGoBack === true,
      fromView: options.fromView,
    },
  };
}

export function readCerberusHistoryEntry(value: unknown): CerberusHistoryEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as { cerberus?: unknown }).cerberus;
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Partial<CerberusHistoryEntry> & Record<string, unknown>;

  if (entry.view === 'catalog') {
    return {
      view: 'catalog',
      catalog: normalizeCatalogViewState(entry.catalog),
      showOnlyFavorites: entry.showOnlyFavorites === true,
      scrollY: normalizeScrollY(entry.scrollY),
    };
  }

  if (entry.view === 'product-detail' && typeof entry.productKey === 'string' && entry.productKey.trim()) {
    const fromView = entry.fromView === 'catalog' || entry.fromView === 'product-detail' ? entry.fromView : 'other';
    return {
      view: 'product-detail',
      productKey: entry.productKey.trim(),
      scrollY: normalizeScrollY(entry.scrollY),
      relatedScrollX: normalizeScrollY(entry.relatedScrollX),
      canGoBack: entry.canGoBack === true,
      fromView,
    };
  }

  return null;
}

/**
 * Preserve unrelated history.state fields while replacing only the Cerberus payload.
 */
export function mergeCerberusHistoryState(current: unknown, next: CerberusHistoryState): Record<string, unknown> {
  const base = current && typeof current === 'object' ? current as Record<string, unknown> : {};
  return { ...base, ...next };
}
