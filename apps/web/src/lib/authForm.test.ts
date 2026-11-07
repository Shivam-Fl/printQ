import { describe, expect, it } from 'vitest';
import {
  firstInvalid,
  isDuplicateEmailError,
  looksLikePin,
  maskEmail,
  REGISTER_FIELDS,
  validateShopRegister,
} from './authForm.js';

const valid = {
  shopName: 'Sharma Xerox',
  address: '12 Market Road',
  ownerName: 'Ramesh Sharma',
  email: 'ramesh@shop.com',
  password: 'counter-2026',
};

describe('validateShopRegister (M6)', () => {
  it('passes a complete form', () => {
    expect(validateShopRegister(valid)).toEqual({});
  });

  it('reports every problem at once, trimming spaces first', () => {
    const errors = validateShopRegister({ shopName: '  ', address: 'ab', ownerName: '   ', email: 'ramesh@gmail', password: 'abc1234' });
    expect(Object.keys(errors).sort()).toEqual(['address', 'email', 'ownerName', 'password', 'shopName']);
    expect(errors.password).toBe('Password must be at least 8 characters');
    expect(firstInvalid(REGISTER_FIELDS, errors)).toBe('shopName');
  });

  it('rejects a password of only spaces', () => {
    expect(validateShopRegister({ ...valid, password: '         ' }).password).toMatch(/spaces/);
  });

  it('refuses the same easy passwords the API refuses', () => {
    expect(validateShopRegister({ ...valid, password: '12345678' }).password).toMatch(/too easy to guess/);
    expect(validateShopRegister({ ...valid, password: 'Password@123' }).password).toMatch(/too easy to guess/);
  });

  it('accepts an email with surrounding spaces (the server trims it)', () => {
    expect(validateShopRegister({ ...valid, email: ' ramesh@shop.com ' }).email).toBeUndefined();
  });

  it('finds the first invalid field in form order', () => {
    expect(firstInvalid(REGISTER_FIELDS, { password: 'x', email: 'y' })).toBe('email');
    expect(firstInvalid(REGISTER_FIELDS, {})).toBeNull();
  });
});

describe('auth form helpers', () => {
  it('recognises the duplicate-email error (S29)', () => {
    expect(isDuplicateEmailError('An account with this email already exists')).toBe(true);
    expect(isDuplicateEmailError('Email is invalid')).toBe(false);
  });

  it('masks the email on the reset step (S31)', () => {
    expect(maskEmail('ramesh@shop.com')).toBe('r*****@shop.com');
    expect(maskEmail('a@b.co')).toBe('a**@b.co');
    expect(maskEmail('not-an-email')).toBe('not-an-email');
  });

  it('spots a staff PIN typed into the password box (S9)', () => {
    expect(looksLikePin('4821')).toBe(true);
    expect(looksLikePin('482193')).toBe(true);
    expect(looksLikePin('48219312')).toBe(false);
    expect(looksLikePin('abcd')).toBe(false);
  });
});
