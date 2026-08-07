import React from 'react';
import { ViewMode } from '../types';
import { ShoppingBag, Heart, Settings, BookOpen, ShieldCheck } from 'lucide-react';
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
  onOpenSettings,
  productCount,
  favoritesCount,
  showOnlyFavorites,
  onToggleShowFavorites
}) => {
  return (
    <header className="sticky top-0 z-40 bg-[#141210]/95 backdrop-blur-md border-b border-[#3A342E] transition-all w-full max-w-full overflow-hidden">
      <div className="max-w-7xl mx-auto px-2.5 sm:px-6 h-16 sm:h-20 flex items-center justify-between gap-1.5 sm:gap-2 min-w-0">
        
        {/* Brand Logo & Official Cerberus Symbol */}
        <button
          onClick={() => {
            if (showOnlyFavorites) onToggleShowFavorites();
            onSelectView('catalog');
          }}
          className="flex items-center space-x-2 sm:space-x-3.5 group text-left focus:outline-none min-w-0 shrink"
          id="brand-logo-btn"
        >
          {/* Official White Cerberus 3-Headed Hound Emblem */}
          <div className="w-8 h-8 sm:w-11 sm:h-11 border border-[#8A1F1F] bg-[#0B0908] flex items-center justify-center group-hover:border-[#E8E1D3] transition-all duration-300 relative tech-frame group-hover:scale-105 shrink-0">
            <CerberusLogo className="w-5 h-5 sm:w-7 sm:h-7 transition-transform duration-300 group-hover:rotate-3" />
            <span className="absolute -top-1 -right-1 w-1.5 h-1.5 bg-[#8A1F1F]"></span>
          </div>

          <div className="flex flex-col min-w-0">
            <div className="flex items-center space-x-1 sm:space-x-2">
              <span className="font-gothic text-xl sm:text-3xl text-[#E8E1D3] tracking-wide group-hover:text-[#8A1F1F] transition-colors uppercase leading-none truncate">
                CERBERUS
              </span>
              <span className="stamp-badge text-[7.5px] sm:text-[9px] px-1 sm:px-1.5 py-0.2 hidden sm:inline-block">
                EDITION 2026
              </span>
            </div>
            <p className="text-[7.5px] sm:text-[9px] font-display text-[#E8E1D3]/60 uppercase tracking-wider sm:tracking-[0.22em] -mt-0.5 truncate">
              CURATORIA ARCHIVAL & DESIGN
            </p>
          </div>
        </button>

        {/* View Switching & Actions Header Navigation */}
        <div className="flex items-center space-x-1 sm:space-x-2 shrink-0">
          
          {/* Catalog / Acervo Tab */}
          <button
            onClick={() => {
              if (showOnlyFavorites) onToggleShowFavorites();
              onSelectView('catalog');
            }}
            id="nav-catalog-btn"
            className={`flex items-center space-x-1 sm:space-x-2 px-2 sm:px-3.5 py-1.5 sm:py-2 rounded-none text-[11px] sm:text-xs font-display uppercase tracking-wider sm:tracking-widest transition-all ${
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
            className={`flex items-center space-x-1 sm:space-x-1.5 px-2 sm:px-3 py-1.5 sm:py-2 rounded-none text-[11px] sm:text-xs font-display uppercase tracking-wider sm:tracking-widest transition-all relative ${
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

          {/* Admin Button */}
          <button
            onClick={() => onSelectView('admin')}
            id="nav-admin-btn"
            title="Painel Administrativo (Cadastro de Produtos)"
            className={`flex items-center space-x-1 px-2 sm:px-3 py-1.5 sm:py-2 rounded-none text-[11px] sm:text-xs font-display uppercase tracking-wider sm:tracking-widest transition-all ${
              currentView === 'admin'
                ? 'bg-[#8A1F1F] text-[#E8E1D3] border border-[#8A1F1F]'
                : 'bg-[#0B0908] text-[#E8E1D3]/80 border border-[#3A342E] hover:border-[#8A1F1F] hover:text-[#E8E1D3]'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5 text-[#8A1F1F]" />
            <span className="hidden md:inline">Painel Admin</span>
          </button>

          {/* Guide */}
          <button
            onClick={() => onSelectView('guide')}
            id="nav-guide-btn"
            title="Guia do Sistema"
            className={`p-1.5 sm:p-2 rounded-none text-[#E8E1D3]/70 hover:text-[#E8E1D3] bg-[#0B0908] border border-[#3A342E] hover:border-[#8A1F1F] transition-all ${
              currentView === 'guide' ? 'border-[#8A1F1F] text-[#E8E1D3] bg-[#181512]' : ''
            }`}
          >
            <BookOpen className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-[#8A1F1F]" />
          </button>

          {/* Settings Modal Trigger */}
          <button
            onClick={onOpenSettings}
            id="nav-settings-btn"
            title="Configurações (Pixels & Feeds)"
            className="p-1.5 sm:p-2 rounded-none text-[#E8E1D3]/70 hover:text-[#E8E1D3] bg-[#0B0908] border border-[#3A342E] hover:border-[#8A1F1F] transition-all"
          >
            <Settings className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-[#8A1F1F]" />
          </button>

        </div>

      </div>
    </header>
  );
};
