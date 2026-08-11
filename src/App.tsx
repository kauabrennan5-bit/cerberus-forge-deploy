import { useState, useEffect, useCallback } from 'react';
import { AppConfig, Product, ViewMode } from './types';
import { initMetaPixel, initTikTokPixel } from './lib/pixels';
import { captureUTMs } from './lib/utm';
import { initGA4, trackPageView, trackViewItem } from './lib/analytics';
import { getProducts } from './services/api';

import { Header } from './components/Header';
import { ProductGrid } from './components/ProductGrid';
import { ProductDetail } from './components/ProductDetail';
import { AdminForm } from './components/AdminForm';
import { SettingsModal } from './components/SettingsModal';

const CONFIG_STORAGE_KEY = 'cerberus_finds_config_v2';
const FAVORITES_STORAGE_KEY = 'cerberus_finds_favorites_v1';

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

  // Load Products from Backend REST API (/api/products)
  const loadProducts = useCallback(async () => {
    setIsLoadingProducts(true);
    setFetchError(null);

    try {
      const productList = await getProducts();
      setProducts(productList);

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
          const found = productList.find((p: Product) => p.slug === requestedSlugOrId || p.id === requestedSlugOrId);
          if (found) {
            setSelectedProduct(found);
            setCurrentView('product-detail');
          }
        }
      }
    } catch (err: any) {
      console.error('Erro ao carregar produtos:', err);
      setFetchError(`Falha de conexão com o backend: ${err.message || 'Servidor indisponível'}`);
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
      const slug = product.slug || product.id;
      window.history.pushState({}, '', `/produto/${slug}`);
    }
  };

  // Handle Back to Catalog from Detail
  const handleBackToCatalog = () => {
    setCurrentView('catalog');
    setSelectedProduct(null);
    if (typeof window !== 'undefined') {
      window.history.pushState({}, '', '/');
    }
  };

  const handleSelectView = (view: ViewMode) => {
    if (view !== 'product-detail') {
      setSelectedProduct(null);
      if (typeof window !== 'undefined') {
        if (view === 'admin') {
          window.history.pushState({}, '', '/admin');
        } else {
          window.history.pushState({}, '', '/');
        }
      }
    }
    setCurrentView(view);
  };

  // Listen to popstate browser navigation (Back/Forward)
  useEffect(() => {
    const handlePopState = () => {
      const path = window.location.pathname;
      if (path.startsWith('/admin')) {
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

  return (
    <div className="min-h-screen bg-noise bg-[#0B0908] text-[#E8E1D3] flex flex-col font-sans selection:bg-[#8A1F1F] selection:text-[#E8E1D3] w-full max-w-full overflow-x-hidden">
      
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
            onToggleFavorite={handleToggleFavorite}
            onBack={handleBackToCatalog}
            metaPixelId={config.metaPixelId}
            metaAccessToken={config.metaAccessToken}
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
      <footer className="border-t border-[#3A342E] bg-[#141210] py-8 px-4 text-center text-xs text-[#E8E1D3]/60 w-full max-w-full overflow-x-hidden">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 font-sans">
          <div className="flex items-center space-x-3">
            <span className="font-gothic text-xl text-[#E8E1D3] tracking-wide uppercase">
              CERBERUS FINDS
            </span>
            <span className="text-[10px] text-[#8A1F1F]">|</span>
            <span className="text-[11px] font-condensed uppercase tracking-wider text-[#E8E1D3]/70">
              UNDERGROUND ARCHIVAL CURATION
            </span>
          </div>

          <div className="flex items-center space-x-6 text-xs font-display uppercase tracking-widest text-[#E8E1D3]/80">
            <button
              onClick={() => handleSelectView('catalog')}
              className="hover:text-[#8A1F1F] transition-colors"
            >
              Acervo
            </button>
          </div>
        </div>
      </footer>

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
