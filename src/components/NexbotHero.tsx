import { ArrowRight } from 'lucide-react';
import { CerberusLogo } from './CerberusLogo';
import { CategoryShowcase } from './CategoryShowcase';

interface NexbotHeroProps {
  onEnterCatalog: () => void;
}

export function NexbotHero({ onEnterCatalog }: NexbotHeroProps) {
  return (
    <>
      <section className="quiet-hero" aria-labelledby="quiet-hero-title">
        <div className="quiet-hero__copy">
          <div className="quiet-hero__eyebrow">
            <span aria-hidden="true" />
            <p>Cerberus Finds</p>
          </div>

          <h1 id="quiet-hero-title">Curadoria para quem não quer encontrar o óbvio.</h1>

          <p className="quiet-hero__description">
            Uma seleção de objetos, peças e descobertas escolhidas por estética, personalidade e utilidade.
          </p>

          <button type="button" className="quiet-hero__cta" onClick={onEnterCatalog}>
            <span>Explorar acervo</span>
            <ArrowRight aria-hidden="true" />
          </button>
        </div>

        <div className="quiet-hero__guardian" aria-hidden="true">
          <div className="quiet-hero__guardian-aura" />
          <div className="quiet-hero__guardian-plinth">
            <div className="quiet-hero__guardian-relief">
              <CerberusLogo className="h-full w-full" />
            </div>
          </div>
        </div>
      </section>

      <CategoryShowcase onEnterCatalog={onEnterCatalog} />
    </>
  );
}
