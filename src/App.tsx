import { useEffect, useState, useCallback, useRef, type FormEvent } from 'react';
// Mobile refinement: preserve the Cerberus archival dark/red identity while keeping every public layout region intrinsically contained across narrow viewports.
import { AppConfig, Product, ViewMode } from './types';
import { initMetaPixel, initTikTokPixel } from './lib/pixels';
import { captureUTMs } from './lib/utm';
import { initGA4, trackPageView, trackViewItem } from './lib/analytics';
import { getProducts, getPublicSocialLinks, subscribeNewsletter, type PublicSocialLink } from './services/api';
import { orderCatalogProducts } from './lib/catalogOrder';
import { getRelatedProducts } from './lib/relatedProducts';
import { Header } from './components/Header';
import { ProductGrid } from './components/ProductGrid';
import { ProductDetail } from './components/ProductDetail';
import { AdminForm } from './components/AdminForm';
import { SettingsModal } from './components/SettingsModal';
import { InstitutionalPage } from './components/InstitutionalPage';
import { INSTITUTIONAL_PATHS } from './config/institutional';

const CONFIG_STORAGE_KEY = 'cerberus_finds_config_v2';
const FAVORITES_STORAGE_KEY = 'cerberus_finds_favorites_v1';
const CATALOG_SCROLL_STORAGE_KEY = 'cerberus_catalog_scroll_v1';

type CatalogScrollSnapshot = { path: string; y: number };

