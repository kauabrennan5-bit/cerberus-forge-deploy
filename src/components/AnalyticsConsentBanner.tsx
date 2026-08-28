import { useState } from 'react';
import { getAnalyticsConsent, setAnalyticsConsent } from '../lib/privacyConsent';

export function AnalyticsConsentBanner() {
  const [visible, setVisible] = useState(() => getAnalyticsConsent() === 'unset');

  if (!visible) return null;

  const deny = () => {
    setAnalyticsConsent('denied');
    setVisible(false);
  };

  const accept = () => {
    setAnalyticsConsent('granted');
    // Tracking libraries are deliberately initialized only after consent.
    // Reloading once guarantees every analytics initializer sees the persisted
    // decision without introducing a second client-side authority for consent.
    window.location.reload();
  };

  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label="Preferências de privacidade"
      className="fixed inset-x-3 bottom-3 z-[100] mx-auto max-w-3xl border border-[#3A342E] bg-[#181512] p-4 shadow-2xl sm:inset-x-6 sm:bottom-6"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-xl">
          <p className="font-display text-xs uppercase tracking-widest text-[#E8E1D3]">
            Privacidade e métricas
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[#E8E1D3]/70">
            O site funciona sem cookies de analytics. Com sua permissão, usamos métricas de audiência e publicidade para entender visitas e cliques. Você pode recusar sem perder acesso ao catálogo.
          </p>
        </div>

        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={deny}
            className="border border-[#3A342E] bg-[#0B0908] px-4 py-2 text-[11px] font-display uppercase tracking-widest text-[#E8E1D3] transition-colors hover:border-[#8A1F1F]"
          >
            Recusar
          </button>
          <button
            type="button"
            onClick={accept}
            className="border border-[#8A1F1F] bg-[#8A1F1F] px-4 py-2 text-[11px] font-display uppercase tracking-widest text-[#E8E1D3] transition-opacity hover:opacity-80"
          >
            Aceitar métricas
          </button>
        </div>
      </div>
    </div>
  );
}
