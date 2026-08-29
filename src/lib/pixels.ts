import { Product } from '../types';
import { sendMetaCapiEvent } from '../services/api';
import { hasAnalyticsConsent } from './privacyConsent';

declare global {
  interface Window {
    fbq?: (...args: any[]) => void;
    _fbq?: any;
    ttq?: {
      track: (event: string, data?: any) => void;
      page: () => void;
      load: (id: string) => void;
    };
  }
}

/** Dynamically inject Meta Pixel only after explicit analytics consent. */
export function initMetaPixel(pixelId: string) {
  if (!hasAnalyticsConsent() || !pixelId || typeof window === 'undefined') return;

  if (window.fbq) {
    try {
      window.fbq('init', pixelId);
    } catch (e) {
      console.warn('Meta Pixel init warning:', e);
    }
    return;
  }

  (function(f: any, b: any, e: any, v: any, n?: any, t?: any, s?: any) {
    if (f.fbq) return;
    n = f.fbq = function() {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!f._fbq) f._fbq = n;
    n.push = n;
    n.loaded = !0;
    n.version = '2.0';
    n.queue = [];
    t = b.createElement(e);
    t.async = !0;
    t.src = v;
    s = b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t, s);
  })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

  try {
    window.fbq?.('init', pixelId);
    window.fbq?.('track', 'PageView');
  } catch (e) {
    console.warn('Meta Pixel PageView warning:', e);
  }
}

/** Dynamically inject TikTok Pixel only after explicit analytics consent. */
export function initTikTokPixel(pixelId: string) {
  if (!hasAnalyticsConsent() || !pixelId || typeof window === 'undefined') return;

  if (window.ttq) {
    try {
      window.ttq.load(pixelId);
    } catch (e) {
      console.warn('TikTok Pixel load warning:', e);
    }
    return;
  }

  (function(w: any, d: any, t: any) {
    w.TiktokAnalyticsObject = t;
    const ttq = w[t] = w[t] || [];
    ttq.methods = ["page", "track", "identify", "instances", "debug", "on", "off", "once", "ready", "alias", "group", "enableCookie", "disableCookie"];
    ttq.setAndDefer = function(target: any, method: any) {
      target[method] = function() {
        target.push([method].concat(Array.prototype.slice.call(arguments, 0)));
      };
    };
    for (let i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
    ttq.instance = function(target: any) {
      for (let n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(target, ttq.methods[n]);
      return target;
    };
    ttq.load = function(id: any, options: any) {
      const url = "https://analytics.tiktok.com/i18n/pixel/sdk.js";
      ttq._i = ttq._i || {};
      ttq._i[id] = [];
      ttq._i[id]._u = url;
      ttq._t = ttq._t || {};
      ttq._t[id] = +new Date();
      ttq._o = ttq._o || {};
      ttq._o[id] = options || {};
      const script = document.createElement("script");
      script.type = "text/javascript";
      script.async = true;
      script.src = `${url}?sdkid=${id}&lib=${t}`;
      const first = document.getElementsByTagName("script")[0];
      first.parentNode?.insertBefore(script, first);
    };
  })(window, document, 'ttq');

  try {
    window.ttq?.load(pixelId);
    window.ttq?.page();
  } catch (e) {
    console.warn('TikTok Pixel page warning:', e);
  }
}

/**
 * Track product click only after consent. Pixel IDs and access tokens are never
 * forwarded from browser state to CAPI; server-side env is the authority.
 */
export function trackProductClick(
  product: Product,
  _metaPixelId?: string,
  _metaAccessToken?: string
) {
  if (!hasAnalyticsConsent()) return;

  const eventId = `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
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
      console.warn('Meta Pixel track error:', e);
    }
  }

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
    console.warn('Meta CAPI fetch warning:', err);
  });

  if (typeof window !== 'undefined' && window.ttq && typeof window.ttq.track === 'function') {
    try {
      window.ttq.track('InitiateCheckout', payload);
    } catch (e) {
      console.warn('TikTok Pixel track error:', e);
    }
  }
}
