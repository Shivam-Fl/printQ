// subpath import: keeps zod (the schema bundle) off the sign-in and sign-up pages
import { passwordProblem } from '@printq/shared/password';
import { PASSWORD_MIN } from './authForm.js';

/** empty / short while typing, weak when the API would refuse it, ok only when it would be accepted. */
export type PasswordHintState = 'empty' | 'short' | 'weak' | 'ok';

export interface PasswordHint {
  state: PasswordHintState;
  text: string;
}

/**
 * The live line under a new-password box (register and reset). Uses the same passwordProblem()
 * rule as the API, so a password that will be refused (12345678, password123) never gets a green tick.
 */
export function passwordHint(password: string, label = 'Password'): PasswordHint {
  if (!password) return { state: 'empty', text: 'At least 8 characters. Avoid easy ones like 12345678.' };
  const left = PASSWORD_MIN - password.trim().length;
  if (password.trim() && left > 0) return { state: 'short', text: `At least 8 characters (${left} more)` };
  const problem = passwordProblem(password, label);
  return problem ? { state: 'weak', text: problem } : { state: 'ok', text: '✓ Looks good' };
}

/** Class list for the hint span: green when ok, red when weak (.password-rule.bad). */
export function passwordHintClass(hint: PasswordHint): string {
  return `field-help password-rule${hint.state === 'ok' ? ' ok' : hint.state === 'weak' ? ' bad' : ''}`;
}
