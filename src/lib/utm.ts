import { hasAnalyticsConsent } from './privacyConsent';

export interface UTMParams {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  fbclid?: string;
  gclid?: string;
  ttclid?: string;
  referrer?: string;
  landingPage?: string;
}

const STORAGE_KEY = 'cerberus_utm_attribution_v1';

/**
 * Captura atribuição somente após consentimento explícito. Sem consentimento,
 * nenhum UTM, click id, referrer ou landing page é persistido.
 */
export function captureUTMs(): UTMParams {
  if (typeof window === 'undefined' || !hasAnalyticsConsent()) return {};

  try {
    const searchParams = new URLSearchParams(window.location.search);

    const currentSource = searchParams.get('utm_source');
    const currentMedium = searchParams.get('utm_medium');
    const currentCampaign = searchParams.get('utm_campaign');
    const currentContent = searchParams.get('utm_content');
    const currentTerm = searchParams.get('utm_term');
    const currentFbclid = searchParams.get('fbclid');
    const currentGclid = searchParams.get('gclid');
    const currentTtclid = searchParams.get('ttclid');

    const hasNewUTM = Boolean(
      currentSource || currentMedium || currentCampaign || currentContent || currentTerm ||
      currentFbclid || currentGclid || currentTtclid
    );

    const existing = getStoredUTMs();

    if (hasNewUTM) {
      const updated: UTMParams = {
        ...existing,
        ...(currentSource ? { utm_source: currentSource } : {}),
        ...(currentMedium ? { utm_medium: currentMedium } : {}),
        ...(currentCampaign ? { utm_campaign: currentCampaign } : {}),
        ...(currentContent ? { utm_content: currentContent } : {}),
        ...(currentTerm ? { utm_term: currentTerm } : {}),
        ...(currentFbclid ? { fbclid: currentFbclid } : {}),
        ...(currentGclid ? { gclid: currentGclid } : {}),
        ...(currentTtclid ? { ttclid: currentTtclid } : {}),
        referrer: existing.referrer || document.referrer || '',
        landingPage: existing.landingPage || window.location.href
      };

      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      return updated;
    }

    if (Object.keys(existing).length > 0) return existing;

    const defaultData: UTMParams = {
      referrer: document.referrer || '',
      landingPage: window.location.href
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(defaultData));
    return defaultData;
  } catch (err) {
    console.warn('Erro ao capturar UTMs:', err);
    return {};
  }
}

export function getStoredUTMs(): UTMParams {
  if (typeof window === 'undefined' || !hasAnalyticsConsent()) return {};
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn('Erro ao ler UTMs do sessionStorage:', e);
  }
  return {};
}

export function clearUTMs(): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.warn('Erro ao limpar UTMs:', e);
  }
}

export function appendUTMsToUrl(targetUrl: string, customUtms?: UTMParams): string {
  if (!targetUrl) return '';
  if (!hasAnalyticsConsent()) return targetUrl;

  try {
    const utms = customUtms || getStoredUTMs();
    const dummyBase = 'https://cerberusfinds.com';
    let urlObj: URL;
    try {
      urlObj = new URL(targetUrl);
    } catch {
      urlObj = new URL(targetUrl, dummyBase);
    }

    const keysToAppend: (keyof UTMParams)[] = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
      'fbclid', 'gclid', 'ttclid'
    ];

    keysToAppend.forEach((key) => {
      const val = utms[key];
      if (val && !urlObj.searchParams.has(key)) urlObj.searchParams.set(key, val);
    });

    return targetUrl.startsWith('http') ? urlObj.toString() : `${urlObj.pathname}${urlObj.search}${urlObj.hash}`;
  } catch (err) {
    console.warn('Erro ao adicionar UTMs à URL:', err);
    return targetUrl;
  }
}
