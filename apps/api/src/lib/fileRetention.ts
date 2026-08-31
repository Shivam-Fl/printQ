import { env } from '../config/env.js';
import { prisma } from './prisma.js';

export const fileRetentionDeadline = (): Date =>
  new Date(Date.now() + env.FILE_RETENTION_HOURS * 3_600_000);

/**
 * Start the privacy-retention clock for a job's source file. Cleanup performs
 * one final active-job check before deleting, so reusing an upload is safe.
 */
export async function scheduleFileDeletion(fileId: string): Promise<void> {
  await prisma.uploadedFile.update({
    where: { id: fileId },
    data: { deleteAfter: fileRetentionDeadline() },
  });
}
