import { Product } from '../types';
import { sendMetaCapiEvent, trackProductClickApi } from '../services/api';
import { getStoredUTMs, appendUTMsToUrl, UTMParams } from './utm';

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
 * Inicializa a tag do Google Analytics 4 (GA4) se o ID de medição for fornecido
 */
export function initGA4(measurementId?: string): void {
  const gaId = measurementId || (typeof import.meta !== 'undefined' ? (import.meta as any).env?.VITE_GA4_MEASUREMENT_ID : undefined);
  if (!gaId || typeof window === 'undefined') return;

  window.dataLayer = window.dataLayer || [];
  if (!window.gtag) {
    window.gtag = function () {
      window.dataLayer?.push(arguments);
    };
  }

  // Verifica se o script do gtag já foi injetado
  const existingScript = document.querySelector(`script[src*="googletagmanager.com/gtag/js"]`);
  if (!existingScript) {
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gaId)}`;
    document.head.appendChild(script);

    window.gtag('js', new Date());
    window.gtag('config', gaId, {
      send_page_view: false // Controlado manualmente via trackPageView
    });
    console.log(`⚡ GA4 inicializado com ID: ${gaId}`);
  }
}

/**
 * Dispara evento de Visualização de Página (Page View) para GA4 e Pixels
 */
export function trackPageView(pagePath: string, pageTitle?: string): void {
  if (typeof window === 'undefined') return;

  // GA4 Page View
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

  // TikTok Pixel Page
  if (window.ttq && typeof window.ttq.page === 'function') {
    try {
      window.ttq.page();
    } catch (e) {
      console.warn('Erro no TikTok page view:', e);
    }
  }
}

/**
 * Dispara evento ViewContent / view_item quando o usuário abre os detalhes de um produto
 */
export function trackViewItem(product: Product): void {
  if (typeof window === 'undefined' || !product) return;

  const itemPayload = {
    item_id: product.id,
    item_name: product.produto,
    item_category: product.categoria,
    price: product.preco,
    quantity: 1
  };

  // 1. GA4 view_item
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

  // 2. DataLayer push para GTM
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

  // 3. Meta Pixel ViewContent
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

  // 4. TikTok Pixel ViewContent
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

/**
 * Dispara evento select_item no GA4 quando o usuário clica em um card no catálogo
 */
export function trackSelectItem(product: Product): void {
  if (typeof window === 'undefined' || !product) return;

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
 * Registra o clique no produto no backend e dispara todos os eventos de checkout (InitiateCheckout / begin_checkout)
 * Retorna a URL final com UTMs incorporadas para o redirecionamento.
 */
export async function trackClickAndGetUrl(
  product: Product,
  metaPixelId?: string,
  metaAccessToken?: string
): Promise<string> {
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

  // 1. Client-Side Meta Pixel (InitiateCheckout com eventID para deduplicação CAPI)
  if (typeof window !== 'undefined' && window.fbq) {
    try {
      window.fbq('track', 'InitiateCheckout', payload, { eventID: eventId });
    } catch (e) {
      console.warn('Meta Pixel InitiateCheckout error:', e);
    }
  }

  // 2. Server-Side Meta Conversions API (CAPI)
  sendMetaCapiEvent({
    event_name: 'InitiateCheckout',
    event_id: eventId,
    product,
    metaPixelId,
    metaAccessToken
  }).catch((err) => {
    console.warn('Meta CAPI error:', err);
  });

  // 3. TikTok Pixel
  if (typeof window !== 'undefined' && window.ttq && typeof window.ttq.track === 'function') {
    try {
      window.ttq.track('InitiateCheckout', payload);
    } catch (e) {
      console.warn('TikTok Pixel InitiateCheckout error:', e);
    }
  }

  // 4. GA4 begin_checkout
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

  // 5. Registro Assíncrono de Clique no Backend (Supabase product_clicks)
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

  // 6. Constrói URL final com UTMs anexadas
  const targetUrl = product.paginaPonteUrl || product.link;
  return appendUTMsToUrl(targetUrl, utms);
}
