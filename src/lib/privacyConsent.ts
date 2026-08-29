export type AnalyticsConsent = 'granted' | 'denied' | 'unset';

const ANALYTICS_CONSENT_KEY = 'cerberus_analytics_consent_v1';

export function getAnalyticsConsent(): AnalyticsConsent {
  if (typeof window === 'undefined') return 'unset';
  try {
    const value = window.localStorage.getItem(ANALYTICS_CONSENT_KEY);
    if (value === 'granted' || value === 'denied') return value;
  } catch {
    // Storage can be unavailable in strict/private browsing contexts.
  }
  return 'unset';
}

export function hasAnalyticsConsent(): boolean {
  return getAnalyticsConsent() === 'granted';
}

export function setAnalyticsConsent(consent: Exclude<AnalyticsConsent, 'unset'>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ANALYTICS_CONSENT_KEY, consent);
  } catch {
    // Consent remains fail-closed when persistence is unavailable.
  }
}

export function clearAnalyticsConsent(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(ANALYTICS_CONSENT_KEY);
  } catch {
    // no-op
  }
}
