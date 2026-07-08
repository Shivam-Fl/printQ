import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export interface SmsProvider {
  name: 'console' | 'msg91';
  sendOtp(phone: string, otp: string): Promise<void>;
}

/** Dev/pilot default — sendLoginOtp's console log IS the delivery channel. */
class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console' as const;

  async sendOtp(): Promise<void> {
    // no-op — see providers/notification/index.ts's sendLoginOtp console log
  }
}

/** MSG91 (India SMS gateway) OTP API — no SDK dependency needed. */
class Msg91SmsProvider implements SmsProvider {
  readonly name = 'msg91' as const;

  async sendOtp(phone: string, otp: string): Promise<void> {
    const res = await fetch('https://control.msg91.com/api/v5/otp', {
      method: 'POST',
      headers: { authkey: env.MSG91_AUTH_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template_id: env.MSG91_TEMPLATE_ID,
        sender: env.MSG91_SENDER_ID,
        mobile: phone.replace('+', ''),
        otp,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`MSG91 OTP send failed (${res.status}): ${body}`);
    }
    logger.info({ phone }, 'sms_otp_sent');
  }
}

export const smsProvider: SmsProvider =
  env.SMS_PROVIDER === 'msg91' ? new Msg91SmsProvider() : new ConsoleSmsProvider();
