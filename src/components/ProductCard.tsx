import React, { useState, useRef } from 'react';
// Mobile refinement: keep the approved product-card hierarchy while preventing long content and controls from expanding the card beyond its grid column.
import { Product } from '../types';
import {
  getProductCardDescription,
  getProductCardPricePresentation,
  getProductDisplayTitle,
  getProductMarketplaceLabel,
} from '../lib/productPresentation';
import { trackClickAndGetUrl, trackSelectItem } from '../lib/analytics';
import { ExternalLink, ImageOff, ChevronLeft, ChevronRight, Heart } from 'lucide-react';

interface ProductCardProps {
  product: Product;
  index?: number;
  isFavorite: boolean;
  onToggleFavorite: (id: string) => void;
  onSelectProduct: (product: Product) => void;
  metaPixelId?: string;
  metaAccessToken?: string;
}

export const ProductCard: React.FC<ProductCardProps> = ({
  product,
  index = 0,
  isFavorite,
  onToggleFavorite,
  onSelectProduct,
  metaPixelId,
  metaAccessToken
}) => {
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [imageError, setImageError] = useState<Record<number, boolean>>({});
  const [isRedirecting, setIsRedirecting] = useState(false);

  // Touch Swipe tracking
  const touchStartX = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);

  const images = product.imagens && product.imagens.length > 0
    ? product.imagens
    : ['https://images.unsplash.com/photo-1550684848-fac1c5b4e853?auto=format&fit=crop&w=600&q=80'];

  const hasMultipleImages = images.length > 1;

  // Curatorial Reference Number: "ITEM Nº 001"
  const refNumber = `ITEM Nº ${(index + 1).toString().padStart(3, '0')}`;

  const handleNextImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrentImageIndex((prev) => (prev + 1) % images.length);
  };

  const handlePrevImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrentImageIndex((prev) => (prev - 1 + images.length) % images.length);
  };

  const handleSelectDot = (e: React.MouseEvent, idx: number) => {
    e.stopPropagation();
    setCurrentImageIndex(idx);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.targetTouches[0].clientX;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    touchEndX.current = e.targetTouches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStartX.current || !touchEndX.current) return;
    const distance = touchStartX.current - touchEndX.current;
    if (distance > 30 && hasMultipleImages) {
      e.stopPropagation();
      setCurrentImageIndex((prev) => (prev + 1) % images.length);
    }
    if (distance < -30 && hasMultipleImages) {
      e.stopPropagation();
      setCurrentImageIndex((prev) => (prev - 1 + images.length) % images.length);
    }
    touchStartX.current = null;
    touchEndX.current = null;
  };

  // Direct checkout action button
  const handleBuyClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRedirecting) return;

    setIsRedirecting(true);

    let finalUrl = product.paginaPonteUrl || product.link;
    try {
      finalUrl = await trackClickAndGetUrl(product, metaPixelId, metaAccessToken);
    } catch (err) {
      console.warn('Falha no tracking de clique (redirecionamento mantido):', err);
    }

    setTimeout(() => {
      window.open(finalUrl, '_blank', 'noopener,noreferrer');
      setIsRedirecting(false);
    }, 250);
  };

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleFavorite(product.id);
  };

  const formattedPrice = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(product.preco);
  const pricePresentation = getProductCardPricePresentation(product);
  const formattedCardPrice = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(pricePresentation.mainPrice);
  const displayTitle = getProductDisplayTitle(product);
  const cardDescription = getProductCardDescription(product);
  const marketplaceLabel = getProductMarketplaceLabel(product);
  // Mantido localmente para que o contrato visual da oferta confirmada permaneça explícito no card.
  const priceLabel = pricePresentation.announcementPrice ? 'PREÇO VERIFICADO' : 'PREÇO DO ANÚNCIO';

  return (
    <div
      onClick={() => {
        trackSelectItem(product);
        onSelectProduct(product);
      }}
      id={`product-card-${product.id}`}
      className="group relative bg-[#141210] hover:bg-[#1C1815] border border-[#3A342E] hover:border-[#8A1F1F] rounded-none overflow-hidden flex flex-col transition-all duration-200 cursor-pointer select-none touch-pan-y shadow-md hover:shadow-xl hover:-translate-y-0.5 active:scale-[0.99] motion-reduce:transform-none w-full min-w-0"
    >
      {/* Top Tag Header - Curatorial Archival Registration Badge */}
      <div className="min-w-0 p-1.5 sm:p-2.5 bg-[#0B0908] border-b border-[#3A342E] flex items-center justify-between gap-1 text-[9px] sm:text-[10px] uppercase font-display tracking-widest text-[#E8E1D3]/80">
        <span className="min-w-0 font-mono text-[#8A1F1F] font-bold text-[10px] flex items-center space-x-1 truncate">
          <span className="w-1.5 h-1.5 bg-[#8A1F1F] inline-block mr-1"></span>
          <span>{refNumber}</span>
        </span>

        <div className="flex items-center space-x-1.5">
          {product.destaque && (
            <span className="stamp-badge text-[8px] px-1 py-0 border-[#8A1F1F]">
              LIMITED
            </span>
          )}

          {/* Heart Favorite Button */}
          <button
            onClick={handleFavoriteClick}
            className={`min-h-10 min-w-10 p-1.5 rounded-none border transition-all duration-150 active:scale-95 motion-reduce:transform-none ${
              isFavorite
                ? 'bg-[#8A1F1F] text-[#E8E1D3] border-[#8A1F1F]'
                : 'bg-[#0B0908] text-[#E8E1D3]/60 border-[#3A342E] hover:text-[#E8E1D3] hover:border-[#8A1F1F]'
            }`}
            title={isFavorite ? 'Remover dos Favoritos' : 'Salvar nos Favoritos'}
          >
            <Heart className={`w-3.5 h-3.5 ${isFavorite ? 'fill-[#E8E1D3]' : ''}`} />
          </button>
        </div>
      </div>

      {/* Image Stage */}
      <div
        className="relative w-full aspect-[5/4] sm:aspect-square min-w-0 bg-[#090807] p-1.5 sm:p-2 flex items-center justify-center overflow-hidden border-b border-[#3A342E]"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {!imageError[currentImageIndex] ? (
          <img
            src={images[currentImageIndex]}
            alt={displayTitle}
            onError={() => setImageError(prev => ({ ...prev, [currentImageIndex]: true }))}
            className="w-full h-full object-contain group-hover:scale-105 transition-transform duration-500 ease-out"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-[#E8E1D3]/30 bg-[#0B0908]">
            <ImageOff className="w-6 h-6 mb-1 text-[#8A1F1F]" />
            <span className="text-[9px] uppercase font-display tracking-widest">Sem Imagem</span>
          </div>
        )}

        {/* Multi-Image Navigation Arrows */}
        {hasMultipleImages && (
          <>
            <button
              onClick={handlePrevImage}
              className="absolute left-1 top-1/2 -translate-y-1/2 min-h-10 min-w-10 bg-[#0B0908]/90 border border-[#3A342E] text-[#E8E1D3] hidden sm:flex items-center justify-center sm:opacity-0 group-hover:opacity-100 transition-opacity z-10 hover:bg-[#8A1F1F] hover:border-[#8A1F1F]"
              title="Foto anterior"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleNextImage}
              className="absolute right-1 top-1/2 -translate-y-1/2 min-h-10 min-w-10 bg-[#0B0908]/90 border border-[#3A342E] text-[#E8E1D3] hidden sm:flex items-center justify-center sm:opacity-0 group-hover:opacity-100 transition-opacity z-10 hover:bg-[#8A1F1F] hover:border-[#8A1F1F]"
              title="Próxima foto"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </>
        )}

        {/* Interactive Clickable Navigation Dots */}
        {hasMultipleImages && (
          <div className="absolute bottom-1 left-0 right-0 flex justify-center items-center space-x-1 z-10">
            {images.map((_, idx) => (
              <button
                key={idx}
                onClick={(e) => handleSelectDot(e, idx)}
                className={`min-h-4 min-w-4 transition-all rounded-none ${
                  idx === currentImageIndex
                    ? 'w-3 h-1 bg-[#8A1F1F]'
                    : 'w-1 h-1 bg-[#3A342E] hover:bg-[#E8E1D3]'
                }`}
                title={`Ir para foto ${idx + 1}`}
              />
            ))}
          </div>
        )}

        {/* Redirecting Overlay */}
        {isRedirecting && (
          <div className="absolute inset-0 bg-[#0B0908]/95 backdrop-blur-xs flex items-center justify-center z-20">
            <span className="text-xs font-display uppercase tracking-widest text-[#E8E1D3] flex items-center space-x-1.5 animate-pulse">
              <span>Acessando Loja Parceira...</span>
              <ExternalLink className="w-3.5 h-3.5 text-[#8A1F1F]" />
            </span>
          </div>
        )}
      </div>

      {/* Card Details Body */}
      <div className="min-w-0 p-2 sm:p-3 flex-1 flex flex-col justify-between space-y-2 sm:space-y-2.5 bg-[#141210]">
        <div>
          <p className="text-[8px] sm:text-[9px] uppercase font-display tracking-widest text-[#8A1F1F] mb-0.5 font-bold">
            {marketplaceLabel}
          </p>
          <h3 title={displayTitle} className="h-[2.4rem] sm:h-[2.7rem] font-display text-[11px] sm:text-sm uppercase font-bold text-[#E8E1D3] group-hover:text-[#8A1F1F] line-clamp-2 leading-[1.3] sm:leading-[1.35] tracking-wide break-words overflow-hidden">
            {displayTitle}
          </h3>
          {cardDescription && (
            <p className="mt-1 text-[9px] sm:text-[10px] leading-snug text-[#E8E1D3]/55 line-clamp-2 break-words">
              {cardDescription}
            </p>
          )}
        </div>

        {/* Footer: Price & Direct Acquire Button */}
        <div className="pt-1.5 sm:pt-2 border-t border-[#3A342E] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 sm:gap-2 min-w-0">
          <div className="flex-1 min-w-0">
            <div className="space-y-0.5">
              <span className={`text-[8px] uppercase font-display tracking-widest block ${
                pricePresentation.announcementPrice ? 'text-[#D7A64B]' : 'text-[#E8E1D3]/60'
              }`}>
                {priceLabel}
              </span>
              <span className={`font-mono font-bold text-[13px] sm:text-base leading-tight break-words ${
                pricePresentation.announcementPrice ? 'text-[#D7A64B]' : 'text-[#E8E1D3]'
              }`}>
                {formattedCardPrice} {pricePresentation.condition}
              </span>
              {pricePresentation.announcementPrice && (
                <>
                  <span className="text-[9px] font-mono text-[#E8E1D3]/60 block">Preço do anúncio: {formattedPrice}</span>
                  <p className="text-[8px] leading-snug text-[#E8E1D3]/50">Preço verificado pela nossa curadoria. Condições finais de pagamento e frete são confirmadas na loja oficial.</p>
                </>
              )}
            </div>
          </div>

          <button
            onClick={handleBuyClick}
            className="min-h-9 sm:min-h-10 w-full sm:w-auto shrink-0 px-2 sm:px-2.5 py-1 bg-[#0B0908] border border-[#3A342E] hover:border-[#8A1F1F] hover:bg-[#8A1F1F] active:scale-[0.98] motion-reduce:transform-none text-[9px] sm:text-[10px] font-display uppercase tracking-wider flex items-center justify-center space-x-1 transition-all duration-150 rounded-none"
          >
            <span>ADQUIRIR</span>
            <ExternalLink className="w-3 h-3 text-[#8A1F1F] group-hover:text-[#E8E1D3]" />
          </button>
        </div>
      </div>
    </div>
  );
};
