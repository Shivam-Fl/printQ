import { describe, expect, it } from 'vitest';
import { passwordResetEmail } from './routes.js';

describe('password reset email (PSLS-8 / PA-3)', () => {
  it('uses the PrintQs brand and tells someone who did not ask that they can ignore it', () => {
    const [subject, text] = passwordResetEmail('123456');
    expect(subject).toBe('Reset your PrintQs password');
    expect(text).toContain('Your PrintQs password reset code is 123456. It expires in 15 minutes.');
    expect(text).toContain("Didn't ask for this? You can ignore this email.");
    expect(`${subject}\n${text}`).not.toMatch(/PrintQ(?!s)/);
  });
});
