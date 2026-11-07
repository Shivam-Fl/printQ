import { describe, expect, it } from 'vitest';
import {
  extractOtp,
  formatWait,
  isValidIndianMobile,
  normalizeIndianMobile,
  phoneHint,
  waitSecondsFromError,
} from './phone.js';

describe('normalizeIndianMobile', () => {
  it('strips +91 / 91 / 0 prefixes before cutting to 10 digits (QA M2)', () => {
    expect(normalizeIndianMobile('+91 98100 00003')).toBe('9810000003');
    expect(normalizeIndianMobile('+919810000003')).toBe('9810000003');
    expect(normalizeIndianMobile('09810000003')).toBe('9810000003');
    expect(normalizeIndianMobile('98100 00003')).toBe('9810000003');
    expect(normalizeIndianMobile('91 98100 00003')).toBe('9810000003');
    expect(normalizeIndianMobile('+91-98100-00003')).toBe('9810000003');
    expect(normalizeIndianMobile('(+91) 98100 00003')).toBe('9810000003');
  });

  it('strips stacked prefixes and keeps typo digits so the hint can flag them', () => {
    expect(normalizeIndianMobile('091 98600 00012')).toBe('9860000012');
    expect(normalizeIndianMobile('+91 0 98600 00012')).toBe('9860000012');
    // 11 national digits after the prefix: keep them so Send stays disabled.
    const typo = normalizeIndianMobile('+91 98600 000123');
    expect(typo).toBe('98600000123');
    expect(isValidIndianMobile(typo)).toBe(false);
    expect(phoneHint(typo, true)).toMatch(/more than 10 digits/);
    // A real 10-digit number that starts with 91 is left alone.
    expect(normalizeIndianMobile('9198100000')).toBe('9198100000');
    expect(normalizeIndianMobile('+91 91981 00000')).toBe('9198100000');
  });

  it('never turns a pasted +91 number into a different valid number', () => {
    // The old filter produced '91 98100 000' -> OTP sent to +919198100000.
    const result = normalizeIndianMobile('+91 98100 00003');
    expect(result).not.toBe('9198100000');
  });

  it('lets a prefixed number be typed one key at a time', () => {
    let field = '';
    for (const key of '+919810000003') field = normalizeIndianMobile(field + key);
    expect(field).toBe('9810000003');
    field = '';
    for (const key of '09810000003') field = normalizeIndianMobile(field + key);
    expect(field).toBe('9810000003');
  });

  it('caps a plain number at 10 digits, like the old maxlength', () => {
    expect(normalizeIndianMobile('98100000031')).toBe('9810000003');
    expect(normalizeIndianMobile('9810')).toBe('9810');
    expect(normalizeIndianMobile('')).toBe('');
  });

  it('keeps a real number that happens to start with 91', () => {
    expect(normalizeIndianMobile('9123456789')).toBe('9123456789');
    expect(isValidIndianMobile(normalizeIndianMobile('9123456789'))).toBe(true);
  });
});

describe('isValidIndianMobile', () => {
  it('accepts 10 digits starting 6-9 only', () => {
    expect(isValidIndianMobile('9810000003')).toBe(true);
    expect(isValidIndianMobile('6000000000')).toBe(true);
    expect(isValidIndianMobile('5810000003')).toBe(false);
    expect(isValidIndianMobile('981000000')).toBe(false);
    expect(isValidIndianMobile('0981000000')).toBe(false);
    expect(isValidIndianMobile('91981000000')).toBe(false);
  });
});

describe('phoneHint', () => {
  it('says nothing for an empty or valid number', () => {
    expect(phoneHint('', true)).toBeNull();
    expect(phoneHint('9810000003', true)).toBeNull();
  });

  it('explains a wrong first digit or too many digits straight away', () => {
    expect(phoneHint('5', false)).toMatch(/start with 6, 7, 8 or 9/);
    expect(phoneHint('91981000000', false)).toMatch(/more than 10 digits/);
  });

  it('waits until the student leaves the field before nagging about a short number', () => {
    expect(phoneHint('98100', false)).toBeNull();
    expect(phoneHint('98100', true)).toMatch(/10-digit/);
    expect(phoneHint('0981000000', true)).toMatch(/10-digit/);
  });
});

describe('extractOtp', () => {
  it('keeps typed digits and caps at 6', () => {
    expect(extractOtp('123')).toBe('123');
    expect(extractOtp('1234567')).toBe('123456');
  });

  it('accepts a pasted code with spaces or dashes (QA S10)', () => {
    expect(extractOtp('123 456')).toBe('123456');
    expect(extractOtp(' 123456 ')).toBe('123456');
    expect(extractOtp('123-456')).toBe('123456');
  });

  it('pulls the code out of a whole SMS', () => {
    expect(extractOtp('Your PrintQ code is 781432. It expires in 5 minutes.')).toBe('781432');
    expect(extractOtp('781432 is your verification code for printqs.com')).toBe('781432');
  });
});

describe('waitSecondsFromError', () => {
  it('uses Retry-After on a 429 when the client exposes it, else the wait in the message, else 60s', () => {
    expect(waitSecondsFromError({ status: 429, retryAfterSeconds: 42 })).toBe(42);
    expect(waitSecondsFromError({ status: 429, message: 'Too many attempts. Try again in 17 seconds.' })).toBe(17);
    expect(waitSecondsFromError({ status: 429, message: 'Too many attempts. Try again in about 3 minutes.' })).toBe(180);
    expect(waitSecondsFromError({ status: 429, message: 'Please wait a minute before requesting another code' })).toBe(60);
    expect(waitSecondsFromError({ status: 429 })).toBe(60);
  });

  it('reads the Firebase cooldown message', () => {
    expect(waitSecondsFromError(new Error('Please wait 37 seconds before requesting another code.'))).toBe(37);
  });

  it('ignores ordinary errors', () => {
    expect(waitSecondsFromError({ status: 400, message: 'Wrong code' })).toBeNull();
    expect(waitSecondsFromError(new Error('That code is incorrect.'))).toBeNull();
    expect(waitSecondsFromError(null)).toBeNull();
  });
});

describe('formatWait', () => {
  it('shows seconds under a minute and minutes above', () => {
    expect(formatWait(45)).toBe('45s');
    expect(formatWait(60)).toBe('1 min');
    expect(formatWait(3600)).toBe('60 min');
  });
});
