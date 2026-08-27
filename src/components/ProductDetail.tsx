import React, { useEffect, useState, useRef } from 'react';
// Mobile refinement: keep the approved product-detail composition while constraining gallery, metadata, actions, and lightbox content to the viewport.
import { Product } from '../types';
import { getProductDisplayCategory, getProductDisplayTitle } from '../lib/productPresentation';
import { resolveCanonicalProductImage } from '../lib/productCanonical';
import { trackClickAndGetUrl } from '../lib/analytics';
import { ArrowLeft, ExternalLink, Heart, Share2, Check, ChevronLeft, ChevronRight, ImageOff, ShieldCheck, Maximize2, X } from 'lucide-react';
import { ProductCard } from './ProductCard';

interface ProductDetailProps {
  product: Product;
  index?: number;
  isFavorite: boolean;
  favoriteIds: string[];
  onToggleFavorite: (id: string) => void;
  onBack: () => void;
  relatedProducts: Product[];
  onSelectProduct: (product: Product) => void;
  metaPixelId?: string;
  metaAccessToken?: string;
}

export const ProductDetail: React.FC<ProductDetailProps> = ({
  product,
  index = 0,
  isFavorite,
  favoriteIds,
  onToggleFavorite,
  onBack,
  relatedProducts,
  onSelectProduct,
  metaPixelId,
  metaAccessToken
}) => {
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [imageError, setImageError] = useState<Record<number, boolean>>({});
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [isZoomOpen, setIsZoomOpen] = useState(false);

  // Touch Swipe tracking
  const touchStartX = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);
  const relatedRailRef = useRef<HTMLDivElement>(null);
  const relatedTouchStart = useRef<{ x: number; y: number; scrollLeft: number } | null>(null);

  const handleRelatedTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch || !relatedRailRef.current) return;
    relatedTouchStart.current = {
      x: touch.clientX,
      y: touch.clientY,
      scrollLeft: relatedRailRef.current.scrollLeft,
    };
  };

  const handleRelatedTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const start = relatedTouchStart.current;
    const touch = event.touches[0];
    const rail = relatedRailRef.current;
    if (!start || !touch || !rail) return;

    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (Math.abs(deltaX) <= Math.abs(deltaY) || Math.abs(deltaX) < 4) return;

    if (event.cancelable) event.preventDefault();
    rail.scrollLeft = start.scrollLeft - deltaX;
  };

  const clearRelatedTouch = () => {
    relatedTouchStart.current = null;
  };

  const scrollRelatedProducts = (direction: number) => {
    relatedRailRef.current?.scrollBy({
      left: direction * Math.max(240, relatedRailRef.current.clientWidth * 0.82),
      behavior: 'smooth',
    });
  };

  const images = resolveCanonicalProductImage(product).publicHttpsImageUrls
    .filter((_, idx) => !imageError[idx]);

  const hasMultipleImages = images.length > 1;

  const refNumber = `ITEM Nº ${(index + 1).toString().padStart(3, '0')}`;

  const formattedPrice = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(product.preco);
  const formattedPromotionPrice = product.ofertaPromocional
    ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(product.ofertaPromocional.price)
    : null;
  const promotionCondition = product.ofertaPromocional?.condition === 'pix'
    ? 'no Pix'
    : product.ofertaPromocional?.condition === 'pix_with_coupon'
      ? 'no Pix com cupom'
      : product.ofertaPromocional?.condition === 'coupon'
        ? 'com cupom'
        : 'sob condição observada';
  const visiblePromotionBenefits = (product.ofertaPromocional?.benefits ?? []).filter((benefit) => {
    const normalized = benefit.replace(/\s+/g, ' ').trim();
    return normalized.length >= 8 && /\s/.test(normalized);
  });
  const displayTitle = getProductDisplayTitle(product);
  const displayCategory = getProductDisplayCategory(product);

  useEffect(() => {
    setSelectedImageIndex(0);
    setImageError({});
    setIsZoomOpen(false);
  }, [product.id]);

  const handleNextImage = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (images.length <= 1) return;
    setSelectedImageIndex((prev) => (prev + 1) % images.length);
  };

  const handlePrevImage = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (images.length <= 1) return;
    setSelectedImageIndex((prev) => (prev - 1 + images.length) % images.length);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.targetTouches[0].clientX;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    touchEndX.current = e.targetTouches[0].clientX;
  };

  const handleTouchEnd = () => {
    if (!touchStartX.current || !touchEndX.current) return;
    const distance = touchStartX.current - touchEndX.current;
    if (distance > 30 && hasMultipleImages) {
      setSelectedImageIndex((prev) => (prev + 1) % images.length);
    }
    if (distance < -30 && hasMultipleImages) {
      setSelectedImageIndex((prev) => (prev - 1 + images.length) % images.length);
    }
    touchStartX.current = null;
    touchEndX.current = null;
  };

  const handleBuy = async () => {
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

  const handleShare = () => {
    const slug = product.slug || product.id;
    const directUrl = `${window.location.origin}/produto/${slug}`;

    if (navigator.clipboard) {
      navigator.clipboard.writeText(directUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    }
  };

  return (
    <div className="max-w-5xl mx-auto py-2 sm:py-6 space-y-3 sm:space-y-5 font-sans animate-fade-in w-full max-w-full min-w-0">
      
      {/* Top Navigation & Action Bar */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-[#3A342E] pb-2 sm:pb-4">
        <button
          onClick={onBack}
          className="min-h-10 flex items-center space-x-2 text-xs font-display uppercase tracking-widest text-[#E8E1D3]/80 hover:text-[#8A1F1F] transition-colors"
        >
          <ArrowLeft className="w-4 h-4 text-[#8A1F1F]" />
          <span>Voltar ao Acervo</span>
        </button>

        <div className="flex items-center gap-2 sm:gap-3">
          <button
            onClick={handleShare}
            className="min-h-10 flex items-center space-x-1.5 px-2.5 sm:px-3 py-1.5 bg-[#141210] border border-[#3A342E] hover:border-[#8A1F1F] rounded-none text-xs font-display uppercase tracking-widest text-[#E8E1D3] transition-colors"
            title="Copiar link direto do produto"
          >
            {copiedLink ? (
              <>
                <Check className="w-3.5 h-3.5 text-[#8A1F1F]" />
                <span className="text-[#8A1F1F]">Link Copiado</span>
              </>
            ) : (
              <>
                <Share2 className="w-3.5 h-3.5 text-[#8A1F1F]" />
                <span className="hidden sm:inline">Compartilhar</span>
              </>
            )}
          </button>

          <button
            onClick={() => onToggleFavorite(product.id)}
            className={`min-h-10 min-w-10 p-1.5 sm:p-2 rounded-none border transition-all ${
              isFavorite
                ? 'bg-[#8A1F1F] text-[#E8E1D3] border-[#8A1F1F]'
                : 'bg-[#141210] text-[#E8E1D3]/70 border-[#3A342E] hover:border-[#8A1F1F]'
            }`}
            title={isFavorite ? 'Remover dos Favoritos' : 'Salvar nos Favoritos'}
          >
            <Heart className={`w-4 h-4 ${isFavorite ? 'fill-[#E8E1D3]' : ''}`} />
          </button>
        </div>
      </div>

      {/* Main Product Layout Grid - Mobile optimized to fit above the fold */}
      <div className="grid min-w-0 grid-cols-1 md:grid-cols-2 gap-3 sm:gap-6 lg:gap-10 items-start">
        
        {/* Left: Interactive Image Gallery - Max ~35vh on mobile */}
        <div className="min-w-0 space-y-2 sm:space-y-4">
          <div
            className="relative w-full h-[32vh] max-h-[260px] sm:h-auto sm:max-h-none sm:aspect-square bg-[#090807] border border-[#3A342E] rounded-none overflow-hidden flex items-center justify-center p-2 sm:p-4 touch-pan-y tech-frame group cursor-pointer"
            onClick={() => setIsZoomOpen(true)}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            {images.length > 0 ? (
              <img
                src={images[selectedImageIndex]}
                alt={displayTitle}
                onError={() => setImageError((prev) => ({ ...prev, [selectedImageIndex]: true }))}
                className="w-full h-full object-contain transition-transform duration-300 ease-out group-hover:scale-105"
              />
            ) : (
              <div className="flex flex-col items-center justify-center text-[#E8E1D3]/30">
                <ImageOff className="w-8 h-8 mb-1 text-[#8A1F1F]" />
                <span className="text-[10px] font-display uppercase tracking-widest">Sem Imagem</span>
              </div>
            )}

            {/* Next/Prev Navigation Arrows */}
            {images.length > 1 && (
              <>
                <button
                  onClick={handlePrevImage}
                  className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 bg-[#0B0908]/90 border border-[#3A342E] text-[#E8E1D3] hover:bg-[#8A1F1F] hover:border-[#8A1F1F] transition-colors rounded-none z-10"
                  title="Imagem anterior"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={handleNextImage}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 bg-[#0B0908]/90 border border-[#3A342E] text-[#E8E1D3] hover:bg-[#8A1F1F] hover:border-[#8A1F1F] transition-colors rounded-none z-10"
                  title="Próxima imagem"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </>
            )}

            {/* Lightbox Zoom Icon Pill */}
            {images.length > 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setIsZoomOpen(true);
                }}
                className="absolute top-2 right-2 p-1.5 bg-[#0B0908]/90 border border-[#3A342E] text-[#E8E1D3] hover:border-[#8A1F1F] hover:text-[#8A1F1F] transition-colors z-10"
                title="Ampliar em tela cheia (Lightbox)"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            )}

            {/* Pagination dots */}
            {hasMultipleImages && (
              <div className="absolute bottom-2 left-0 right-0 flex justify-center items-center space-x-1.5 z-10">
                {images.map((_, idx) => (
                  <button
                    key={idx}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedImageIndex(idx);
                    }}
                    className={`transition-all rounded-none ${
                      idx === selectedImageIndex
                        ? 'w-3.5 h-1 bg-[#8A1F1F]'
                        : 'w-1 h-1 bg-[#3A342E] hover:bg-[#E8E1D3]'
                    }`}
                  />
                ))}
              </div>
            )}

            {/* Reference Badge */}
            <div className="absolute top-2 left-2 bg-[#0B0908] border border-[#3A342E] px-2 py-0.5 text-[9px] font-mono text-[#8A1F1F]">
              {refNumber}
            </div>
          </div>

          {/* Gallery Thumbnails */}
          {images.length > 1 && (
            <div className="flex max-w-full flex-wrap gap-2 pb-1">
              {images.map((img, idx) => (
                <button
                  key={idx}
                  onClick={() => setSelectedImageIndex(idx)}
                  className={`w-11 h-11 sm:w-16 sm:h-16 shrink-0 border rounded-none overflow-hidden p-0.5 bg-[#090807] transition-all ${
                    idx === selectedImageIndex
                      ? 'border-[#8A1F1F] ring-1 ring-[#8A1F1F]'
                      : 'border-[#3A342E] opacity-60 hover:opacity-100'
                  }`}
                >
                  <img src={img} alt="Thumbnail" className="w-full h-full object-contain" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right Column: Title, Price, Buy Button Immediately Above fold */}
        <div className="min-w-0 space-y-3 sm:space-y-4 flex flex-col justify-between">
          <div className="space-y-2 sm:space-y-3">
            <div className="flex min-w-0 items-center justify-between gap-2 border-b border-[#3A342E] pb-1.5">
              <span className="text-[10px] sm:text-xs uppercase font-display tracking-widest text-[#8A1F1F] font-bold">
                {displayCategory || 'PEÇA CURADA'}
              </span>
            </div>

            <h1 className="font-gothic text-2xl sm:text-4xl font-normal text-[#E8E1D3] leading-tight break-words">
              {displayTitle}
            </h1>

            {formattedPromotionPrice && (
              <div className="border-l-2 border-[#D7A64B] bg-[#D7A64B]/10 px-3 py-2 text-xs text-[#E8E1D3]">
                <p className="font-display text-[10px] uppercase tracking-widest text-[#D7A64B]">PREÇO VERIFICADO</p>
                <p className="mt-0.5 font-mono font-bold text-2xl sm:text-3xl text-[#D7A64B]">{formattedPromotionPrice} {promotionCondition}</p>
                <p className="mt-1 text-[10px] font-mono text-[#E8E1D3]/65">Preço do anúncio: {formattedPrice}</p>
                <p className="mt-1 text-[10px] leading-snug text-[#E8E1D3]/70">Preço verificado pela nossa curadoria. Condições finais de pagamento e frete são confirmadas na loja oficial.</p>
                {visiblePromotionBenefits.length ? (
                  <ul className="mt-1 list-disc pl-4 text-[10px] text-[#E8E1D3]/80">
                    {visiblePromotionBenefits.map((benefit) => <li key={benefit}>{benefit.replace(/\s+/g, ' ').trim()}</li>)}
                  </ul>
                ) : null}
              </div>
            )}

            {/* Primary Action Button - Prominent & Above the Fold on Mobile */}
            <div className="pt-1 pb-1">
              <button
                onClick={handleBuy}
                disabled={isRedirecting}
                className="min-h-12 w-full py-3 sm:py-4 bg-[#8A1F1F] hover:bg-[#8A1F1F]/80 active:scale-[0.99] motion-reduce:transform-none text-[#E8E1D3] font-display text-xs sm:text-base uppercase tracking-widest flex items-center justify-center space-x-2 rounded-none transition-all duration-150 border border-[#8A1F1F] shadow-lg"
              >
                {isRedirecting ? (
                  <span>REDIRECIONANDO...</span>
                ) : (
                  <>
                    <span>ADQUIRIR PEÇA OFICIAL</span>
                    <ExternalLink className="w-4 h-4 text-[#E8E1D3]" />
                  </>
                )}
              </button>
              <p className="text-[9px] text-center uppercase font-mono tracking-widest text-[#E8E1D3]/50 mt-1.5">
                Redirecionamento Seguro para Loja Oficial
              </p>
            </div>

            {/* Description & Specifications */}
            {product.descricao && (
              <div className="pt-2 sm:pt-3 border-t border-[#3A342E] text-xs text-[#E8E1D3]/80 leading-relaxed space-y-1.5">
                <span className="text-[9px] sm:text-[10px] uppercase font-display tracking-widest text-[#8A1F1F] block font-bold">
                  ESPECIFICAÇÕES DA PEÇA
                </span>
                <p className="font-condensed text-xs sm:text-sm text-[#E8E1D3]">
                  {product.descricao}
                </p>
              </div>
            )}

            {product.curatorNote?.trim() && (
              <div className="border-l border-[#8A1F1F] pl-3 text-xs text-[#E8E1D3]/80 leading-relaxed space-y-1.5">
                <span className="text-[9px] sm:text-[10px] uppercase font-display tracking-widest text-[#8A1F1F] block font-bold">
                  NOTA DO CURADOR
                </span>
                <p className="font-condensed text-xs sm:text-sm text-[#E8E1D3]">
                  {product.curatorNote.trim()}
                </p>
              </div>
            )}

            <div className="p-2.5 sm:p-3 bg-[#141210] border border-[#3A342E] rounded-none space-y-1.5 text-xs text-[#E8E1D3]/70">
              <div className="flex items-center space-x-2 font-display uppercase tracking-wider text-[#E8E1D3]">
                <ShieldCheck className="w-3.5 h-3.5 text-[#8A1F1F]" />
                <span className="text-[11px] sm:text-xs">AUTENTICIDADE & COMPRA SEGURA</span>
              </div>
              <p className="text-[10px] sm:text-[11px] font-condensed leading-normal text-[#E8E1D3]/70">
                Esta peça pertence ao acervo curado da Cerberus. Ao clicar em adquirir, você é direcionado à loja parceira oficial com rastreamento verificado.
              </p>
            </div>

          </div>
        </div>

      </div>

      {relatedProducts.length > 0 && (
        <section aria-labelledby="related-products-title" className="border-t border-[#3A342E] pt-5 sm:pt-7 animate-fade-in">
          <div className="mb-3 flex min-w-0 flex-col gap-2 sm:mb-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <p className="text-[9px] font-display uppercase tracking-[0.22em] text-[#8A1F1F]">Da mesma curadoria</p>
              <h2 id="related-products-title" className="mt-1 font-gothic text-2xl leading-tight text-[#E8E1D3] sm:text-3xl">Você também pode gostar</h2>
            </div>
            <span className="shrink-0 text-[9px] font-display uppercase tracking-widest text-[#E8E1D3]/45">Deslize para explorar</span>
          </div>

          <div className="relative min-w-0">
            <button
              type="button"
              onClick={() => scrollRelatedProducts(-1)}
              className="absolute left-1 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center border border-[#3A342E] bg-[#0B0908]/95 text-[#E8E1D3] shadow-lg transition-colors hover:border-[#8A1F1F] hover:bg-[#8A1F1F] focus:outline-none focus:ring-1 focus:ring-[#D7A64B] md:hidden"
              aria-label="Ver recomendação anterior"
              title="Recomendação anterior"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => scrollRelatedProducts(1)}
              className="absolute right-1 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center border border-[#3A342E] bg-[#0B0908]/95 text-[#E8E1D3] shadow-lg transition-colors hover:border-[#8A1F1F] hover:bg-[#8A1F1F] focus:outline-none focus:ring-1 focus:ring-[#D7A64B] md:hidden"
              aria-label="Ver próxima recomendação"
              title="Próxima recomendação"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <div
              ref={relatedRailRef}
              role="region"
              aria-labelledby="related-products-title"
              aria-label="Produtos recomendados; deslize horizontalmente para navegar"
              tabIndex={0}
              onTouchStart={handleRelatedTouchStart}
              onTouchMove={handleRelatedTouchMove}
              onTouchEnd={clearRelatedTouch}
              onTouchCancel={clearRelatedTouch}
              className="flex min-w-0 touch-pan-x snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain scroll-smooth pb-2 pr-1 outline-none [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:grid md:grid-cols-3 md:gap-3 md:overflow-visible md:pr-0 lg:grid-cols-4"
            >
              {relatedProducts.map((related, relatedIndex) => (
                <div key={related.id} className="w-[calc(100vw-2.75rem)] max-w-[18rem] shrink-0 snap-start sm:w-[76vw] sm:max-w-[17rem] md:w-auto md:max-w-none md:min-w-0">
                  <ProductCard
                    product={related}
                    index={related.rawRowIndex ?? relatedIndex}
                    isFavorite={favoriteIds.includes(related.id)}
                    onToggleFavorite={onToggleFavorite}
                    onSelectProduct={onSelectProduct}
                    metaPixelId={metaPixelId}
                    metaAccessToken={metaAccessToken}
                  />
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Lightbox / Fullscreen Zoom Modal */}
      {isZoomOpen && images[selectedImageIndex] && (
        <div className="fixed inset-0 z-50 w-full min-w-0 overflow-x-clip overflow-y-auto bg-[#0B0908]/98 backdrop-blur-md flex min-h-full flex-col items-center justify-between p-3 sm:p-6 animate-fade-in">
          
          {/* Lightbox Header Bar */}
          <div className="w-full max-w-5xl min-w-0 flex flex-wrap items-center justify-between gap-2 border-b border-[#3A342E] pb-3 text-xs font-display uppercase tracking-widest text-[#E8E1D3]">
            <span className="text-[#8A1F1F] font-mono">{refNumber} — TELA CHEIA</span>
            <button
              onClick={() => setIsZoomOpen(false)}
              className="min-h-10 px-3 py-1 bg-[#141210] border border-[#3A342E] text-[#E8E1D3] hover:text-[#8A1F1F] hover:border-[#8A1F1F] transition-colors flex items-center space-x-1"
            >
              <span>FECHAR</span>
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Lightbox Main Image Stage */}
          <div className="relative max-w-4xl max-h-[75vh] w-full min-h-0 flex items-center justify-center my-auto p-2">
            <img
              src={images[selectedImageIndex]}
                alt={displayTitle}
              className="max-w-full max-h-full object-contain"
            />

            {images.length > 1 && (
              <>
                <button
                  onClick={handlePrevImage}
                  className="absolute left-2 top-1/2 -translate-y-1/2 min-h-10 min-w-10 p-2 sm:p-3 bg-[#0B0908]/90 border border-[#3A342E] text-[#E8E1D3] hover:bg-[#8A1F1F] hover:border-[#8A1F1F] transition-colors"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <button
                  onClick={handleNextImage}
                  className="absolute right-2 top-1/2 -translate-y-1/2 min-h-10 min-w-10 p-2 sm:p-3 bg-[#0B0908]/90 border border-[#3A342E] text-[#E8E1D3] hover:bg-[#8A1F1F] hover:border-[#8A1F1F] transition-colors"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              </>
            )}
          </div>

          {/* Lightbox Footer Navigation */}
          <div className="w-full max-w-xl max-h-24 overflow-y-auto flex flex-wrap items-center justify-center gap-2 pt-2 border-t border-[#3A342E]">
            {images.map((img, idx) => (
              <button
                key={idx}
                onClick={() => setSelectedImageIndex(idx)}
                className={`w-10 h-10 border overflow-hidden p-0.5 bg-[#090807] transition-all ${
                  idx === selectedImageIndex ? 'border-[#8A1F1F] ring-1 ring-[#8A1F1F]' : 'border-[#3A342E] opacity-50'
                }`}
              >
                <img src={img} alt="Thumb" className="w-full h-full object-contain" />
              </button>
            ))}
          </div>

        </div>
      )}

    </div>
  );
};
