import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export interface EmailProvider {
  name: 'console' | 'resend';
  send(to: string, subject: string, text: string): Promise<void>;
}

/** Dev/pilot default — the request-reset route already logs the code to console. */
class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console' as const;

  async send(): Promise<void> {
    // no-op — see the "reset_code" console log at the call site
  }
}

/** Resend HTTP API — plain REST, no SDK, same style as the Razorpay/MSG91 providers. */
class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend' as const;

  async send(to: string, subject: string, text: string): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Resend email send failed (${res.status}): ${body}`);
    }
    logger.info({ to }, 'email_sent');
  }
}

export const emailProvider: EmailProvider =
  env.EMAIL_PROVIDER === 'resend' ? new ResendEmailProvider() : new ConsoleEmailProvider();
