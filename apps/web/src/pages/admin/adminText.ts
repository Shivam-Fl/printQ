/** Plain-language copy for the admin console, kept out of the component so it can be tested. */

export type ShopState = 'live' | 'campus_inactive' | 'hidden_by_admin' | 'rejected' | 'waiting_review' | 'setting_up';

export const SHOP_STATE_LABELS: Record<ShopState, { text: string; tone: 'green' | 'yellow' | 'red' | 'blue' }> = {
  live: { text: 'Live', tone: 'green' },
  campus_inactive: { text: 'Hidden: campus inactive', tone: 'yellow' },
  hidden_by_admin: { text: 'Hidden', tone: 'red' },
  rejected: { text: 'Rejected', tone: 'red' },
  waiting_review: { text: 'Waiting for review', tone: 'yellow' },
  setting_up: { text: 'Setting up', tone: 'blue' },
};

/** What a shop still in setup is missing, e.g. "location, printer, PC". Empty when nothing is. */
export function setupMissing(setup: { location: boolean; printerLinked: boolean; pcOnline: boolean }): string {
  const missing: string[] = [];
  if (!setup.location) missing.push('location');
  if (!setup.printerLinked) missing.push('printer');
  if (!setup.pcOnline) missing.push('PC online');
  return missing.join(', ');
}

const AUDIT_LABELS: Record<string, string> = {
  'shop.published': 'Published shop',
  'shop.unpublished': 'Unpublished shop',
  'shop.verified': 'Verified shop',
  'shop.rejected': 'Rejected shop',
  'shop.fee_block_lifted': 'Lifted fee block',
  'campus.created': 'Added campus',
  'campus.updated': 'Edited campus',
  'job.counter_payment_refunded': 'Recorded counter refund',
  admin_password_reset: 'Reset admin password',
};

/** "Deactivated campus" instead of "campus.updated". Unknown keys still read as words. */
export function auditLabel(event: { action: string; metadata?: unknown }): string {
  const meta = event.metadata && typeof event.metadata === 'object' ? (event.metadata as { active?: unknown; changed?: unknown }) : {};
  if (event.action === 'campus.updated' && Array.isArray(meta.changed) && meta.changed.includes('isActive')) {
    return meta.active ? 'Activated campus' : 'Deactivated campus';
  }
  return AUDIT_LABELS[event.action] ?? event.action.replace(/[._]+/g, ' ');
}

/** The reason typed with a decision (unpublish, fee lift, refund), if any. */
export function auditReason(event: { metadata?: unknown }): string | null {
  const reason = event.metadata && typeof event.metadata === 'object' ? (event.metadata as { reason?: unknown }).reason : null;
  return typeof reason === 'string' && reason ? reason : null;
}

/** Checked before sending, so blank or one-letter values never reach the server. */
export function campusFormProblem(name: string, address: string): string | null {
  if (name.trim().length < 2) return 'Enter the campus name (at least 2 letters).';
  if (address.trim().length < 3) return 'Enter the campus address (at least 3 letters).';
  return null;
}

/** Turn an API failure from a campus save into a sentence, never raw validation text. */
export function campusErrorMessage(err: unknown): string {
  const status = (err as { status?: number } | null)?.status;
  const path = (err as { body?: { details?: { path?: string }[] } } | null)?.body?.details?.[0]?.path ?? '';
  if (path.startsWith('name')) return 'Campus name should be 2 to 160 letters.';
  if (path.startsWith('address')) return 'Address should be 3 to 300 letters.';
  // 409 = duplicate name; the server already words it for people.
  if (status === 409 && err instanceof Error) return err.message;
  if (status === 404) return 'This campus no longer exists. Refresh the page.';
  return 'The campus could not be saved. Please try again.';
}
