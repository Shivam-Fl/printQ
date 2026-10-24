import { describe, expect, it } from 'vitest';
import {
  buildSettingsPatch,
  coordinateWarning,
  locationChangeNeedsReview,
  formatRupeesField,
  parseRupees,
  typePrice,
  type SettingsDraft,
} from './settingsForm.js';

/** Replays keystrokes the way the controlled input does: state in, one char out. */
function typeInto(start: string, keys: string[]): string[] {
  let text = start;
  const seen: string[] = [];
  for (const key of keys) {
    text = key === '<' ? typePrice(text, text.slice(0, -1)) : typePrice(text, text + key);
    seen.push(text);
  }
  return seen;
}

describe('price field typing (OWN-3)', () => {
  it('typing 10 shows 1 then 10, never a re-rendered 1.00', () => {
    expect(typeInto('', ['1', '0'])).toEqual(['1', '10']);
    expect(parseRupees('10', { required: true })).toEqual({ paise: 1000 });
  });

  it('typing 2.5 keeps the decimal point and digits while editing', () => {
    expect(typeInto('', ['2', '.', '5'])).toEqual(['2', '2.', '2.5']);
    expect(parseRupees('2.', { required: true })).toEqual({ paise: 200 });
    expect(parseRupees('2.5', { required: true })).toEqual({ paise: 250 });
  });

  it('allows a leading decimal point', () => {
    expect(typeInto('', ['.', '5'])).toEqual(['.', '.5']);
    expect(parseRupees('.5', { required: true })).toEqual({ paise: 50 });
  });

  it('lets the colour price be cleared completely, one backspace at a time', () => {
    expect(typeInto('12.50', ['<', '<', '<', '<', '<'])).toEqual(['12.5', '12.', '12', '1', '']);
    expect(parseRupees('', { required: false })).toEqual({ paise: null });
  });

  it('requires a B/W price but not a colour price', () => {
    expect(parseRupees('', { required: true }).error).toMatch(/enter a price/i);
    expect(parseRupees('', { required: false }).error).toBeUndefined();
  });

  it('ignores keystrokes that are not part of a price', () => {
    expect(typeInto('2', ['a', '-', 'e', ' '])).toEqual(['2', '2', '2', '2']);
    expect(typeInto('2.5', ['5'])).toEqual(['2.55']);
    expect(typeInto('2.55', ['5'])).toEqual(['2.55']); // third decimal rejected
    expect(typeInto('', ['1', '.', '.'])).toEqual(['1', '1.', '1.']);
  });

  it('converts to paise without float drift', () => {
    expect(parseRupees('1.15', { required: true }).paise).toBe(115);
    expect(parseRupees('0.29', { required: true }).paise).toBe(29);
    expect(parseRupees('19.99', { required: true }).paise).toBe(1999);
    expect(parseRupees('100', { required: true }).paise).toBe(10_000);
  });

  it('flags a price above the maximum', () => {
    expect(parseRupees('100.01', { required: true, maxPaise: 10_000 }).error).toMatch(/at most ₹100/);
    expect(parseRupees('100', { required: true, maxPaise: 10_000 }).error).toBeUndefined();
  });

  it('formats to two decimals on blur, and leaves empty empty', () => {
    expect(formatRupeesField('2.5')).toBe('2.50');
    expect(formatRupeesField('10')).toBe('10.00');
    expect(formatRupeesField('.5')).toBe('0.50');
    expect(formatRupeesField('')).toBe('');
    expect(formatRupeesField('2.')).toBe('2.00');
  });
});

const base: SettingsDraft = {
  name: 'Sharma Xerox',
  address: '1 Lane',
  campusId: 'c1',
  latitude: 28.6139,
  longitude: 77.209,
  checkInRadiusM: 200,
  counterCapacity: 5,
  revealGraceSeconds: 60,
  autoAssignEnabled: true,
  counterUpiVpa: null,
  counterUpiPayeeName: null,
  printOptions: {
    papers: [{ id: 'A4', label: 'A4', bwPaise: 200, colorPaise: 1000 }],
    bindings: [{ id: 'spiral', label: 'Spiral', paise: 3000 }],
    duplexEnabled: true,
  },
};

