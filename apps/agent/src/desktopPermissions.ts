/**
 * Permission policy for the shop dashboard window. Device location is what lets
 * first-run setup pin the shop automatically, so it is granted to the trusted
 * PrintQs pages only; every other permission keeps Electron's previous default (granted).
 */
export function shouldGrantPermission(
  permission: string,
  requestingUrl: string,
  isTrustedUrl: (url: string) => boolean,
): boolean {
  if (permission === 'geolocation') return isTrustedUrl(requestingUrl);
  return true;
}
