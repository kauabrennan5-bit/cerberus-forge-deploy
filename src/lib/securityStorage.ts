import { clearAdminSessionPassword, setAdminSessionPassword } from './adminSession';

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
 * Removes credentials left by legacy builds and prevents future browser-side
 * persistence. Legacy AdminForm setItem/removeItem calls are translated into
 * an ephemeral in-memory session so existing UI flows remain functional while
 * refresh always requires a new login.
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
    // Storage may be unavailable. The app must continue fail-closed.
  }

  const storagePrototype = Object.getPrototypeOf(window.localStorage) as Storage;
  const originalSetItem = storagePrototype.setItem;
  const originalRemoveItem = storagePrototype.removeItem;

  const marker = '__cerberusSensitiveStorageGuardInstalled';
  if ((storagePrototype as any)[marker]) return;
  (storagePrototype as any)[marker] = true;

  storagePrototype.setItem = function guardedSetItem(key: string, value: string): void {
    if (this === window.localStorage) {
      if (key === ADMIN_PASSWORD_KEY) {
        setAdminSessionPassword(value);
        originalRemoveItem.call(this, key);
        return;
      }
      if (key === CONFIG_STORAGE_KEY) {
        originalSetItem.call(this, key, sanitizeConfigJson(value));
        return;
      }
    }
    originalSetItem.call(this, key, value);
  };

  storagePrototype.removeItem = function guardedRemoveItem(key: string): void {
    if (this === window.localStorage && key === ADMIN_PASSWORD_KEY) {
      clearAdminSessionPassword();
    }
    originalRemoveItem.call(this, key);
  };
}