describe('changed-fields-only settings save (OWN-1 / OWN-5, client)', () => {
  it('sends nothing when nothing changed', () => {
    expect(buildSettingsPatch(base, structuredClone(base), 3)).toEqual({});
  });

  it('sends only the changed scalar', () => {
    expect(buildSettingsPatch(base, { ...base, counterCapacity: 8 }, 3)).toEqual({ counterCapacity: 8 });
    expect(buildSettingsPatch(base, { ...base, name: 'New name' }, 3)).toEqual({ name: 'New name' });
  });

  it('sends latitude and longitude together, and only when one moved', () => {
    expect(buildSettingsPatch(base, { ...base, latitude: 28.7 }, 3)).toEqual({ latitude: 28.7, longitude: 77.209 });
    expect(buildSettingsPatch(base, { ...base, latitude: null, longitude: null }, 3)).toEqual({ latitude: null, longitude: null });
  });

  it('sends the UPI pair together', () => {
    expect(buildSettingsPatch(base, { ...base, counterUpiVpa: 'a@b' }, 3)).toEqual({ counterUpiVpa: 'a@b', counterUpiPayeeName: null });
  });

  it('sends the menu with the version it was loaded at when a price changed', () => {
    const next = structuredClone(base);
    next.printOptions.papers[0]!.bwPaise = 250;
    expect(buildSettingsPatch(base, next, 3)).toEqual({ printOptions: next.printOptions, expectedPrintOptionsVersion: 3 });
  });

  it('treats the menu as unchanged when only key order differs (jsonb reorders keys)', () => {
    const reordered = structuredClone(base);
    reordered.printOptions.papers = [{ colorPaise: 1000, bwPaise: 200, label: 'A4', id: 'A4' }];
    expect(buildSettingsPatch(base, reordered, 3)).toEqual({});
  });

  it('a capacity-only change never carries the menu', () => {
    const patch = buildSettingsPatch(base, { ...base, counterCapacity: 2 }, 3);
    expect(patch).not.toHaveProperty('printOptions');
    expect(patch).not.toHaveProperty('expectedPrintOptionsVersion');
  });
});

describe('coordinate sanity warning (OWN-10, UI only)', () => {
  it('warns for 0,0', () => expect(coordinateWarning(0, 0)).toMatch(/0, 0/));
  it('is quiet for a normal Indian location and for nulls', () => {
    expect(coordinateWarning(28.6139, 77.209)).toBeNull();
    expect(coordinateWarning(null, null)).toBeNull();
  });
  it('accepts locations anywhere in the world (no India-only check)', () => {
    expect(coordinateWarning(51.5, -0.12)).toBeNull();
    expect(coordinateWarning(-33.87, 151.21)).toBeNull();
    expect(coordinateWarning(40.7, -74)).toBeNull();
  });
});

describe('locationChangeNeedsReview', () => {
  const at = (latitude: number | null, longitude: number | null) => ({ ...base, latitude, longitude });
  it('is false for a ~100 m re-capture and for no change', () => {
    expect(locationChangeNeedsReview(at(28.6139, 77.209), at(28.6148, 77.209))).toBe(false);
    expect(locationChangeNeedsReview(at(28.6139, 77.209), at(28.6139, 77.209))).toBe(false);
  });
  it('is true for a ~200 m move or clearing the pin', () => {
    expect(locationChangeNeedsReview(at(28.6139, 77.209), at(28.6157, 77.209))).toBe(true);
    expect(locationChangeNeedsReview(at(28.6139, 77.209), at(null, null))).toBe(true);
  });
  it('is false when there was no pin before', () => {
    expect(locationChangeNeedsReview(at(null, null), at(28.6, 77.2))).toBe(false);
  });
});
