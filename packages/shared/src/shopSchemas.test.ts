import { describe, expect, it } from 'vitest';
import { isWeakPassword, passwordProblem } from './password.js';
import {
  confirmPasswordResetSchema,
  printOptionsSchema,
  shopLoginSchema,
  shopRegisterSchema,
  staffLoginSchema,
} from './schemas.js';

describe('printOptionsSchema pricing sanity (OWN-11)', () => {
  const menu = (over: Record<string, unknown> = {}) => ({
    papers: [{ id: 'A4', label: 'A4', bwPaise: 200, colorPaise: 1000 }],
    bindings: [{ id: 'stapling', label: 'Stapling', paise: 0 }],
    duplexEnabled: true,
    ...over,
  });
  const issues = (value: unknown) => {
    const r = printOptionsSchema.safeParse(value);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it('accepts a normal menu and a B/W-only paper', () => {
    expect(printOptionsSchema.safeParse(menu()).success).toBe(true);
    expect(printOptionsSchema.safeParse(menu({ papers: [{ id: 'A4', label: 'A4', bwPaise: 200, colorPaise: null }] })).success).toBe(true);
  });
  it('rejects duplicate paper ids (case-insensitive)', () => {
    const papers = [
      { id: 'A4', label: 'A4', bwPaise: 200, colorPaise: null },
      { id: 'a4', label: 'A4 again', bwPaise: 300, colorPaise: null },
    ];
    expect(issues(menu({ papers })).join()).toMatch(/duplicate paper/i);
  });
  it('rejects duplicate binding ids', () => {
    const bindings = [{ id: 'spiral', label: 'Spiral', paise: 3000 }, { id: 'spiral', label: 'Spiral 2', paise: 100 }];
    expect(issues(menu({ bindings })).join()).toMatch(/duplicate binding/i);
  });
  it('rejects a colour price below the B/W price', () => {
    const papers = [{ id: 'A4', label: 'A4', bwPaise: 500, colorPaise: 200 }];
    expect(issues(menu({ papers })).join()).toMatch(/colou?r price/i);
  });
  it('rejects more than Rs 100 per page and more than Rs 1000 for a binding', () => {
    expect(issues(menu({ papers: [{ id: 'A4', label: 'A4', bwPaise: 10_001, colorPaise: null }] })).length).toBeGreaterThan(0);
    expect(issues(menu({ papers: [{ id: 'A4', label: 'A4', bwPaise: 200, colorPaise: 10_001 }] })).length).toBeGreaterThan(0);
    expect(printOptionsSchema.safeParse(menu({ papers: [{ id: 'A4', label: 'A4', bwPaise: 10_000, colorPaise: 10_000 }] })).success).toBe(true);
    expect(issues(menu({ bindings: [{ id: 'x', label: 'X', paise: 100_001 }] })).length).toBeGreaterThan(0);
  });
  it('rejects the reserved binding id "none"', () => {
    expect(issues(menu({ bindings: [{ id: 'none', label: 'None', paise: 0 }] })).join()).toMatch(/none/i);
    expect(issues(menu({ bindings: [{ id: ' None ', label: 'None', paise: 0 }] })).join()).toMatch(/none/i);
  });
});

describe('shop registration messages name the field (OWN-12)', () => {
  const ok = { shopName: 'Test Shop', address: '12 Lane', ownerName: 'Owner', email: 'a@b.co', password: 'longenough' };
  const msg = (over: Record<string, unknown>) => {
    const r = shopRegisterSchema.safeParse({ ...ok, ...over });
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  };
  it('accepts a valid body', () => expect(msg({})).toEqual([]));
  it('names email', () => expect(msg({ email: 'nope' })).toEqual(['email: Email is invalid']));
  it('names password length', () => expect(msg({ password: 'short' })).toEqual(['password: Password must be at least 8 characters']));
  it('names the other fields', () => {
    expect(msg({ shopName: ' ' })).toEqual(['shopName: Shop name must be at least 2 characters']);
    expect(msg({ address: 'ab' })).toEqual(['address: Address must be at least 3 characters']);
    expect(msg({ ownerName: '' })).toEqual(['ownerName: Owner name is required']);
  });
  it('names a missing field rather than "Required"', () => {
    const r = shopRegisterSchema.safeParse({ ...ok, email: undefined });
    expect(r.success ? '' : r.error.issues[0]!.message).toBe('Email is required');
  });
});

describe('shop password rule (S3) and plain login messages (S9)', () => {
  const regIssues = (password: unknown) => {
    const r = shopRegisterSchema.safeParse({ shopName: 'Test Shop', address: '12 Lane', ownerName: 'Owner', email: 'a@b.co', password });
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  };

  it.each([
    '12345678', '87654321', '1234567890', '0987654321', 'abcdefgh', 'ABCDEFGH', '11111111', 'aaaaaaaa',
    '12121212', '12341234', 'password', 'Password', 'password1', 'Password@123', 'p@ssw0rd', 'PASSWORD!',
    'printqs', 'PrintQs@123', 'printq2026', 'qwertyuiop', 'qwerty123', 'admin@123', 'India@123', 'abcd1234',
  ])('rejects the guessable password %j', (pw) => {
    expect(isWeakPassword(pw)).toBe(true);
    const problem = passwordProblem(pw);
    expect(problem).not.toBeNull();
    expect(problem).toMatch(/^Password /);
  });

  it.each(['Ganesh Xerox 21', 'correct-horse-1', 'Sharma@Copy9', 'longenough', 'Corner-print-42', '9810-ravi-copy'])(
    'accepts the ordinary password %j',
    (pw) => {
      expect(isWeakPassword(pw)).toBe(false);
      expect(passwordProblem(pw)).toBeNull();
      expect(regIssues(pw)).toEqual([]);
    },
  );

  it('rejects whitespace-only and too-short-after-trim passwords with one plain message', () => {
    expect(regIssues('        ')).toEqual(['password: Password cannot be only spaces']);
    expect(regIssues('  abc12  ')).toEqual(['password: Password must be at least 8 characters']);
    expect(regIssues('short')).toEqual(['password: Password must be at least 8 characters']);
    expect(regIssues('1234')).toEqual(['password: Password must be at least 8 characters']);
    expect(regIssues('12345678')).toHaveLength(1);
    expect(regIssues('x'.repeat(129))).toEqual(['password: Password must be at most 128 characters']);
  });

  it('applies the same rule to reset, named "New password"', () => {
    const reset = (newPassword: unknown) => {
      const r = confirmPasswordResetSchema.safeParse({ email: 'a@b.co', otp: '123456', newPassword });
      return r.success ? [] : r.error.issues.map((i) => i.message);
    };
    expect(reset('Corner-print-42')).toEqual([]);
    expect(reset('12345678')[0]).toMatch(/^New password is too easy to guess/);
    expect(reset('        ')).toEqual(['New password cannot be only spaces']);
    expect(reset('short')).toEqual(['New password must be at least 8 characters']);
    expect(reset(undefined)).toEqual(['New password is required']);
  });

  it('login only needs a non-empty password — never raw zod text', () => {
    const login = (body: Record<string, unknown>) => {
      const r = shopLoginSchema.safeParse(body);
      return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    };
    // a staff PIN typed in the password box is a wrong password, not a schema error
    expect(login({ email: 'staff@shop.co', password: '4821' })).toEqual([]);
    expect(login({ email: 'Owner@Shop.co ', password: 'x' })).toEqual([]);
    expect(login({ email: 'owner@shop.co', password: '' })).toEqual(['password: Enter your password']);
    expect(login({ email: 'owner@shop.co' })).toEqual(['password: Enter your password']);
    expect(login({ email: 'nope', password: 'whatever1' })).toEqual(['email: Enter a valid email address']);
    expect(login({ password: 'whatever1' })).toEqual(['email: Enter your email']);
    expect(login({ email: 'a@b.co', password: 'x'.repeat(129) })).toEqual(['password: Password must be at most 128 characters']);
  });

  it('staff PIN login and reset-code messages are plain', () => {
    const pin = staffLoginSchema.safeParse({ email: 'staff@shop.co' });
    expect(pin.success ? [] : pin.error.issues.map((i) => i.message)).toEqual(['Enter your PIN']);
    const code = confirmPasswordResetSchema.safeParse({ email: 'a@b.co', otp: '12', newPassword: 'Corner-print-42' });
    expect(code.success ? [] : code.error.issues.map((i) => i.message)).toEqual(['Code is 6 digits']);
  });
});
