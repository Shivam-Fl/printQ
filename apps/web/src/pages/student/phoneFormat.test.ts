import { describe, expect, it } from 'vitest';
import { caretAfterDigits, displayIndianPhone, spacedMobile } from './phoneFormat.js';

describe('phone display', () => {
  it('groups a mobile number 5 + 5 as it is typed', () => {
    expect(spacedMobile('')).toBe('');
    expect(spacedMobile('98100')).toBe('98100');
    expect(spacedMobile('981000')).toBe('98100 0');
    expect(spacedMobile('9810000003')).toBe('98100 00003');
  });

  it('leaves a still-prefixed number alone so typing can finish', () => {
    expect(spacedMobile('919810000003')).toBe('919810000003');
  });

  it('shows the stored +91 number spaced on Profile', () => {
    expect(displayIndianPhone('+916000012345')).toBe('+91 60000 12345');
    expect(displayIndianPhone('6000012345')).toBe('+91 60000 12345');
    expect(displayIndianPhone('+1 555 0100')).toBe('+1 555 0100');
  });

  it('keeps the caret after the same digit when the spacing moves', () => {
    expect(caretAfterDigits('98100 00003', 5)).toBe(5);
    expect(caretAfterDigits('98100 00003', 6)).toBe(7);
    expect(caretAfterDigits('98100 00003', 0)).toBe(0);
    expect(caretAfterDigits('98100', 9)).toBe(5);
  });
});
