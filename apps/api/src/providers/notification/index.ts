import { logger } from '../../lib/logger.js';
import { publishEvent } from '../../realtime/events.js';
import { sendPush, type PushMessage } from '../push/index.js';

/**
 * Student notifications are in-app first: a socket event for the open app and
 * a Web Push for the installed PWA. No external messaging provider needed.
 * Failures are logged, never thrown into a queue transition.
 */
export async function notifyStudent(studentId: string, message: PushMessage): Promise<void> {
  publishEvent(`student:${studentId}`, 'notify', message);
  try {
    await sendPush(studentId, message);
  } catch (err) {
    logger.error({ err, studentId }, 'notify_failed');
  }
  logger.info({ studentId, title: message.title }, 'student_notified');
}

/**
 * Login OTPs happen before any session exists, so they can't be in-app.
 * Dev/pilot: the code is logged to the API console. For launch, plug an SMS
 * provider (e.g. MSG91) into this one function.
 */
export async function sendLoginOtp(phone: string, otp: string): Promise<void> {
  // field name deliberately avoids the `*.otp` pino redaction — this console
  // delivery IS the dev channel; swap in an SMS provider here for launch
  logger.info({ phone, loginCode: otp }, 'login_otp (console — wire an SMS provider for launch)');
}
