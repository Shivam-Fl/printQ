import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export interface NotificationProvider {
  /** phone in E.164. Failures are logged, never thrown into the queue flow. */
  send(phone: string, text: string): Promise<void>;
}

/** Dev provider: prints the message instead of sending it. */
class ConsoleProvider implements NotificationProvider {
  async send(phone: string, text: string): Promise<void> {
    logger.info({ phone, text }, 'notification (console provider)');
  }
}

/** Meta WhatsApp Cloud API. Requires an approved WABA + template in production. */
class MetaWhatsAppProvider implements NotificationProvider {
  async send(phone: string, text: string): Promise<void> {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phone.replace('+', ''),
          type: 'text',
          text: { body: text },
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`WhatsApp send failed (${res.status}): ${body}`);
    }
  }
}

const provider: NotificationProvider =
  env.NOTIFICATION_PROVIDER === 'whatsapp' ? new MetaWhatsAppProvider() : new ConsoleProvider();

/**
 * Fire-and-log wrapper: a notification failure must never break a state
 * transition — the queue keeps moving, the failure is visible in logs.
 */
export async function notify(phone: string, text: string): Promise<void> {
  try {
    await provider.send(phone, text);
  } catch (err) {
    logger.error({ err, phone }, 'notification_failed');
  }
}