function normalizeCatalogScrollY(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function serializeCatalogScroll(y: unknown, path = '/'): string {
  const snapshot: CatalogScrollSnapshot = { path: path || '/', y: normalizeCatalogScrollY(y) };
  return JSON.stringify(snapshot);
}

function parseCatalogScroll(value: string | null | undefined, expectedPath = '/'): number | null {
  if (!value) return null;
  try {
    const snapshot = JSON.parse(value) as Partial<CatalogScrollSnapshot>;
    if (snapshot.path && snapshot.path !== (expectedPath || '/')) return null;
    if (typeof snapshot.y !== 'number' || !Number.isFinite(snapshot.y)) return null;
    return normalizeCatalogScrollY(snapshot.y);
  } catch {
    return null;
  }
}

const DEFAULT_CONFIG: AppConfig = {
  csvUrl: '',
  appsScriptUrl: '',
  metaPixelId: '',
  metaAccessToken: '',
  tikTokPixelId: '',
  adminPassword: ''
};

export default function App() {
  const [currentView, setCurrentView] = useState<ViewMode>(() => {
    if (typeof window !== 'undefined') {
      const path = window.location.pathname;
      if (path === INSTITUTIONAL_PATHS.privacy) return 'privacy';
      if (path === INSTITUTIONAL_PATHS.terms) return 'terms';
      if (path.startsWith('/produto/')) return 'product-detail';
      if (path.startsWith('/admin')) return 'admin';

      const params = new URLSearchParams(window.location.search);
      if (params.get('produto')) return 'product-detail';
      const viewParam = params.get('view') || params.get('mode');
      if (viewParam === 'admin' || viewParam === 'form') return 'admin';
    }
    return 'catalog';
  });

  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const catalogScrollYRef = useRef<number | null>(null);
  const [showOnlyFavorites, setShowOnlyFavorites] = useState<boolean>(false);

  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(FAVORITES_STORAGE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [config, setConfig] = useState<AppConfig>(() => {
    try {
      const saved = localStorage.getItem(CONFIG_STORAGE_KEY);
      if (saved) return { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
    } catch {
      // ignore
    }
    return DEFAULT_CONFIG;
  });

  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoadingProducts, setIsLoadingProducts] = useState<boolean>(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [newsletterEmail, setNewsletterEmail] = useState('');
  const [newsletterConsent, setNewsletterConsent] = useState(false);
  const [newsletterStatus, setNewsletterStatus] = useState<string | null>(null);
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [socialLinks, setSocialLinks] = useState<PublicSocialLink[]>([]);

  const restoreCatalogScroll = useCallback(() => {
    if (typeof window === 'undefined') return;
    let target = catalogScrollYRef.current;
    if (target === null) {
      try {
        target = parseCatalogScroll(window.sessionStorage.getItem(CATALOG_SCROLL_STORAGE_KEY), window.location.pathname);
      } catch {
        target = null;
      }
    }
    if (target === null) return;
    catalogScrollYRef.current = target;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => window.scrollTo({ top: target ?? 0, behavior: 'auto' }));
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !("scrollRestoration" in window.history)) return;
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    return () => {
      window.history.scrollRestoration = previous;
    };
  }, []);

  useEffect(() => {
    let active = true;
    getPublicSocialLinks().then((links) => {
      if (active) setSocialLinks(links);
    });
    return () => {
      active = false;
    };
  }, []);

  // Initialize Tracking (UTMs, Pixels, GA4) on mount and when config changes
  useEffect(() => {
    captureUTMs();
    initGA4();

    if (config.metaPixelId) {
      initMetaPixel(config.metaPixelId);
    }
    if (config.tikTokPixelId) {
      initTikTokPixel(config.tikTokPixelId);
    }
  }, [config.metaPixelId, config.tikTokPixelId]);

  // Track Page Views on View / Route Change
  useEffect(() => {
    if (typeof window !== 'undefined') {
      trackPageView(window.location.pathname);
    }
  }, [currentView, selectedProduct]);

  // Track ViewContent when a product detail is viewed
  useEffect(() => {
    if (currentView === 'product-detail' && selectedProduct) {
      trackViewItem(selectedProduct);
    }
  }, [currentView, selectedProduct]);

  // Load Products from the canonical static projection (/data/products.json)
  const loadProducts = useCallback(async () => {
    setIsLoadingProducts(true);
    setFetchError(null);

    try {
      const productList = await getProducts();
      const orderedProducts = orderCatalogProducts(productList);
      setProducts(orderedProducts);

      // Check if current URL requests a specific product slug/id
      if (typeof window !== 'undefined') {
        const path = window.location.pathname;
        let requestedSlugOrId = '';
        if (path.startsWith('/produto/')) {
          requestedSlugOrId = path.replace('/produto/', '').trim();
        } else {
          const params = new URLSearchParams(window.location.search);
          requestedSlugOrId = params.get('produto') || '';
        }

        if (requestedSlugOrId) {
          const found = orderedProducts.find((p: Product) => p.slug === requestedSlugOrId || p.id === requestedSlugOrId);
          if (found) {
            setSelectedProduct(found);
            setCurrentView('product-detail');
          }
        }
      }
    } catch (err: any) {
      console.error('Erro ao carregar produtos:', err);
      setFetchError(`Catálogo indisponível: ${err.message || 'Falha ao carregar dados estáticos'}`);
    } finally {
      setIsLoadingProducts(false);
    }
  }, []);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  // Save config changes
  const handleSaveConfig = (newConfig: AppConfig) => {
    setConfig(newConfig);
    try {
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(newConfig));
    } catch (e) {
      console.warn('Erro ao salvar config no localStorage:', e);
    }
  };

  // Toggle Favorite Item
  const handleToggleFavorite = (id: string) => {
    setFavorites((prev) => {
      const next = prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id];
      try {
        localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(next));
      } catch (e) {
        console.warn('Erro ao salvar favoritos:', e);
      }
      return next;
    });
  };

  // Navigate to Product Detail View and update URL
  const handleSelectProduct = (product: Product) => {
    setSelectedProduct(product);
    setCurrentView('product-detail');
    if (typeof window !== 'undefined') {
      if (currentView === 'catalog') {
        const currentScrollY = window.scrollY;
        catalogScrollYRef.current = currentScrollY;
        try {
          window.sessionStorage.setItem(CATALOG_SCROLL_STORAGE_KEY, serializeCatalogScroll(currentScrollY, window.location.pathname));
        } catch {
          // A restauração baseada em sessionStorage é uma melhoria; a navegação continua funcional sem ela.
        }
      }
      const slug = product.slug || product.id;
      window.history.pushState({}, '', `/produto/${slug}`);
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  };

  // Handle Back to Catalog from Detail
  const handleBackToCatalog = () => {
    setCurrentView('catalog');
    setSelectedProduct(null);
    if (typeof window !== 'undefined') {
      window.history.pushState({}, '', '/');
      restoreCatalogScroll();
    }
  };

  const handleSelectView = (view: ViewMode) => {
    if (view !== 'product-detail') {
      setSelectedProduct(null);
      if (typeof window !== 'undefined') {
        const path = view === 'admin'
          ? '/admin'
          : view === 'privacy'
            ? INSTITUTIONAL_PATHS.privacy
            : view === 'terms'
              ? INSTITUTIONAL_PATHS.terms
              : '/';
        window.history.pushState({}, '', path);
      }
    }
    setCurrentView(view);
    if (view === 'catalog') restoreCatalogScroll();
  };

  const handleNewsletterSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNewsletterStatus(null);
    if (!newsletterConsent) {
      setNewsletterStatus('Confirme que deseja receber novas seleções, recomendações e ofertas.');
      return;
    }
    setIsSubscribing(true);
    const result = await subscribeNewsletter(newsletterEmail, newsletterConsent);
    setIsSubscribing(false);
    if (result.success) {
      setNewsletterEmail('');
      setNewsletterConsent(false);
      setNewsletterStatus('Inscrição registrada.');
      return;
    }
    setNewsletterStatus(result.error || 'Cadastro indisponível.');
  };

  // Listen to popstate browser navigation (Back/Forward)
  useEffect(() => {
    const handlePopState = () => {
      const path = window.location.pathname;
      if (path === INSTITUTIONAL_PATHS.privacy) {
        setCurrentView('privacy');
        setSelectedProduct(null);
      } else if (path === INSTITUTIONAL_PATHS.terms) {
        setCurrentView('terms');
        setSelectedProduct(null);
      } else if (path.startsWith('/admin')) {
        setCurrentView('admin');
        setSelectedProduct(null);
      } else if (path.startsWith('/produto/')) {
        const requestedSlugOrId = path.replace('/produto/', '').trim();
        const found = products.find((p) => p.slug === requestedSlugOrId || p.id === requestedSlugOrId);
        if (found) {
          setSelectedProduct(found);
          setCurrentView('product-detail');
        }
      } else {
        const params = new URLSearchParams(window.location.search);
        const viewParam = params.get('view') || params.get('mode');
        if (viewParam === 'admin' || viewParam === 'form') {
          setCurrentView('admin');
        } else {
          setCurrentView('catalog');
          setSelectedProduct(null);
          restoreCatalogScroll();
        }
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [products]);

  // Get active categories
  const existingCategories = Array.from(
    new Set(products.map((p) => p.categoria).filter(Boolean))
  );
  const relatedProducts = selectedProduct ? getRelatedProducts(selectedProduct, products) : [];

  return (
    <div className="min-h-screen min-w-0 bg-noise bg-[#0B0908] text-[#E8E1D3] flex flex-col font-sans selection:bg-[#8A1F1F] selection:text-[#E8E1D3] w-full max-w-full">
      
      {/* Public Header Bar (No Admin button visible) */}
      <Header
        currentView={currentView}
        onSelectView={handleSelectView}
        onOpenSettings={() => setIsSettingsOpen(true)}
        productCount={products.length}
        favoritesCount={favorites.length}
        showOnlyFavorites={showOnlyFavorites}
        onToggleShowFavorites={() => setShowOnlyFavorites((prev) => !prev)}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-3 sm:px-6 py-4 sm:py-6 min-w-0">
        {currentView === 'catalog' && (
          <ProductGrid
            products={products}
            favorites={favorites}
            onToggleFavorite={handleToggleFavorite}
            onSelectProduct={handleSelectProduct}
            showOnlyFavorites={showOnlyFavorites}
            onToggleShowFavorites={() => setShowOnlyFavorites((prev) => !prev)}
            isLoading={isLoadingProducts}
            error={fetchError}
            onRefresh={loadProducts}
            onOpenSettings={() => setIsSettingsOpen(true)}
            metaPixelId={config.metaPixelId}
            metaAccessToken={config.metaAccessToken}
          />
        )}

        {currentView === 'product-detail' && selectedProduct && (
          <ProductDetail
            product={selectedProduct}
            index={products.findIndex((p) => p.id === selectedProduct.id)}
            isFavorite={favorites.includes(selectedProduct.id)}
            favoriteIds={favorites}
            onToggleFavorite={handleToggleFavorite}
            onBack={handleBackToCatalog}
            relatedProducts={relatedProducts}
            onSelectProduct={handleSelectProduct}
            metaPixelId={config.metaPixelId}
            metaAccessToken={config.metaAccessToken}
          />
        )}

        {(currentView === 'privacy' || currentView === 'terms') && (
          <InstitutionalPage
            kind={currentView}
            onBackToSite={() => handleSelectView('catalog')}
            onNavigate={(path) => handleSelectView(path === INSTITUTIONAL_PATHS.privacy ? 'privacy' : 'terms')}
            socialLinks={socialLinks}
          />
        )}

        {currentView === 'admin' && (
          <AdminForm
            config={config}
            products={products}
            existingCategories={existingCategories}
            onProductAdded={loadProducts}
            onProductUpdated={(updatedProduct) => {
              setProducts((prev) => prev.map((p) => (p.id === updatedProduct.id ? updatedProduct : p)));
              if (selectedProduct?.id === updatedProduct.id) {
                setSelectedProduct(updatedProduct);
              }
              loadProducts();
            }}
            onProductDeleted={(deletedId) => {
              console.log('[DELETE LOG 11] Atualização do estado React em App.tsx. Removendo ID do estado:', deletedId);
              setProducts((prev) => {
                const nextProducts = prev.filter((p) => p.id !== deletedId);
                console.log(`[DELETE LOG 11] Estado React atualizado. Quantidade de produtos anterior: ${prev.length}, nova: ${nextProducts.length}`);
                return nextProducts;
              });
              if (selectedProduct?.id === deletedId) {
                setSelectedProduct(null);
              }
            }}
            onOpenSettings={() => setIsSettingsOpen(true)}
          />
        )}
      </main>

      {/* Gothic / Archival Footer */}
      {currentView !== 'privacy' && currentView !== 'terms' && (
      <footer className="border-t border-[#3A342E] bg-[#141210] py-8 px-4 text-center text-xs text-[#E8E1D3]/60 w-full max-w-full min-w-0">
        <div className="max-w-7xl mx-auto min-w-0 flex flex-col lg:flex-row items-center justify-between gap-5 font-sans">
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center">
            <div className="flex items-center space-x-3">
              <span className="font-gothic text-xl text-[#E8E1D3] tracking-wide uppercase">
                CERBERUS FINDS
              </span>
              <span className="text-[10px] text-[#8A1F1F]">|</span>
              <span className="text-[11px] font-condensed uppercase tracking-wider text-[#E8E1D3]/70">
                UNDERGROUND ARCHIVAL CURATION
              </span>
            </div>
            {socialLinks.length > 0 && (
              <div className="flex items-center gap-2" aria-label="Encontre a Cerberus Finds nas redes sociais">
                <span className="mr-1 text-[9px] font-display uppercase tracking-widest text-[#E8E1D3]/45">Encontre</span>
                {socialLinks.map((link) => (
                  <a key={link.network} href={link.url} target="_blank" rel="noreferrer" aria-label={link.label} title={link.label} className="flex h-8 w-8 items-center justify-center border border-[#3A342E] bg-[#0B0908] p-1.5 transition-colors hover:border-[#8A1F1F]">
                    <img src={`/assets/newsletter/social/${link.network}.png`} alt={link.label} className="h-full w-full object-contain" />
                  </a>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-center gap-4 text-xs font-display uppercase tracking-widest text-[#E8E1D3]/80">
            <button
              onClick={() => handleSelectView('catalog')}
              className="hover:text-[#8A1F1F] transition-colors"
            >
              Acervo
            </button>
            <a
              href={INSTITUTIONAL_PATHS.privacy}
              onClick={(event) => {
                event.preventDefault();
                handleSelectView('privacy');
              }}
              className="hover:text-[#8A1F1F] transition-colors"
            >
              Privacidade
            </a>
            <a
              href={INSTITUTIONAL_PATHS.terms}
              onClick={(event) => {
                event.preventDefault();
                handleSelectView('terms');
              }}
              className="hover:text-[#8A1F1F] transition-colors"
            >
              Termos
            </a>
          </div>

          <form onSubmit={handleNewsletterSubmit} className="w-full max-w-md flex flex-col items-stretch gap-1.5 text-left" noValidate>
            <label htmlFor="newsletter-email" className="text-[9px] font-display uppercase tracking-widest text-[#E8E1D3]/70">Receba novas seleções</label>
            <div className="flex min-w-0">
              <input
                id="newsletter-email"
                type="email"
                required
                autoComplete="email"
                value={newsletterEmail}
                onChange={(event) => setNewsletterEmail(event.target.value)}
                placeholder="seu@email.com"
                className="min-w-0 flex-1 border border-[#3A342E] bg-[#0B0908] px-3 py-2 text-xs text-[#E8E1D3] outline-none placeholder:text-[#E8E1D3]/35 focus:border-[#8A1F1F]"
              />
              <button type="submit" disabled={isSubscribing} className="border border-l-0 border-[#8A1F1F] bg-[#8A1F1F] px-3 py-2 text-[9px] font-display uppercase tracking-wider text-[#E8E1D3] transition-colors hover:bg-[#8A1F1F]/80 disabled:opacity-60">
                {isSubscribing ? 'Enviando' : 'Receber'}
              </button>
            </div>
            <label htmlFor="newsletter-consent" className="flex items-start gap-2 text-[10px] leading-4 text-[#E8E1D3]/65">
              <input
                id="newsletter-consent"
                type="checkbox"
                required
                checked={newsletterConsent}
                onChange={(event) => setNewsletterConsent(event.target.checked)}
                className="mt-0.5 accent-[#8A1F1F]"
              />
              <span>Quero receber por e-mail novas seleções, recomendações e ofertas.</span>
            </label>
            {newsletterStatus && <p role="status" className="text-[10px] text-[#E8E1D3]/70">{newsletterStatus}</p>}
          </form>
        </div>
      </footer>
      )}

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        config={config}
        onSaveConfig={handleSaveConfig}
        onClose={() => setIsSettingsOpen(false)}
      />

    </div>
  );
}
