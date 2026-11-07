/** Display helpers for Indian mobile numbers (the stored value stays plain digits). */

/** '9810000003' -> '98100 00003', the grouping people read numbers back in. Partial input is grouped as it grows. */
export function spacedMobile(national: string): string {
  // A number still carrying a 91 / 0 prefix while it is being typed is left as is.
  if (national.length > 10) return national;
  return `${national.slice(0, 5)} ${national.slice(5)}`.trim();
}

/** '+919810000003' (or '9810000003') -> '+91 98100 00003'. Anything else is shown unchanged. */
export function displayIndianPhone(phone: string): string {
  const match = /^(?:\+?91)?([6-9]\d{9})$/.exec(phone.replace(/[\s-]/g, ''));
  return match?.[1] ? `+91 ${spacedMobile(match[1])}` : phone;
}

/** Caret index in `formatted` that sits just after its `digits`-th digit (so typing mid-number keeps its place). */
export function caretAfterDigits(formatted: string, digits: number): number {
  if (digits <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < formatted.length; i += 1) {
    if (/\d/.test(formatted[i]!)) seen += 1;
    if (seen === digits) return i + 1;
  }
  return formatted.length;
}
