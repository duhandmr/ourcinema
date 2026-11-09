/**
 * "Beni hatırla" desteği: Oturum işaretliyse localStorage'da (kalıcı),
 * değilse sessionStorage'da (sekme kapanınca silinir) saklanır.
 */
const REMEMBER_KEY = 'ourcinema.remember';

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function getRememberPreference(): boolean {
  return safe(() => localStorage.getItem(REMEMBER_KEY) !== 'false', true);
}

export function setRememberPreference(remember: boolean): void {
  safe(() => localStorage.setItem(REMEMBER_KEY, remember ? 'true' : 'false'), undefined);
}

export const rememberStorage = {
  getItem(key: string): string | null {
    return safe(() => localStorage.getItem(key) ?? sessionStorage.getItem(key), null);
  },
  setItem(key: string, value: string): void {
    safe(() => {
      if (getRememberPreference()) {
        localStorage.setItem(key, value);
        sessionStorage.removeItem(key);
      } else {
        sessionStorage.setItem(key, value);
        localStorage.removeItem(key);
      }
    }, undefined);
  },
  removeItem(key: string): void {
    safe(() => {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    }, undefined);
  },
};
