import React, { useState, useMemo } from 'react';
// Mobile refinement: preserve the existing archival grid while making filters, headings, and controls wrap within the viewport.
import { Product } from '../types';
import { ProductCard } from './ProductCard';
import { Search, RefreshCw, AlertCircle, Sparkles, ChevronDown, ChevronUp, ArrowUpRight, X, Heart } from 'lucide-react';
import { CerberusLogo } from './CerberusLogo';

const BASE_CATEGORIES = [
  'Iluminação',
  'Decoração',
  'Móveis',
  'Cozinha & Mesa',
  'Organização',
  'Vestuário',
  'Calçados & Acessórios',
  'Tecnologia',
  'Beleza & Bem-estar',
  'Infantil',
] as const;

interface ProductGridProps {
  products: Product[];
  favorites: string[];
  onToggleFavorite: (id: string) => void;
  onSelectProduct: (product: Product) => void;
  showOnlyFavorites: boolean;
  onToggleShowFavorites: () => void;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  onOpenSettings: () => void;
  metaPixelId?: string;
  metaAccessToken?: string;
}

export const ProductGrid: React.FC<ProductGridProps> = ({
  products,
  favorites,
  onToggleFavorite,
  onSelectProduct,
  showOnlyFavorites,
  onToggleShowFavorites,
  isLoading,
  error,
  onRefresh,
  onOpenSettings,
  metaPixelId,
  metaAccessToken
}) => {
  const [selectedCategory, setSelectedCategory] = useState<string>('Todos');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isCategoryPanelOpen, setIsCategoryPanelOpen] = useState(false);

  // A navegação apresenta a taxonomia editorial que será aplicada às próximas
  // publicações. Não reclassifica produtos históricos automaticamente.
  const categories = useMemo(() => {
    return BASE_CATEGORIES.map((name) => ({
      name,
      count: products.filter((product) => product.categoria.toLowerCase() === name.toLowerCase()).length,
    }));
  }, []);

  // Filter products by selected category, search string, and favorites
  const filteredProducts = useMemo(() => {
    return products.filter((product) => {
      // Favorites filter
      if (showOnlyFavorites && !favorites.includes(product.id)) {
        return false;
      }

      // Category filter
      const matchesCategory =
        selectedCategory === 'Todos' ||
        product.categoria.toLowerCase() === selectedCategory.toLowerCase();

      // Search filter
      const query = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !query ||
        product.produto.toLowerCase().includes(query) ||
        product.categoria.toLowerCase().includes(query);

      return matchesCategory && matchesSearch;
    });
  }, [products, favorites, showOnlyFavorites, selectedCategory, searchQuery]);

  return (
    <section className="space-y-6 py-2 font-sans animate-fade-in w-full max-w-full min-w-0">
      
      {/* Search & Header Controls */}
      <div className="flex min-w-0 flex-col md:flex-row md:items-end justify-between gap-4 border-b border-[#3A342E] pb-5 w-full">
        <div className="min-w-0 flex-1">
          <div className="flex items-center space-x-2 flex-wrap gap-y-1">
            <span className="stamp-badge text-[9px] px-1.5 py-0.2">
              {showOnlyFavorites ? 'PEÇAS SALVAS' : 'CATÁLOGO ARCHIVAL'}
            </span>
            {showOnlyFavorites && (
              <span className="px-2 py-0.5 bg-[#8A1F1F] text-[#E8E1D3] font-display text-[9px] uppercase tracking-widest rounded-none">
                FAVORITOS ({favorites.length})
              </span>
            )}
          </div>
          
          <h1 className="font-gothic text-[clamp(1.75rem,8vw,3rem)] sm:text-5xl font-normal tracking-wide text-[#E8E1D3] mt-2 break-words">
            {showOnlyFavorites ? 'Peças Salvas na Lista' : 'Acervo Cerberus'}
          </h1>
          
          <p className="text-xs font-condensed uppercase tracking-wider text-[#E8E1D3]/70 mt-1 max-w-xl leading-relaxed">
            {showOnlyFavorites
              ? 'Sua seleção pessoal de peças e vestuário gravados no dispositivo.'
              : 'Seleção de peças de design, vestuário, calçados e utilitários curados diretamente das melhores lojas oficiais.'}
          </p>
        </div>

        {/* Live Search Input */}
        <div className="relative w-full md:w-72 md:max-w-[18rem] shrink-0">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#8A1F1F]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar por peça, marca, tipo..."
            className="w-full bg-[#141210] border border-[#3A342E] focus:border-[#8A1F1F] text-[#E8E1D3] text-xs font-display uppercase tracking-wider rounded-none pl-9 pr-8 py-2.5 focus:outline-none transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#E8E1D3]/50 hover:text-[#E8E1D3]"
              title="Limpar busca"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Category Panel: retail-navigation inspired, without copied branding or assets. */}
      <div className="w-full min-w-0 border-y border-[#3A342E] bg-[#0B0908]">
        <div className="flex flex-col gap-2 p-2 sm:flex-row sm:items-stretch sm:justify-between sm:p-0">
          <button
            type="button"
            aria-expanded={isCategoryPanelOpen}
            aria-controls="category-panel"
            onClick={() => setIsCategoryPanelOpen((open) => !open)}
            className="group flex min-h-14 min-w-0 flex-1 items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-[#141210] sm:px-4"
          >
            <span className="min-w-0">
              <span className="block text-[9px] font-display uppercase tracking-[0.24em] text-[#8A1F1F]">Explorar acervo</span>
              <span className="mt-0.5 block truncate font-gothic text-lg text-[#E8E1D3] sm:text-xl">
                {selectedCategory === 'Todos' ? 'Categorias' : selectedCategory}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2 text-[10px] font-display uppercase tracking-widest text-[#E8E1D3]/65 group-hover:text-[#E8E1D3]">
              {isCategoryPanelOpen ? 'Fechar' : 'Abrir'}
              {isCategoryPanelOpen ? <ChevronUp className="h-4 w-4 text-[#D7A64B]" /> : <ChevronDown className="h-4 w-4 text-[#D7A64B]" />}
            </span>
          </button>

          <button
            onClick={onToggleShowFavorites}
            className={`min-h-12 shrink-0 border border-[#3A342E] px-3 py-2 text-xs font-display uppercase tracking-widest transition-all sm:border-y-0 sm:border-l sm:border-r-0 sm:px-4 ${
              showOnlyFavorites
                ? 'bg-[#8A1F1F] text-[#E8E1D3] border-[#8A1F1F]'
                : 'bg-[#0B0908] text-[#E8E1D3]/70 hover:bg-[#141210] hover:text-[#E8E1D3]'
            }`}
          >
            <span className="flex items-center justify-center gap-1.5">
              <Heart className={`h-3.5 w-3.5 ${showOnlyFavorites || favorites.length > 0 ? 'fill-[#8A1F1F] text-[#8A1F1F]' : 'text-[#E8E1D3]'}`} />
              <span>Salvos ({favorites.length})</span>
            </span>
          </button>
        </div>

        {isCategoryPanelOpen && (
          <div id="category-panel" data-testid="category-panel" className="border-t border-[#3A342E] bg-[#141210] p-3 sm:p-4 animate-fade-in">
            <div className="mb-3 flex items-center justify-between gap-3 border-b border-[#3A342E]/70 pb-2">
              <p className="text-[9px] font-display uppercase tracking-[0.2em] text-[#E8E1D3]/55">Selecione uma categoria</p>
              {selectedCategory !== 'Todos' && (
                <button
                  type="button"
                  onClick={() => setSelectedCategory('Todos')}
                  className="text-[9px] font-display uppercase tracking-widest text-[#D7A64B] hover:text-[#E8E1D3]"
                >
                  Ver todo o acervo
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 border-l border-t border-[#3A342E] sm:grid-cols-2 lg:grid-cols-5">
              {categories.map((category) => (
                <button
                  type="button"
                  key={category.name}
                  onClick={() => {
                    setSelectedCategory(category.name);
                    setIsCategoryPanelOpen(false);
                  }}
                  className={`group flex min-h-24 min-w-0 flex-col justify-between border-b border-r border-[#3A342E] p-3 text-left transition-colors ${
                    selectedCategory === category.name
                      ? 'bg-[#8A1F1F] text-[#E8E1D3]'
                      : 'bg-[#141210] text-[#E8E1D3] hover:bg-[#211C18]'
                  }`}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="font-gothic text-base leading-tight">{category.name}</span>
                    <ArrowUpRight className={`h-4 w-4 shrink-0 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 ${selectedCategory === category.name ? 'text-[#E8E1D3]' : 'text-[#D7A64B]'}`} />
                  </span>
                  <span className={`mt-3 text-[9px] font-display uppercase tracking-widest ${selectedCategory === category.name ? 'text-[#E8E1D3]/75' : 'text-[#E8E1D3]/50'}`}>
                    {category.count.toString().padStart(2, '0')} {category.count === 1 ? 'peça' : 'peças'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Elegant Shimmer Skeleton Loading */}
      {isLoading && (
        <div className="space-y-6">
          <div className="flex items-center justify-center space-x-3 py-4 text-[#E8E1D3]/50">
            <CerberusLogo className="w-8 h-8 animate-pulse" />
            <span className="font-display text-xs uppercase tracking-widest animate-pulse">
              Carregando Acervo Cerberus...
            </span>
          </div>

          <div className="grid min-w-0 grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4 lg:gap-5">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <div key={n} className="bg-[#141210] border border-[#3A342E] rounded-none p-3 space-y-3">
                <div className="aspect-square skeleton-shimmer rounded-none border border-[#3A342E]" />
                <div className="h-3 skeleton-shimmer rounded-none w-3/4" />
                <div className="h-3 skeleton-shimmer rounded-none w-1/2" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Error Banner */}
      {!isLoading && error && (
        <div className="bg-[#141210] border border-[#8A1F1F] rounded-none p-8 text-center space-y-4 my-6">
          <div className="w-12 h-12 rounded-none bg-[#8A1F1F]/20 text-[#8A1F1F] flex items-center justify-center mx-auto border border-[#8A1F1F]">
            <AlertCircle className="w-6 h-6" />
          </div>
          <div>
            <h3 className="font-gothic text-2xl font-normal text-[#E8E1D3]">
              Falha na Conexão do Acervo
            </h3>
            <p className="text-xs text-[#E8E1D3]/70 mt-1 max-w-md mx-auto">
              {error}
            </p>
          </div>
          <div className="flex items-center justify-center space-x-3 pt-2">
            <button
              onClick={onRefresh}
              className="px-4 py-2 bg-[#0B0908] border border-[#3A342E] hover:border-[#8A1F1F] text-[#E8E1D3] rounded-none text-xs font-display uppercase tracking-widest flex items-center space-x-1.5 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5 text-[#8A1F1F]" />
              <span>Recarregar Catálogo</span>
            </button>
          </div>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && filteredProducts.length === 0 && (
        <div className="bg-[#141210] border border-[#3A342E] rounded-none p-12 text-center space-y-4 my-8">
          <Sparkles className="w-8 h-8 text-[#8A1F1F] mx-auto opacity-80" />
          <h3 className="font-gothic text-3xl text-[#E8E1D3]">
            {showOnlyFavorites ? 'Nenhuma Peça Salva' : 'Nenhuma Peça Encontrada'}
          </h3>
          <p className="text-xs text-[#E8E1D3]/70 max-w-sm mx-auto leading-relaxed">
            {showOnlyFavorites
              ? 'Você ainda não salvou nenhuma peça. Clique no ícone de coração nos cards do catálogo para salvar.'
              : searchQuery
              ? `Nenhuma peça no acervo corresponde a "${searchQuery}".`
              : selectedCategory === 'Todos'
                ? 'O acervo está pronto para receber as próximas peças publicadas.'
                : `Ainda não há peças publicadas em ${selectedCategory}.`}
          </p>
          {(searchQuery || showOnlyFavorites) && (
            <button
              onClick={() => {
                setSearchQuery('');
                if (showOnlyFavorites) onToggleShowFavorites();
              }}
              className="px-4 py-2 bg-[#8A1F1F] text-[#E8E1D3] text-xs font-display uppercase tracking-widest rounded-none hover:bg-[#8A1F1F]/80 transition-colors"
            >
              Limpar Filtros
            </button>
          )}
        </div>
      )}

      {/* Main Responsive Grid (Mobile: 2 cols | Tablet: 3 cols | Desktop: 4-5 cols) */}
      {!isLoading && !error && filteredProducts.length > 0 && (
        <div className="grid min-w-0 grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4 lg:gap-5">
          {filteredProducts.map((product, idx) => (
            <ProductCard
              key={product.id}
              product={product}
              index={product.rawRowIndex ?? idx}
              isFavorite={favorites.includes(product.id)}
              onToggleFavorite={onToggleFavorite}
              onSelectProduct={onSelectProduct}
              metaPixelId={metaPixelId}
              metaAccessToken={metaAccessToken}
            />
          ))}
        </div>
      )}

    </section>
  );
};
