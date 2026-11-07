import { describe, expect, it } from 'vitest';
import { WINDOWS_LOCATION_FEATURE, shouldRegisterAutostart, withEnabledFeature } from './desktopStartup.js';

describe('withEnabledFeature', () => {
  it('sets the Windows location feature when nothing else is enabled', () => {
    expect(withEnabledFeature('', WINDOWS_LOCATION_FEATURE)).toBe(WINDOWS_LOCATION_FEATURE);
  });

  it('keeps features that were already enabled', () => {
    expect(withEnabledFeature('Foo,Bar:x/1', WINDOWS_LOCATION_FEATURE)).toBe(`Foo,Bar:x/1,${WINDOWS_LOCATION_FEATURE}`);
  });

  it('does not add the feature twice or override an explicit choice', () => {
    expect(withEnabledFeature(WINDOWS_LOCATION_FEATURE, WINDOWS_LOCATION_FEATURE)).toBe(WINDOWS_LOCATION_FEATURE);
    expect(withEnabledFeature('LocationProviderManager:LocationProviderManagerMode/HybridPlatform', WINDOWS_LOCATION_FEATURE))
      .toBe('LocationProviderManager:LocationProviderManagerMode/HybridPlatform');
  });
});

describe('shouldRegisterAutostart', () => {
  it('registers only for the installed app', () => {
    expect(shouldRegisterAutostart(true, {})).toBe(true);
    expect(shouldRegisterAutostart(false, {})).toBe(false);
  });

  it('skips smoke runs of the packaged app', () => {
    expect(shouldRegisterAutostart(true, { PRINTQ_DESKTOP_SMOKE: '1' })).toBe(false);
    expect(shouldRegisterAutostart(true, { PRINTQ_DESKTOP_SMOKE: 'true' })).toBe(false);
    expect(shouldRegisterAutostart(true, { PRINTQ_DESKTOP_SMOKE: '0' })).toBe(true);
    expect(shouldRegisterAutostart(true, { PRINTQ_DESKTOP_SMOKE: 'false' })).toBe(true);
  });
});
