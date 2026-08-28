import { Product } from '../types';
import { sendMetaCapiEvent, trackProductClickApi } from '../services/api';
import { getStoredUTMs, appendUTMsToUrl, UTMParams } from './utm';
import { hasAnalyticsConsent } from './privacyConsent';

declare global {
  interface Window {
    gtag?: (...args: any[]) => void;
    dataLayer?: any[];
    fbq?: (...args: any[]) => void;
    ttq?: {
      track: (event: string, data?: any) => void;
      page: () => void;
      load: (id: string) => void;
    };
  }
}

/**
 * Inicializa GA4 somente depois de consentimento analítico explícito.
 */
export function initGA4(measurementId?: string): void {
  if (!hasAnalyticsConsent()) return;
  const gaId = measurementId || (typeof import.meta !== 'undefined' ? (import.meta as any).env?.VITE_GA4_MEASUREMENT_ID : undefined);
  if (!gaId || typeof window === 'undefined') return;

  window.dataLayer = window.dataLayer || [];
  if (!window.gtag) {
    window.gtag = function () {
      window.dataLayer?.push(arguments);
    };
  }

  const existingScript = document.querySelector('script[src*="googletagmanager.com/gtag/js"]');
  if (!existingScript) {
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gaId)}`;
    document.head.appendChild(script);

    window.gtag('js', new Date());
    window.gtag('config', gaId, {
      send_page_view: false
    });
  }
}

/** Dispara Page View apenas com consentimento explícito. */
export function trackPageView(pagePath: string, pageTitle?: string): void {
  if (!hasAnalyticsConsent() || typeof window === 'undefined') return;

  if (window.gtag) {
    try {
      window.gtag('event', 'page_view', {
        page_path: pagePath,
        page_title: pageTitle || document.title
      });
    } catch (e) {
      console.warn('Erro ao disparar page_view no GA4:', e);
    }
  }

  if (window.ttq && typeof window.ttq.page === 'function') {
    try {
      window.ttq.page();
    } catch (e) {
      console.warn('Erro no TikTok page view:', e);
    }
  }
}

/** Dispara ViewContent / view_item apenas com consentimento explícito. */
export function trackViewItem(product: Product): void {
  if (!hasAnalyticsConsent() || typeof window === 'undefined' || !product) return;

  const itemPayload = {
    item_id: product.id,
    item_name: product.produto,
    item_category: product.categoria,
    price: product.preco,
    quantity: 1
  };

  if (window.gtag) {
    try {
      window.gtag('event', 'view_item', {
        currency: 'BRL',
        value: product.preco,
        items: [itemPayload]
      });
    } catch (e) {
      console.warn('GA4 view_item error:', e);
    }
  }

  if (window.dataLayer) {
    try {
      window.dataLayer.push({
        event: 'view_item',
        ecommerce: {
          currency: 'BRL',
          value: product.preco,
          items: [itemPayload]
        }
      });
    } catch (e) {
      console.warn('dataLayer push error:', e);
    }
  }

  if (window.fbq) {
    try {
      window.fbq('track', 'ViewContent', {
        content_name: product.produto,
        content_category: product.categoria,
        content_ids: [product.id],
        content_type: 'product',
        value: product.preco,
        currency: 'BRL'
      });
    } catch (e) {
      console.warn('Meta Pixel ViewContent error:', e);
    }
  }

  if (window.ttq && typeof window.ttq.track === 'function') {
    try {
      window.ttq.track('ViewContent', {
        content_name: product.produto,
        content_category: product.categoria,
        content_id: product.id,
        content_type: 'product',
        value: product.preco,
        currency: 'BRL'
      });
    } catch (e) {
      console.warn('TikTok Pixel ViewContent error:', e);
    }
  }
}

/** Dispara select_item apenas com consentimento explícito. */
export function trackSelectItem(product: Product): void {
  if (!hasAnalyticsConsent() || typeof window === 'undefined' || !product) return;

  if (window.gtag) {
    try {
      window.gtag('event', 'select_item', {
        item_list_name: 'Catalog Grid',
        items: [
          {
            item_id: product.id,
            item_name: product.produto,
            item_category: product.categoria,
            price: product.preco
          }
        ]
      });
    } catch (e) {
      console.warn('GA4 select_item error:', e);
    }
  }
}

/**
 * Registra analytics do clique somente após consentimento. O redirecionamento
 * nunca depende do tracking e continua funcional quando o usuário não consentiu.
 * Credenciais da Meta não são aceitas do cliente; o backend deve usar somente
 * META_PIXEL_ID e META_ACCESS_TOKEN do ambiente do servidor.
 */
export async function trackClickAndGetUrl(
  product: Product,
  _metaPixelId?: string,
  _metaAccessToken?: string
): Promise<string> {
  const targetUrl = product.paginaPonteUrl || product.link;
  if (!hasAnalyticsConsent()) return targetUrl;

  const eventId = `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const utms: UTMParams = getStoredUTMs();

  const payload = {
    content_name: product.produto,
    content_category: product.categoria,
    content_ids: [product.id],
    content_type: 'product',
    value: product.preco,
    currency: 'BRL'
  };

  if (typeof window !== 'undefined' && window.fbq) {
    try {
      window.fbq('track', 'InitiateCheckout', payload, { eventID: eventId });
    } catch (e) {
      console.warn('Meta Pixel InitiateCheckout error:', e);
    }
  }

  // Never transmit Meta access tokens or Pixel IDs from browser state.
  sendMetaCapiEvent({
    event_name: 'InitiateCheckout',
    event_id: eventId,
    product: {
      id: product.id,
      produto: product.produto,
      categoria: product.categoria,
      preco: product.preco
    }
  }).catch((err) => {
    console.warn('Meta CAPI error:', err);
  });

  if (typeof window !== 'undefined' && window.ttq && typeof window.ttq.track === 'function') {
    try {
      window.ttq.track('InitiateCheckout', payload);
    } catch (e) {
      console.warn('TikTok Pixel InitiateCheckout error:', e);
    }
  }

  if (typeof window !== 'undefined' && window.gtag) {
    try {
      window.gtag('event', 'begin_checkout', {
        currency: 'BRL',
        value: product.preco,
        items: [
          {
            item_id: product.id,
            item_name: product.produto,
            item_category: product.categoria,
            price: product.preco,
            quantity: 1
          }
        ]
      });
    } catch (e) {
      console.warn('GA4 begin_checkout error:', e);
    }
  }

  trackProductClickApi({
    productId: product.id,
    productSlug: product.slug || product.id,
    productName: product.produto,
    productPrice: product.preco,
    utm_source: utms.utm_source,
    utm_medium: utms.utm_medium,
    utm_campaign: utms.utm_campaign,
    utm_content: utms.utm_content,
    utm_term: utms.utm_term,
    fbclid: utms.fbclid,
    gclid: utms.gclid,
    ttclid: utms.ttclid,
    referrer: utms.referrer || (typeof document !== 'undefined' ? document.referrer : ''),
    landingPage: utms.landingPage || (typeof window !== 'undefined' ? window.location.href : '')
  }).catch((err) => {
    console.warn('Registro de clique no backend falhou (não bloqueante):', err);
  });

  return appendUTMsToUrl(targetUrl, utms);
}
