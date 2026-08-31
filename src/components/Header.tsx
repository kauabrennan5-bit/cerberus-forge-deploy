import React from 'react';
// Mobile refinement: keep the approved Cerberus header identity while allowing the brand and actions to shrink safely instead of forcing lateral overflow.
import { ViewMode } from '../types';
import { ShoppingBag, Heart, ArrowLeft } from 'lucide-react';
import { CerberusLogo } from './CerberusLogo';

interface HeaderProps {
  currentView: ViewMode;
  onSelectView: (view: ViewMode) => void;
  onOpenSettings: () => void;
  productCount: number;
  favoritesCount: number;
  showOnlyFavorites: boolean;
  onToggleShowFavorites: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentView,
  onSelectView,
  onOpenSettings: _onOpenSettings,
  productCount,
  favoritesCount,
  showOnlyFavorites,
  onToggleShowFavorites
}) => {
  const isProductDetail = currentView === 'product-detail';

  // Product pages deliberately use a quieter shell than the catalog. The root
  // marker also lets the shared footer collapse into its compact product-page
  // variant without duplicating footer markup or newsletter state.
  React.useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.classList.toggle('product-detail-view', isProductDetail);
    return () => root.classList.remove('product-detail-view');
  }, [isProductDetail]);

  if (isProductDetail) {
    return (
      <header className="sticky top-0 z-40 w-full min-w-0 max-w-full border-b border-[#3A342E] bg-[#100E0D]/97 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl min-w-0 items-center justify-between gap-2 px-3 sm:h-16 sm:px-6">
          <button
            onClick={() => {
              if (showOnlyFavorites) onToggleShowFavorites();
              onSelectView('catalog');
            }}
            className="group flex min-w-0 items-center gap-2 text-left focus:outline-none"
            aria-label="Voltar ao acervo Cerberus"
          >
            <div className="tech-frame flex h-8 w-8 shrink-0 items-center justify-center border border-[#8A1F1F] bg-[#0B0908] sm:h-9 sm:w-9">
              <CerberusLogo className="h-5 w-5 sm:h-6 sm:w-6" />
            </div>
            <span className="truncate font-gothic text-[15px] uppercase tracking-[0.12em] text-[#E8E1D3] transition-colors group-hover:text-[#8A1F1F] sm:text-lg">
              CERBERUS
            </span>
          </button>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <button
              onClick={() => {
                if (showOnlyFavorites) onToggleShowFavorites();
                onSelectView('catalog');
              }}
              className="flex min-h-9 items-center gap-1.5 border border-[#3A342E] bg-[#0B0908] px-2.5 py-1.5 font-display text-[10px] uppercase tracking-widest text-[#E8E1D3]/80 transition-colors hover:border-[#8A1F1F] hover:text-[#E8E1D3] sm:px-3"
              title="Voltar ao acervo"
            >
              <ArrowLeft className="h-3.5 w-3.5 text-[#8A1F1F]" />
              <span className="hidden min-[360px]:inline">Acervo</span>
            </button>

            <button
              onClick={() => {
                onSelectView('catalog');
                onToggleShowFavorites();
              }}
              className="flex min-h-9 items-center gap-1.5 border border-[#3A342E] bg-[#0B0908] px-2.5 py-1.5 text-[#E8E1D3] transition-colors hover:border-[#8A1F1F] sm:px-3"
              title="Ver peças salvas"
              aria-label={`Ver peças salvas: ${favoritesCount}`}
            >
              <Heart className={`h-3.5 w-3.5 ${favoritesCount > 0 ? 'fill-[#8A1F1F] text-[#8A1F1F]' : 'text-[#E8E1D3]'}`} />
              <span className="font-mono text-[10px] text-[#8A1F1F]">{favoritesCount}</span>
            </button>
          </div>
        </div>
      </header>
    );
  }

  return (
    <header className="sticky top-0 z-40 bg-[#141210]/95 backdrop-blur-md border-b border-[#3A342E] transition-all w-full max-w-full min-w-0">
      <div className="max-w-7xl mx-auto px-2 sm:px-6 h-16 sm:h-20 flex items-center justify-between gap-1 sm:gap-2 min-w-0">
        
        {/* Brand Logo & Official Cerberus Symbol */}
        <button
          onClick={() => {
            if (showOnlyFavorites) onToggleShowFavorites();
            onSelectView('catalog');
          }}
          className="flex min-w-0 flex-1 items-center space-x-2 sm:space-x-3 group text-left focus:outline-none"
          id="brand-logo-btn"
        >
          {/* Official White Cerberus 3-Headed Hound Emblem */}
          <div className="w-10 h-10 sm:w-14 sm:h-14 flex items-center justify-center transition-all duration-300 relative group-hover:scale-105 shrink-0 border border-[#8A1F1F] bg-[#0B0908] tech-frame">
            <CerberusLogo className="w-7 h-7 sm:w-10 sm:h-10" />
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center space-x-1 sm:space-x-2">
              <span className="font-gothic text-[clamp(0.95rem,4.5vw,1.875rem)] text-[#E8E1D3] tracking-wider group-hover:text-[#8A1F1F] transition-colors uppercase leading-none whitespace-nowrap truncate">
                CERBERUS
              </span>
              <span className="stamp-badge max-[359px]:hidden text-[7.5px] sm:text-[9px] px-1 sm:px-1.5 py-0.2 hidden lg:inline-block shrink-0 whitespace-nowrap">
                EDITION 2026
              </span>
            </div>
            <p className="text-[7px] sm:text-[9px] font-display text-[#E8E1D3]/60 uppercase tracking-wider sm:tracking-[0.2em] -mt-0.5 whitespace-nowrap truncate max-w-full">
              CURATORIA ARCHIVAL & DESIGN
            </p>
          </div>
        </button>

        {/* View Switching & Actions Header Navigation */}
        <div className="flex shrink-0 items-center space-x-1 sm:space-x-2">
          
          {/* Catalog / Acervo Tab */}
          <button
            onClick={() => {
              if (showOnlyFavorites) onToggleShowFavorites();
              onSelectView('catalog');
            }}
            id="nav-catalog-btn"
            className={`flex min-h-10 items-center space-x-1 sm:space-x-2 px-2 sm:px-3.5 py-1.5 sm:py-2 rounded-none text-[11px] sm:text-xs font-display uppercase tracking-wider sm:tracking-widest transition-all ${
              currentView === 'catalog' && !showOnlyFavorites
                ? 'bg-[#8A1F1F] text-[#E8E1D3] border border-[#8A1F1F] shadow-sm'
                : 'bg-[#0B0908] text-[#E8E1D3]/80 border border-[#3A342E] hover:border-[#8A1F1F] hover:text-[#E8E1D3]'
            }`}
          >
            <ShoppingBag className="w-3.5 h-3.5 text-[#E8E1D3]" />
            <span className="hidden sm:inline">Acervo</span>
            {productCount > 0 && (
              <span className="text-[10px] font-mono text-[#E8E1D3]/80">
                ({productCount})
              </span>
            )}
          </button>

          {/* Favorites / Salvos Button with Dynamic Count */}
          <button
            onClick={() => {
              onSelectView('catalog');
              onToggleShowFavorites();
            }}
            id="nav-favorites-btn"
            className={`flex min-h-10 items-center space-x-1 sm:space-x-1.5 px-2 sm:px-3 py-1.5 sm:py-2 rounded-none text-[11px] sm:text-xs font-display uppercase tracking-wider sm:tracking-widest transition-all relative ${
              showOnlyFavorites
                ? 'bg-[#8A1F1F] text-[#E8E1D3] border border-[#8A1F1F]'
                : 'bg-[#181512] text-[#E8E1D3] border border-[#3A342E] hover:border-[#8A1F1F]'
            }`}
            title="Ver peças salvas na lista de desejos"
          >
            <Heart className={`w-3.5 h-3.5 ${showOnlyFavorites || favoritesCount > 0 ? 'fill-[#8A1F1F] text-[#8A1F1F]' : 'text-[#E8E1D3]'}`} />
            <span className="hidden sm:inline">Salvos</span>
            <span className={`text-[10px] font-mono px-1 py-0.2 font-bold ${
              showOnlyFavorites ? 'bg-[#0B0908] text-[#E8E1D3]' : 'bg-[#0B0908] text-[#8A1F1F] border border-[#3A342E]'
            }`}>
              {favoritesCount}
            </span>
          </button>

          {/* Admin and Settings buttons removed for public static site */}

        </div>

      </div>
    </header>
  );
};