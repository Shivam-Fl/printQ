import { describe, expect, it } from 'vitest';
import { unsupportedSpecs } from './capability.js';

const specs = { copies: 1, paperSize: 'a4', color: false, duplex: false, binding: null, pageRange: null };
const bw = { paperSizesLoaded: ['a4'], colorSupport: false, finishingOptions: [] as string[] };
const colour = { paperSizesLoaded: ['a4', 'a3'], colorSupport: true, finishingOptions: ['stapling'] };

describe('unsupportedSpecs', () => {
  it('producible jobs report nothing', () => {
    expect(unsupportedSpecs([bw], specs)).toEqual([]);
    expect(unsupportedSpecs([bw, colour], { ...specs, color: true, paperSize: 'a3', binding: 'stapling' })).toEqual([]);
  });
  it('flags colour when no printer supports it, with friendly text', () => {
    const r = unsupportedSpecs([bw], { ...specs, color: true });
    expect(r.map((x) => x.code)).toEqual(['color']);
    expect(r[0]!.message).toMatch(/colour/);
  });
  it('flags paper size and binding', () => {
    expect(unsupportedSpecs([bw], { ...specs, paperSize: 'a3' }).map((x) => x.code)).toEqual(['paper_size']);
    expect(unsupportedSpecs([bw], { ...specs, binding: 'spiral_binding' })[0]!.message).toContain('spiral binding');
  });
  it('flags a combination no single printer can do', () => {
    // a3 only on the colour machine, colour+binding fine there, but a4 colour needs...
    const mono = { paperSizesLoaded: ['a3'], colorSupport: false, finishingOptions: [] as string[] };
    const colourA4 = { paperSizesLoaded: ['a4'], colorSupport: true, finishingOptions: [] as string[] };
    expect(unsupportedSpecs([mono, colourA4], { ...specs, paperSize: 'a3', color: true }).map((x) => x.code)).toEqual(['combination']);
  });
  it('an empty printer list is not judged here (shop-operational checks cover it)', () => {
    expect(unsupportedSpecs([], specs)).toEqual([]);
  });
});
