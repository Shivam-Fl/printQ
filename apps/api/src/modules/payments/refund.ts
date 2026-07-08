import type { Job } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { paymentProvider } from '../../providers/payment/index.js';

/**
 * A job that was paid for but never got printed (cancelled by the student, or
 * expired after a no-show with no requeue) owes the student their money back.
 * Idempotent: only acts on jobs still marked `paid`.
 */
export async function refundIfPaid(job: Job): Promise<void> {
  if (job.paymentStatus !== 'paid' || !job.paymentId) return;

  try {
    await paymentProvider.refund(job.paymentId, job.totalPaise);
  } catch (err) {
    logger.error({ err, jobId: job.id }, 'refund_provider_call_failed');
    return;
  }

  const marked = await prisma.job.updateMany({
    where: { id: job.id, paymentStatus: 'paid' },
    data: { paymentStatus: 'refunded' },
  });
  if (marked.count === 0) return; // already refunded by a concurrent call

  await prisma.paymentEvent
    .create({
      data: {
        provider: job.paymentProvider ?? 'unknown',
        providerEventId: `refund_${job.id}`,
        jobId: job.id,
        payload: { refunded: true, amountPaise: job.totalPaise },
      },
    })
    .catch((err) => logger.warn({ err, jobId: job.id }, 'refund_event_log_failed'));

  logger.info({ jobId: job.id, amountPaise: job.totalPaise }, 'job_refunded');
}
