import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { Product } from '../types';
import { getProductDisplayCategory } from '../lib/productPresentation';
import { resolveCanonicalProductImage } from '../lib/productCanonical';
import { getProducts } from '../services/api';

interface CategoryShowcaseProps {
  onEnterCatalog: () => void;
}

const CATEGORY_PRIORITY = [
  'Iluminação',
  'Decoração',
  'Móveis',
  'Vestuário',
  'Casa',
  'Cozinha & Mesa',
  'Calçados & Acessórios',
  'Infantil',
];

export function CategoryShowcase({ onEnterCatalog }: CategoryShowcaseProps) {
  const [products, setProducts] = useState<Product[]>([]);

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

  const categories = useMemo(() => {
    const grouped = new Map<string, Product[]>();

    for (const product of products) {
      const category = getProductDisplayCategory(product).trim();
      if (!category) continue;
      const group = grouped.get(category) ?? [];
      group.push(product);
      grouped.set(category, group);
    }

    return [...grouped.entries()]
      .map(([name, items]) => {
        const representative = items.find((product) => resolveCanonicalProductImage(product).publicHttpsImageUrls.length > 0) ?? items[0];
        const imageUrl = representative
          ? resolveCanonicalProductImage(representative).publicHttpsImageUrls[0] ?? ''
          : '';
        return { name, count: items.length, imageUrl };
      })
      .sort((a, b) => {
        const ai = CATEGORY_PRIORITY.indexOf(a.name);
        const bi = CATEGORY_PRIORITY.indexOf(b.name);
        const aRank = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
        const bRank = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
        return aRank - bRank || b.count - a.count || a.name.localeCompare(b.name, 'pt-BR');
      })
      .slice(0, 4);
  }, [products]);

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

  return (
    <section className="category-showcase" aria-labelledby="category-showcase-title">
      <div className="category-showcase__heading">
        <p id="category-showcase-title">Explorar por categoria</p>
        <span>Cada seleção abre um universo.</span>
      </div>

      <div className="category-showcase__grid">
        {categories.map((category) => (
          <button
            type="button"
            key={category.name}
            className="category-showcase__item"
            onClick={() => selectCategory(category.name)}
            aria-label={`Explorar ${category.name}: ${category.count} ${category.count === 1 ? 'achado' : 'achados'}`}
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
                {category.name} —<br />
                {category.count.toString().padStart(2, '0')} {category.count === 1 ? 'achado' : 'achados'}
              </span>
              <ArrowUpRight aria-hidden="true" />
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
