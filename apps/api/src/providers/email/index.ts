import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export interface EmailProvider {
  name: 'console' | 'resend';
  send(to: string, subject: string, text: string): Promise<{ providerMessageId?: string }>;
}

/** Dev/pilot default — the request-reset route already logs the code to console. */
class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console' as const;

  async send(): Promise<{ providerMessageId?: string }> {
    // Intentionally no-op: reset codes are never written to a console/log.
    return {};
  }
}

/** Resend HTTP API — plain REST, no SDK, same style as the Razorpay/MSG91 providers. */
class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend' as const;

  async send(to: string, subject: string, text: string): Promise<{ providerMessageId?: string }> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Do not include provider response bodies in logs/errors: they can
      // contain recipient or request metadata and are not needed to retry.
      throw new Error(`Resend email send failed (${res.status})`);
    }
    const payload = (await res.json().catch(() => ({}))) as { id?: unknown };
    const providerMessageId = typeof payload.id === 'string' ? payload.id : undefined;
    logger.info({ provider: this.name, accepted: true }, 'email_sent');
    return { providerMessageId };
  }
}

export const emailProvider: EmailProvider =
  env.EMAIL_PROVIDER === 'resend' ? new ResendEmailProvider() : new ConsoleEmailProvider();
