import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { publishEvent } from '../../realtime/events.js';
import { fcmEnabled } from '../fcm/index.js';
import { enqueueFirebaseNotification, publishPendingFirebaseNotifications } from '../fcm/outbox.js';
import { sendPush, type PushMessage } from '../push/index.js';
import { smsProvider } from '../sms/index.js';

/**
 * Student notifications are in-app first: a socket event for the open app and
 * FCM is the primary installed-PWA delivery channel when explicitly enabled;
 * legacy Web Push remains a development-safe fallback until every client has
 * migrated. Failures never break an authoritative queue transition.
 */
export async function notifyStudent(studentId: string, message: PushMessage): Promise<void> {
  publishEvent(`student:${studentId}`, 'notify', message);
  try {
    if (fcmEnabled) {
      await enqueueFirebaseNotification(studentId, message);
      await publishPendingFirebaseNotifications(1);
    } else {
      await sendPush(studentId, message);
    }
  } catch (err) {
    logger.error({ err, studentId }, 'notify_failed');
  }
  logger.info({ studentId, title: message.title }, 'student_notified');
}

/**
 * Login OTPs happen before any session exists, so they can't be in-app.
 * The code always goes to the API console (dev visibility + what e2e/proof
 * scripts read); SMS delivery is layered on via the pluggable SmsProvider —
 * set SMS_PROVIDER=msg91 (+ MSG91_* env vars) for real launch delivery.
 */
export async function sendLoginOtp(phone: string, otp: string): Promise<void> {
  // The code is visible only for the explicit console/dev provider. Never put
  // a real production MSG91 code in logs.
  if (env.NODE_ENV !== 'production' || smsProvider.name === 'console') {
    // field name deliberately avoids the `*.otp` pino redaction in local E2E
    logger.info({ phone, loginCode: otp }, 'login_otp');
  }
  try {
    await smsProvider.sendOtp(phone, otp);
  } catch (err) {
    logger.error({ err, phone }, 'sms_otp_send_failed');
    throw new Error('Could not send the verification code');
  }
}
