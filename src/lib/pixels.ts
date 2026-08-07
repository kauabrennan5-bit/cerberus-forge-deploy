import { Product } from '../types';

// Declare window global pixel functions
import { sendMetaCapiEvent } from '../services/api';

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

/**
 * Dynamically inject Meta Pixel base script into <head>
 */
export function initMetaPixel(pixelId: string) {
  if (!pixelId || typeof window === 'undefined') return;
  
  if (window.fbq) {
    try {
      window.fbq('init', pixelId);
    } catch (e) {
      console.warn('Meta Pixel init warning:', e);
    }
    return;
  }

  /* eslint-disable */
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
    window.fbq('init', pixelId);
    window.fbq('track', 'PageView');
  } catch (e) {
    console.warn('Meta Pixel PageView warning:', e);
  }
}

/**
 * Dynamically inject TikTok Pixel base script into <head>
 */
export function initTikTokPixel(pixelId: string) {
  if (!pixelId || typeof window === 'undefined') return;

  if (window.ttq) {
    try {
      window.ttq.load(pixelId);
    } catch (e) {
      console.warn('TikTok Pixel load warning:', e);
    }
    return;
  }

  /* eslint-disable */
  (function(w: any, d: any, t: any) {
    w.TiktokAnalyticsObject = t;
    var ttq = w[t] = w[t] || [];
    ttq.methods = ["page", "track", "identify", "instances", "debug", "on", "off", "once", "ready", "alias", "group", "enableCookie", "disableCookie"];
    ttq.setAndDefer = function(t: any, e: any) {
      t[e] = function() {
        t.push([e].concat(Array.prototype.slice.call(arguments, 0)));
      };
    };
    for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
    ttq.instance = function(t: any) {
      for (var e = ttq.methods[i], n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(t, ttq.methods[n]);
      return t;
    };
    ttq.load = function(e: any, n: any) {
      var i = "https://analytics.tiktok.com/i18n/pixel/sdk.js";
      ttq._i = ttq._i || {};
      ttq._i[e] = [];
      ttq._i[e]._u = i;
      ttq._t = ttq._t || {};
      ttq._t[e] = +new Date();
      ttq._o = ttq._o || {};
      ttq._o[e] = n || {};
      var o = document.createElement("script");
      o.type = "text/javascript";
      o.async = true;
      o.src = i + "?sdkid=" + e + "&lib=" + t;
      var a = document.getElementsByTagName("script")[0];
      a.parentNode?.insertBefore(o, a);
    };
  })(window, document, 'ttq');

  try {
    window.ttq.load(pixelId);
    window.ttq.page();
  } catch (e) {
    console.warn('TikTok Pixel page warning:', e);
  }
}

/**
 * Track InitiateCheckout Event across Client Meta Pixel + Server Meta CAPI + TikTok Pixel
 * Deduplication via matching event_id
 */
export function trackProductClick(
  product: Product,
  metaPixelId?: string,
  metaAccessToken?: string
) {
  const eventId = `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  const payload = {
    content_name: product.produto,
    content_category: product.categoria,
    content_ids: [product.id],
    content_type: 'product',
    value: product.preco,
    currency: 'BRL'
  };

  // 1. Client-Side Meta Pixel (InitiateCheckout with eventID for deduplication)
  if (typeof window !== 'undefined' && window.fbq) {
    try {
      window.fbq('track', 'InitiateCheckout', payload, { eventID: eventId });
      console.log('⚡ Meta Pixel (Client) InitiateCheckout fired:', { payload, eventID: eventId });
    } catch (e) {
      console.warn('Meta Pixel track error:', e);
    }
  }

  // 2. Server-Side Meta Conversions API (CAPI) sending matching event_id
  sendMetaCapiEvent({
    event_name: 'InitiateCheckout',
    event_id: eventId,
    product,
    metaPixelId,
    metaAccessToken
  }).catch((err) => {
    console.warn('Meta CAPI fetch warning:', err);
  });

  // 3. TikTok Pixel (InitiateCheckout)
  if (typeof window !== 'undefined' && window.ttq && typeof window.ttq.track === 'function') {
    try {
      window.ttq.track('InitiateCheckout', payload);
      console.log('⚡ TikTok Pixel InitiateCheckout fired:', payload);
    } catch (e) {
      console.warn('TikTok Pixel track error:', e);
    }
  }
}
