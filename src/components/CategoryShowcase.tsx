import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { Product } from '../types';
import { getProductDisplayCategory } from '../lib/productPresentation';
import { PUBLIC_PRODUCT_CATEGORIES } from '../lib/productCategory';
import { resolveCanonicalProductImage } from '../lib/productCanonical';
import { getProducts } from '../services/api';

interface CategoryShowcaseProps {
  onEnterCatalog: () => void;
}

interface CategoryEntry {
  name: string;
  count: number;
  imageUrl: string;
}

export function CategoryShowcase({ onEnterCatalog }: CategoryShowcaseProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [reduceMotion, setReduceMotion] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  const loopWidthRef = useRef(0);
  const resumeTimerRef = useRef<number | null>(null);
  const dragRef = useRef({ active: false, startX: 0, startScrollLeft: 0 });

  useEffect(() => {
    let active = true;
    void getProducts()
      .then((items) => {
        if (active) setProducts(items);
      })
      .catch(() => {
        if (active) setProducts([]);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduceMotion(media.matches);
    sync();
    media.addEventListener?.('change', sync);
    return () => media.removeEventListener?.('change', sync);
  }, []);

  const categories = useMemo<CategoryEntry[]>(() => {
    const grouped = new Map<string, Product[]>();

    for (const product of products) {
      const category = getProductDisplayCategory(product).trim();
      if (!category) continue;
      const group = grouped.get(category) ?? [];
      group.push(product);
      grouped.set(category, group);
    }

    return PUBLIC_PRODUCT_CATEGORIES
      .map((name) => {
        const items = grouped.get(name) ?? [];
        const representative =
          items.find((product) => product.destaque && resolveCanonicalProductImage(product).publicHttpsImageUrls.length > 0)
          ?? items.find((product) => resolveCanonicalProductImage(product).publicHttpsImageUrls.length > 0)
          ?? items[0];
        const imageUrl = representative
          ? resolveCanonicalProductImage(representative).publicHttpsImageUrls[0] ?? ''
          : '';
        return { name, count: items.length, imageUrl };
      })
      .filter((category) => category.count > 0);
  }, [products]);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail || reduceMotion || categories.length < 2) {
      loopWidthRef.current = 0;
      return;
    }

    const measureLoop = () => {
      const firstOriginal = rail.querySelector<HTMLElement>('[data-loop-copy="0"][data-loop-index="0"]');
      const firstDuplicate = rail.querySelector<HTMLElement>('[data-loop-copy="1"][data-loop-index="0"]');
      if (!firstOriginal || !firstDuplicate) return;
      loopWidthRef.current = Math.max(0, firstDuplicate.offsetLeft - firstOriginal.offsetLeft);
    };

    measureLoop();

    const resizeObserver = new ResizeObserver(measureLoop);
    resizeObserver.observe(rail);
    const track = rail.firstElementChild;
    if (track instanceof HTMLElement) resizeObserver.observe(track);

    return () => resizeObserver.disconnect();
  }, [categories.length, reduceMotion]);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail || reduceMotion || categories.length < 2) return;

    let frameId = 0;
    let previous = performance.now();

    const animate = (now: number) => {
      const delta = Math.min(34, now - previous);
      previous = now;

      if (!pausedRef.current && document.visibilityState === 'visible') {
        rail.scrollLeft += delta * 0.04;

        const loopWidth = loopWidthRef.current;
        if (loopWidth > 0 && rail.scrollLeft >= loopWidth) {
          rail.scrollLeft -= loopWidth;
        }
      }

      frameId = window.requestAnimationFrame(animate);
    };

    frameId = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frameId);
  }, [categories.length, reduceMotion]);

  useEffect(() => {
    return () => {
      if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current);
    };
  }, []);

  const pause = () => {
    pausedRef.current = true;
    if (resumeTimerRef.current !== null) {
      window.clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
  };

  const resumeLater = () => {
    if (reduceMotion) return;
    if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = window.setTimeout(() => {
      pausedRef.current = false;
      resumeTimerRef.current = null;
    }, 1200);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    pause();
    if (event.pointerType !== 'mouse' || !railRef.current) return;
    dragRef.current = {
      active: true,
      startX: event.clientX,
      startScrollLeft: railRef.current.scrollLeft,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active || !railRef.current) return;
    const distance = event.clientX - dragRef.current.startX;
    railRef.current.scrollLeft = dragRef.current.startScrollLeft - distance;
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current.active) {
      dragRef.current.active = false;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
    resumeLater();
  };

  const selectCategory = (category: string) => {
    onEnterCatalog();

    window.requestAnimationFrame(() => {
      const toggle = document.querySelector<HTMLButtonElement>('button[aria-controls="category-panel"]');
      if (toggle?.getAttribute('aria-expanded') !== 'true') toggle?.click();

      window.requestAnimationFrame(() => {
        const expectedTestId = `category-option-${category}`;
        const option = [...document.querySelectorAll<HTMLButtonElement>('[data-testid^="category-option-"]')]
          .find((element) => element.getAttribute('data-testid') === expectedTestId);
        option?.click();
      });
    });
  };

  if (categories.length === 0) return null;

  const loopCategories = reduceMotion ? categories : [...categories, ...categories];

  return (
    <section className="category-showcase" aria-labelledby="category-showcase-title">
      <div className="category-showcase__heading">
        <p id="category-showcase-title">Explorar por categoria</p>
        <span>Cada seleção abre um universo.</span>
      </div>

      <div
        ref={railRef}
        className="category-showcase__viewport"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={() => {
          pause();
          resumeLater();
        }}
      >
        <div className="category-showcase__track">
          {loopCategories.map((category, index) => {
            const duplicate = !reduceMotion && index >= categories.length;
            const loopIndex = duplicate ? index - categories.length : index;
            return (
              <button
                type="button"
                key={`${category.name}-${index}`}
                className="category-showcase__item"
                data-loop-copy={duplicate ? '1' : '0'}
                data-loop-index={loopIndex}
                onClick={() => selectCategory(category.name)}
                aria-label={duplicate ? undefined : `Explorar ${category.name}: ${category.count} ${category.count === 1 ? 'achado' : 'achados'}`}
                aria-hidden={duplicate ? 'true' : undefined}
                tabIndex={duplicate ? -1 : 0}
              >
                <div className="category-showcase__image-wrap">
                  {category.imageUrl ? (
                    <img src={category.imageUrl} alt="" loading="lazy" decoding="async" />
                  ) : (
                    <div className="category-showcase__placeholder" aria-hidden="true" />
                  )}
                </div>
                <span className="category-showcase__meta">
                  <span>
                    <strong>{category.name}</strong>
                    <small>
                      {category.count.toString().padStart(2, '0')} {category.count === 1 ? 'achado' : 'achados'}
                    </small>
                  </span>
                  <ArrowUpRight aria-hidden="true" />
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
