/**
 * Use the Windows location service instead of Chromium's default Google network
 * provider, which needs a paid API key and otherwise fails with a 401
 * ("Failed to query location from network service"). Chrome on Windows does this too.
 */
export const WINDOWS_LOCATION_FEATURE = 'LocationProviderManager:LocationProviderManagerMode/PlatformOnly';

const featureName = (entry: string) => entry.split(/[:<]/)[0]!.trim();

/** Adds a feature to an existing --enable-features value, keeping what is already there. */
export function withEnabledFeature(existing: string, feature: string): string {
  const entries = existing.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.some((entry) => featureName(entry) === featureName(feature))) return entries.join(',');
  return [...entries, feature].join(',');
}

/** Smoke runs set this so they never touch the installed app's Windows autostart entry. */
export const DESKTOP_SMOKE_ENV = 'PRINTQ_DESKTOP_SMOKE';

/** Only the installed app registers itself to start with Windows; dev and smoke runs must not. */
export function shouldRegisterAutostart(isPackaged: boolean, env: NodeJS.ProcessEnv): boolean {
  const smoke = env[DESKTOP_SMOKE_ENV];
  return isPackaged && !(smoke && smoke !== '0' && smoke.toLowerCase() !== 'false');
}
