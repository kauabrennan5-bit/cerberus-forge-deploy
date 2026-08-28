import React, { useState } from 'react';
import { Product } from '../types';
import {
  getProductCardDescription,
  getProductCardPricePresentation,
  getProductDisplayTitle,
  getProductMarketplaceLabel,
} from '../lib/productPresentation';
import { trackClickAndGetUrl, trackSelectItem } from '../lib/analytics';
import { resolveCanonicalProductImage } from '../lib/productCanonical';
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
  metaAccessToken,
}) => {
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [imageError, setImageError] = useState<Record<number, boolean>>({});
  const [isRedirecting, setIsRedirecting] = useState(false);

  const images = resolveCanonicalProductImage(product).publicHttpsImageUrls;
  const hasMultipleImages = images.length > 1;
  const refNumber = `ITEM Nº ${(index + 1).toString().padStart(3, '0')}`;
  const productHref = `/produto/${encodeURIComponent(product.slug || product.id)}`;

  const handleProductLinkClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    trackSelectItem(product);
    onSelectProduct(product);
  };

  const handleNextImage = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!images.length) return;
    setCurrentImageIndex((prev) => (prev + 1) % images.length);
  };

  const handlePrevImage = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!images.length) return;
    setCurrentImageIndex((prev) => (prev - 1 + images.length) % images.length);
  };

  const handleSelectDot = (event: React.MouseEvent, idx: number) => {
    event.preventDefault();
    event.stopPropagation();
    setCurrentImageIndex(idx);
  };

  const handleBuyClick = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
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

  const handleFavoriteClick = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onToggleFavorite(product.id);
  };

  const formattedPrice = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(product.preco);
  const pricePresentation = getProductCardPricePresentation(product);
  const formattedCardPrice = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(pricePresentation.mainPrice);
  const displayTitle = getProductDisplayTitle(product);
  const cardDescription = getProductCardDescription(product);
  const marketplaceLabel = getProductMarketplaceLabel(product);
  const priceLabel = pricePresentation.announcementPrice ? 'PREÇO VERIFICADO' : 'PREÇO DO ANÚNCIO';

  return (
    <article
      id={`product-card-${product.id}`}
      data-testid="product-card"
      data-product-id={product.id}
      className="group relative isolate h-full w-full min-w-0 overflow-hidden border border-[#3A342E] bg-[#141210] shadow-md transition-all duration-200 hover:-translate-y-0.5 hover:border-[#8A1F1F] hover:bg-[#1C1815] hover:shadow-xl focus-within:border-[#8A1F1F] motion-reduce:transform-none"
    >
      {/* Native stretched link: the browser owns tap-vs-pan arbitration. */}
      <a
        href={productHref}
        onClick={handleProductLinkClick}
        aria-label={`Abrir ${displayTitle}`}
        data-testid="product-card-link"
        className="absolute inset-0 z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#D7A64B]"
      >
        <span className="sr-only">Abrir {displayTitle}</span>
      </a>

      <div className="relative z-0 flex h-full min-w-0 flex-col">
        <div className="flex min-h-[3.25rem] min-w-0 items-center justify-between gap-1 border-b border-[#3A342E] bg-[#0B0908] p-1.5 text-[9px] uppercase tracking-widest text-[#E8E1D3]/80 sm:p-2.5 sm:text-[10px]">
          <span className="flex min-w-0 items-center space-x-1 truncate font-mono text-[10px] font-bold text-[#8A1F1F]">
            <span className="mr-1 inline-block h-1.5 w-1.5 shrink-0 bg-[#8A1F1F]" />
            <span>{refNumber}</span>
          </span>

          <div className="relative z-20 flex items-center space-x-1.5">
            {product.destaque && (
              <span className="stamp-badge text-[8px] px-1 py-0 border-[#8A1F1F]">LIMITED</span>
            )}
            <button
              type="button"
              onClick={handleFavoriteClick}
              aria-label={isFavorite ? 'Remover dos Favoritos' : 'Salvar nos Favoritos'}
              className={`min-h-10 min-w-10 rounded-none border p-1.5 transition-all duration-150 active:scale-95 motion-reduce:transform-none ${
                isFavorite
                  ? 'border-[#8A1F1F] bg-[#8A1F1F] text-[#E8E1D3]'
                  : 'border-[#3A342E] bg-[#0B0908] text-[#E8E1D3]/60 hover:border-[#8A1F1F] hover:text-[#E8E1D3]'
              }`}
              title={isFavorite ? 'Remover dos Favoritos' : 'Salvar nos Favoritos'}
            >
              <Heart className={`h-3.5 w-3.5 ${isFavorite ? 'fill-[#E8E1D3]' : ''}`} />
            </button>
          </div>
        </div>

        {/* Aspect ratio reserves layout before external images finish loading. */}
        <div className="relative aspect-[5/4] w-full min-w-0 overflow-hidden border-b border-[#3A342E] bg-[#090807] p-1.5 sm:aspect-square sm:p-2">
          <div className="flex h-full w-full items-center justify-center">
            {images.length > 0 && !imageError[currentImageIndex] ? (
              <img
                src={images[currentImageIndex]}
                alt={displayTitle}
                onError={() => setImageError((prev) => ({ ...prev, [currentImageIndex]: true }))}
                className="h-full w-full object-contain transition-transform duration-500 ease-out group-hover:scale-105"
                loading="lazy"
                decoding="async"
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center bg-[#0B0908] text-[#E8E1D3]/30">
                <ImageOff className="mb-1 h-6 w-6 text-[#8A1F1F]" />
                <span className="text-[9px] uppercase tracking-widest">Sem Imagem</span>
              </div>
            )}
          </div>

          {hasMultipleImages && (
            <>
              <button
                type="button"
                onClick={handlePrevImage}
                className="absolute left-1 top-1/2 z-20 flex min-h-9 min-w-9 -translate-y-1/2 items-center justify-center border border-[#3A342E] bg-[#0B0908]/90 text-[#E8E1D3] opacity-90 transition-opacity hover:border-[#8A1F1F] hover:bg-[#8A1F1F] sm:min-h-10 sm:min-w-10 sm:opacity-0 sm:group-hover:opacity-100"
                title="Foto anterior"
                aria-label="Foto anterior"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={handleNextImage}
                className="absolute right-1 top-1/2 z-20 flex min-h-9 min-w-9 -translate-y-1/2 items-center justify-center border border-[#3A342E] bg-[#0B0908]/90 text-[#E8E1D3] opacity-90 transition-opacity hover:border-[#8A1F1F] hover:bg-[#8A1F1F] sm:min-h-10 sm:min-w-10 sm:opacity-0 sm:group-hover:opacity-100"
                title="Próxima foto"
                aria-label="Próxima foto"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </>
          )}

          {hasMultipleImages && (
            <div className="absolute bottom-0.5 left-0 right-0 z-20 flex items-center justify-center gap-0.5">
              {images.map((_, idx) => (
                <button
                  type="button"
                  key={idx}
                  onClick={(event) => handleSelectDot(event, idx)}
                  aria-label={`Ir para foto ${idx + 1}`}
                  aria-current={idx === currentImageIndex ? 'true' : undefined}
                  className="flex min-h-7 min-w-7 items-center justify-center"
                >
                  <span className={`block h-1 transition-all ${idx === currentImageIndex ? 'w-3 bg-[#8A1F1F]' : 'w-1 bg-[#3A342E]'}`} />
                </button>
              ))}
            </div>
          )}

          {isRedirecting && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#0B0908]/95 backdrop-blur-xs">
              <span className="flex items-center space-x-1.5 text-xs uppercase tracking-widest text-[#E8E1D3] animate-pulse">
                <span>Acessando Loja Parceira...</span>
                <ExternalLink className="h-3.5 w-3.5 text-[#8A1F1F]" />
              </span>
            </div>
          )}
        </div>

        {/* Fixed semantic slots keep every card's structure predictable. */}
        <div className="flex min-w-0 flex-1 flex-col bg-[#141210] p-2 sm:p-3">
          <div className="min-w-0">
            <p className="mb-0.5 h-3 truncate text-[8px] font-bold uppercase tracking-widest text-[#8A1F1F] sm:text-[9px]">
              {marketplaceLabel}
            </p>
            <h3
              title={displayTitle}
              className="h-[2.4rem] overflow-hidden break-words text-[11px] font-bold uppercase leading-[1.3] tracking-wide text-[#E8E1D3] line-clamp-2 group-hover:text-[#8A1F1F] sm:h-[2.7rem] sm:text-sm sm:leading-[1.35]"
            >
              {displayTitle}
            </h3>
            <p
              className={`mt-1 h-[2.25rem] overflow-hidden break-words text-[9px] leading-snug text-[#E8E1D3]/55 line-clamp-2 sm:h-[2.5rem] sm:text-[10px] ${cardDescription ? '' : 'invisible'}`}
              aria-hidden={!cardDescription}
            >
              {cardDescription || 'Sem descrição editorial para exibição no card.'}
            </p>
          </div>

          <div className="mt-2 border-t border-[#3A342E] pt-1.5 sm:pt-2">
            <div className="h-[3.55rem] min-w-0 sm:h-[3.8rem]">
              <span className={`block h-3 truncate text-[8px] uppercase tracking-widest ${pricePresentation.announcementPrice ? 'text-[#D7A64B]' : 'text-[#E8E1D3]/60'}`}>
                {priceLabel}
              </span>
              <span className={`block h-[1.35rem] truncate font-mono text-[13px] font-bold leading-tight sm:h-[1.55rem] sm:text-base ${pricePresentation.announcementPrice ? 'text-[#D7A64B]' : 'text-[#E8E1D3]'}`}>
                {formattedCardPrice}{pricePresentation.condition ? ` ${pricePresentation.condition}` : ''}
              </span>
              <span className={`block h-[1.15rem] truncate font-mono text-[8px] leading-[1.15rem] text-[#E8E1D3]/55 sm:text-[9px] ${pricePresentation.announcementPrice ? '' : 'invisible'}`} aria-hidden={!pricePresentation.announcementPrice}>
                {pricePresentation.announcementPrice ? `Preço do anúncio: ${formattedPrice}` : 'Preço do anúncio'}
              </span>
            </div>

            <button
              type="button"
              onClick={handleBuyClick}
              className="relative z-20 mt-1.5 flex min-h-10 w-full items-center justify-center space-x-1 rounded-none border border-[#3A342E] bg-[#0B0908] px-2 py-1 text-[9px] uppercase tracking-wider transition-all duration-150 hover:border-[#8A1F1F] hover:bg-[#8A1F1F] active:scale-[0.98] motion-reduce:transform-none sm:text-[10px]"
            >
              <span>ADQUIRIR</span>
              <ExternalLink className="h-3 w-3 text-[#8A1F1F] group-hover:text-[#E8E1D3]" />
            </button>
          </div>
        </div>
      </div>
    </article>
  );
};
