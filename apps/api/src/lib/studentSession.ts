import { prisma } from './prisma.js';
import type { StudentClaims } from './tokens.js';

/**
 * A student JWT is only a claim: the student must still exist and the token
 * must carry the student's current session version (sign-out bumps it).
 * Tokens issued before versions existed carry no `sv` and count as version 0.
 *
 * Unlike the shop session (one uncached lookup per request), the version is
 * remembered in-process for a short time: student endpoints such as check-in
 * and placing an order are hot paths with round-trip budgets (see the
 * *.perf.db.test.ts files), and an extra database round trip on every request
 * is what those budgets exist to prevent. Sign-out updates the remembered
 * version immediately, so in this single-process deployment revocation is
 * instant; a second API process would pick it up within SESSION_MEMORY_MS.
 */
const SESSION_MEMORY_MS = 5 * 60_000;
const MAX_REMEMBERED = 10_000;
const remembered = new Map<string, { version: number; at: number }>();

function remember(studentId: string, version: number): void {
  const current = remembered.get(studentId);
  // Versions only go up: a read that started before a sign-out must never undo it.
  if (current && current.version > version) return;
  remembered.delete(studentId);
  remembered.set(studentId, { version, at: Date.now() });
  if (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value as string);
}

/** Called by sign-out after the version is bumped, so old tokens fail on the very next request. */
export function rememberStudentSignOut(studentId: string, newVersion: number): void {
  remember(studentId, newVersion);
}

export async function resolveStudentSession(claims: StudentClaims): Promise<{ id: string } | null> {
  const wanted = claims.sv ?? 0;
  const hit = remembered.get(claims.sub);
  if (hit && Date.now() - hit.at < SESSION_MEMORY_MS) return hit.version === wanted ? { id: claims.sub } : null;
  const student = await prisma.student.findUnique({
    where: { id: claims.sub },
    select: { id: true, sessionVersion: true },
  });
  if (!student) {
    remembered.delete(claims.sub);
    return null;
  }
  remember(student.id, student.sessionVersion);
  return student.sessionVersion === wanted ? { id: student.id } : null;
}
