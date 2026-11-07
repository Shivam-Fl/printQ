/**
 * The shared password rule, kept free of zod so the web sign-up and reset
 * forms can use it without pulling the whole schema bundle onto the page.
 */

/**
 * Guessable at a glance: all one character or a short repeated chunk
 * (11111111, 12121212, 12341234), a straight run (12345678, abcdefgh,
 * 87654321, 1234567890), or a common word with digits/symbols stuck on
 * (password, Password@123, p@ssw0rd, printqs123, admin@123).
 */
const COMMON_PASSWORD_WORDS = new Set([
  'password', 'passwd', 'printq', 'printqs', 'qwerty', 'qwertyui', 'qwertyuiop', 'asdfgh', 'asdfghjk',
  'zxcvbnm', 'admin', 'welcome', 'iloveyou', 'letmein', 'india', 'xerox',
]);
const COMMON_PASSWORDS = new Set(['abcd1234', '1234abcd', 'qwer1234', 'asdf1234', '1q2w3e4r', 'zaq12wsx']);

function isStraightRun(value: string): boolean {
  // digits wrap (…7890), so 1234567890 and 0987654321 count as runs too
  const step = (a: string, b: string) => {
    const diff = b.charCodeAt(0) - a.charCodeAt(0);
    if (!/\d/.test(a) || !/\d/.test(b)) return diff;
    const wrapped = (diff + 10) % 10;
    return wrapped === 1 ? 1 : wrapped === 9 ? -1 : 0;
  };
  const first = step(value[0]!, value[1]!);
  if (first !== 1 && first !== -1) return false;
  for (let i = 2; i < value.length; i += 1) if (step(value[i - 1]!, value[i]!) !== first) return false;
  return true;
}

export function isWeakPassword(password: string): boolean {
  const value = password.trim().toLowerCase();
  if (value.length < 2) return true;
  if (/^(.{1,4})\1+$/.test(value)) return true;
  if (isStraightRun(value) || COMMON_PASSWORDS.has(value)) return true;
  const word = value
    .replace(/^[^a-z]+|[^a-z]+$/g, '')
    .replace(/[@4]/g, 'a')
    .replace(/0/g, 'o')
    .replace(/[$5]/g, 's')
    .replace(/3/g, 'e')
    .replace(/1/g, 'i');
  return COMMON_PASSWORD_WORDS.has(word);
}

/**
 * The one password rule for sign-up and reset (login only needs a non-empty
 * value). Returns the plain-language problem, or null when the password is ok.
 * `label` names the field, e.g. "New password" on the reset form.
 */
export function passwordProblem(password: string, label = 'Password'): string | null {
  if (!password) return `${label} is required`;
  if (!password.trim()) return `${label} cannot be only spaces`;
  if (password.trim().length < 8) return `${label} must be at least 8 characters`;
  if (password.length > 128) return `${label} must be at most 128 characters`;
  if (isWeakPassword(password)) {
    return `${label} is too easy to guess. Avoid things like 12345678, abcdefgh or "password" — mix letters and numbers.`;
  }
  return null;
}
