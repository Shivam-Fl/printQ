/**
 * Single source of truth for everything the public legal / support pages say
 * about WHO runs PrintQs and HOW to reach them.
 *
 * Anything set to `null` has not been supplied by the owner yet. The pages
 * never invent a value: a null field is hidden (or replaced by an honest
 * "being added" line). Fill these in before launch and have a lawyer review
 * the policy text in `pages/legal/`.
 */

export const LEGAL_PRODUCT_NAME = 'PrintQs';

/** Shown at the top of every policy page. ISO date, rendered as written. */
export const LEGAL_LAST_UPDATED = '2026-10-10';

// TODO(owner): registered legal entity name (company or proprietor name).
export const LEGAL_ENTITY_NAME: string | null = null;

// TODO(owner): registered office / business address.
export const LEGAL_REGISTERED_ADDRESS: string | null = null;

// TODO(owner): a support mailbox that actually exists and is monitored.
export const SUPPORT_EMAIL: string | null = null;

// TODO(owner): support phone number, if you want one published.
export const SUPPORT_PHONE: string | null = null;

// TODO(owner): published support hours, e.g. "Mon-Sat, 10am-6pm IST".
export const SUPPORT_HOURS: string | null = null;

// TODO(owner): Grievance Officer under the Information Technology Rules, 2021.
export const GRIEVANCE_OFFICER_NAME: string | null = null;
// TODO(owner): mailbox for the Grievance Officer (falls back to SUPPORT_EMAIL).
export const GRIEVANCE_OFFICER_EMAIL: string | null = null;

// TODO(owner): city whose courts have jurisdiction (governing-law clause).
export const GOVERNING_LAW_CITY: string | null = null;

/** Published policy pages, in footer order. */
export const LEGAL_LINKS = [
  { to: '/privacy', label: 'Privacy' },
  { to: '/terms', label: 'Terms' },
  { to: '/refunds', label: 'Refunds' },
  { to: '/support', label: 'Support' },
] as const;

export function supportEmailHref(): string | null {
  return SUPPORT_EMAIL ? `mailto:${SUPPORT_EMAIL}` : null;
}

export function grievanceEmail(): string | null {
  return GRIEVANCE_OFFICER_EMAIL ?? SUPPORT_EMAIL;
}
