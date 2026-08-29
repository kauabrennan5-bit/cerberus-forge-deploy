const ADMIN_PASSWORD_KEY = 'cerberus_admin_password';
const CONFIG_STORAGE_KEY = 'cerberus_finds_config_v2';

function sanitizeConfigJson(rawValue: string): string {
  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return rawValue;
    delete parsed.adminPassword;
    delete parsed.metaAccessToken;
    return JSON.stringify(parsed);
  } catch {
    return rawValue;
  }
}

/**
 * Removes credentials left by legacy browser builds.
 *
 * Current Admin and settings flows no longer persist secrets at all, so this
 * startup cleanup is intentionally one-shot instead of altering the global
 * Storage prototype. That keeps browser behavior standard while ensuring old
 * plaintext credentials are deleted on the next load.
 */
export function installSensitiveStorageGuard(): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.removeItem(ADMIN_PASSWORD_KEY);

    const existingConfig = window.localStorage.getItem(CONFIG_STORAGE_KEY);
    if (existingConfig) {
      window.localStorage.setItem(CONFIG_STORAGE_KEY, sanitizeConfigJson(existingConfig));
    }
  } catch {
    // Storage may be unavailable. The app still starts without persisted secrets.
  }
}
