import { describe, expect, it } from 'vitest';
import { passwordHint, passwordHintClass } from './passwordHint.js';

describe('passwordHint (PSO-4 / PSLS-3)', () => {
  it('is neutral while the owner is still typing', () => {
    expect(passwordHint('')).toEqual({ state: 'empty', text: 'At least 8 characters. Avoid easy ones like 12345678.' });
    expect(passwordHint('abc')).toEqual({ state: 'short', text: 'At least 8 characters (5 more)' });
  });
  it('never shows a green tick for a password the API refuses', () => {
    for (const weak of ['12345678', 'password123', 'Password@123', '11111111']) {
      const hint = passwordHint(weak, 'New password');
      expect(hint.state).toBe('weak');
      expect(hint.text).toMatch(/^New password is too easy to guess/);
      expect(passwordHintClass(hint)).toBe('field-help password-rule bad');
    }
    expect(passwordHint('        ').state).toBe('weak');
  });
  it('turns green only for an accepted password', () => {
    const hint = passwordHint('chai4Ganesh');
    expect(hint).toEqual({ state: 'ok', text: '✓ Looks good' });
    expect(passwordHintClass(hint)).toBe('field-help password-rule ok');
    expect(passwordHintClass(passwordHint('abc'))).toBe('field-help password-rule');
  });
});
