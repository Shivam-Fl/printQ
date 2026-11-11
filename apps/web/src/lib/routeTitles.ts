const BRAND = 'PrintQs';

const EXACT: Record<string, string> = {
  '/': 'PrintQs — skip the print queue',
  '/login': 'Sign in',
  '/home': 'Home',
  '/profile': 'Profile',
  '/jobs': 'My prints',
  '/shops': 'Find a print shop',
  '/dashboard/login': 'Shop sign in',
  '/dashboard/register': 'Register your shop',
  '/dashboard': 'Counter',
  '/dashboard/insights': 'Earnings',
  '/dashboard/earnings': 'Earnings',
  '/dashboard/history': 'Order history',
  '/dashboard/setup': 'Shop setup',
  '/dashboard/printers': 'Printers',
  '/dashboard/agents': 'Counter PC',
  '/dashboard/prices': 'Prices',
  '/dashboard/settings': 'Shop settings',
  '/admin/login': 'Admin sign in',
  '/admin': 'Admin console',
  '/privacy': 'Privacy policy',
  '/terms': 'Terms of service',
  '/refunds': 'Refund policy',
  '/support': 'Help and support',
  '/contact': 'Help and support',
  '/pc': 'Install PrintQs on your shop computer',
};

/** Document title for a route; unknown paths get the 404 title. */
export function titleForPath(pathname: string): string {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const exact = EXACT[clean];
  if (exact) return clean === '/' ? exact : `${exact} · ${BRAND}`;
  if (/^\/s\/[^/]+\/file\/[^/]+$/.test(clean)) return `Print settings · ${BRAND}`;
  if (/^\/s\/[^/]+$/.test(clean)) return `Print at this shop · ${BRAND}`;
  if (/^\/dashboard\/earnings\/receipt\/[^/]+$/.test(clean)) return `Fee receipt · ${BRAND}`;
  if (/^\/jobs\/[^/]+$/.test(clean)) return `Print status · ${BRAND}`;
  return `Page not found · ${BRAND}`;
}
