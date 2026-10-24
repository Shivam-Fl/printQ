/**
 * Permission policy for the shop dashboard window: default-deny. Device location
 * lets first-run setup pin the shop automatically; notifications and clipboard
 * writes are what the dashboard already uses. Everything else is refused, and
 * only for the origins the caller passes as trusted.
 */
const ALLOWED_PERMISSIONS = new Set([
  'geolocation',
  'notifications',
  'clipboard-sanitized-write',
  'fullscreen',
]);

export function shouldGrantPermission(
  permission: string,
  requestingUrl: string,
  isTrustedUrl: (url: string) => boolean,
): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && isTrustedUrl(requestingUrl);
}
