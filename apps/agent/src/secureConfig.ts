export interface DesktopConfig {
  apiUrl: string;
  webUrl: string;
  token: string;
  mode: 'real' | 'simulate';
}

/** JSON persisted by the desktop shell. `token` is included only to detect and
 * reject legacy unsafe config; it must never be written by current versions. */
export interface StoredDesktopConfig {
  apiUrl?: string;
  webUrl?: string;
  token?: unknown;
  tokenEncrypted?: string;
  mode?: 'real' | 'simulate';
}

export interface SecureStorage {
  isAvailable(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

/**
 * There is no safe plaintext fallback for an agent token: it authorizes a PC
 * to print paid customer documents. A Windows desktop setup must use the
 * platform credential vault, otherwise it remains unconfigured.
 */
export function toStoredDesktopConfig(config: DesktopConfig, secureStorage: SecureStorage): StoredDesktopConfig {
  if (!secureStorage.isAvailable()) {
    throw new Error('Windows secure storage is unavailable. PrintQs cannot save this computer token safely.');
  }
  return {
    apiUrl: config.apiUrl,
    webUrl: config.webUrl,
    mode: config.mode,
    tokenEncrypted: secureStorage.encrypt(config.token),
  };
}

export function fromStoredDesktopConfig(
  stored: StoredDesktopConfig,
  secureStorage: SecureStorage,
): DesktopConfig | null {
  if (!stored.apiUrl || !stored.tokenEncrypted || !secureStorage.isAvailable()) return null;
  try {
    const token = secureStorage.decrypt(stored.tokenEncrypted);
    if (!token) return null;
    return {
      apiUrl: stored.apiUrl.replace(/\/$/, ''),
      webUrl: (stored.webUrl || 'https://printqs.com').replace(/\/$/, ''),
      token,
      mode: stored.mode === 'simulate' ? 'simulate' : 'real',
    };
  } catch {
    return null;
  }
}
