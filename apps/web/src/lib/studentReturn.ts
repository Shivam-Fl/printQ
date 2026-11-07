/**
 * Where a student goes after signing in: back to the page that sent them to
 * /login (`?next=` or router state), else /home. Only same-site relative paths
 * are honoured — never another origin, a protocol-relative '//host', a
 * backslash trick or /login itself (that would loop).
 */
export function studentReturnPath(next: unknown): string {
  const fallback = '/home';
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return fallback;
  const base = 'https://printq.invalid';
  try {
    const url = new URL(next, base);
    if (url.origin !== base) return fallback;
    const path = `${url.pathname}${url.search}${url.hash}`;
    if (url.pathname === '/' || /^\/login(\/|$)/.test(url.pathname)) return fallback;
    return path;
  } catch {
    return fallback;
  }
}

/** The /login URL that brings the student back to `here` (pathname + search) after signing in. */
export function studentLoginPath(here: string): string {
  // already on /login (another guard got there first): keep its ?next
  if (/^\/login(?:[?#]|$)/.test(here)) return here;
  const back = studentReturnPath(here);
  return back === '/home' ? '/login' : `/login?next=${encodeURIComponent(back)}`;
}
