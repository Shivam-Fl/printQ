import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ info: vi.fn() }));

vi.mock('../../config/env.js', () => ({
  env: {
    EMAIL_PROVIDER: 'resend',
    RESEND_API_KEY: 'resend-test-key-that-is-long-enough',
    EMAIL_FROM: 'PrintQs <security@printqs.test>',
  },
}));
vi.mock('../../lib/logger.js', () => ({ logger: { info: mocks.info } }));

const { emailProvider } = await import('./index.js');

describe('Resend password-reset delivery', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the authenticated Resend endpoint and records only its non-secret delivery id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'email-provider-id' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(emailProvider.send(
      'owner@example.test',
      'Reset your PrintQ password',
      'A six-digit code belongs only in this message body.',
    )).resolves.toEqual({ providerMessageId: 'email-provider-id' });

    expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer resend-test-key-that-is-long-enough' }),
    }));
    expect(mocks.info).toHaveBeenCalledWith({ provider: 'resend', accepted: true }, 'email_sent');
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain('owner@example.test');
  });

  it('does not expose a provider response body when delivery fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('recipient metadata must not escape', { status: 422 })));

    await expect(emailProvider.send('owner@example.test', 'subject', 'code')).rejects.toThrow(
      'Resend email send failed (422)',
    );
  });
});
