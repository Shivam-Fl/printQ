/** Small, pure helpers for the shop sign-up / sign-in forms (kept here so they are unit-tested). */
// subpath import: keeps zod (the schema bundle) off the sign-in and sign-up pages
import { passwordProblem } from '@printq/shared/password';

export const PASSWORD_MIN = 8;

export type RegisterField = 'shopName' | 'address' | 'ownerName' | 'email' | 'password';
export type RegisterForm = Record<RegisterField, string>;

/** Form order: the first invalid field in this list gets focus. */
export const REGISTER_FIELDS: RegisterField[] = ['shopName', 'address', 'ownerName', 'email', 'password'];

/**
 * The same rules the API applies (shopRegisterSchema), checked on tap so the
 * owner sees every problem at once instead of a greyed-out button. Values are
 * trimmed first: a name of only spaces is still empty.
 */
export function validateShopRegister(form: RegisterForm): Partial<Record<RegisterField, string>> {
  const errors: Partial<Record<RegisterField, string>> = {};
  const shopName = form.shopName.trim();
  const address = form.address.trim();
  const email = form.email.trim();
  if (!shopName) errors.shopName = 'Enter your shop name';
  else if (shopName.length < 2) errors.shopName = 'Shop name must be at least 2 characters';
  if (!address) errors.address = 'Enter your shop address';
  else if (address.length < 3) errors.address = 'Address must be at least 3 characters';
  if (!form.ownerName.trim()) errors.ownerName = 'Enter the owner’s name';
  if (!email) errors.email = 'Enter your email';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email, like owner@shop.com';
  if (!form.password) errors.password = 'Choose a password';
  else if (!form.password.trim()) errors.password = 'Password can’t be only spaces';
  else {
    // same rule as the API (length, and refuses easy ones like 12345678 or Password@123)
    const problem = passwordProblem(form.password);
    if (problem) errors.password = problem;
  }
  return errors;
}

export function firstInvalid<T extends string>(order: readonly T[], errors: Partial<Record<T, string>>): T | null {
  return order.find((field) => Boolean(errors[field])) ?? null;
}

/** The API says this when the email already has a shop account. */
export function isDuplicateEmailError(message: string): boolean {
  return /already (exists|registered|has)/i.test(message);
}

/** "ramesh@shop.com" -> "r*****@shop.com": enough to recognise, not enough to read over a shoulder. */
export function maskEmail(email: string): string {
  const value = email.trim();
  const at = value.lastIndexOf('@');
  if (at < 1) return value;
  const name = value.slice(0, at);
  return `${name[0]}${'*'.repeat(Math.max(2, Math.min(name.length - 1, 6)))}${value.slice(at)}`;
}

/** Staff sometimes type their 4-6 digit PIN into the password box. */
export function looksLikePin(value: string): boolean {
  return /^\d{4,6}$/.test(value.trim());
}
