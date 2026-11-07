/** Windows installer for PrintQs Shop, the app that runs on the counter computer. */
export const WINDOWS_DOWNLOAD_URL =
  'https://github.com/Shivam-Fl/printqs-desktop/releases/latest/download/PrintQs-Shop-Setup.exe';

/** Public download page: short enough to type on the counter computer (printqs.com/pc). */
export const PC_PAGE_PATH = '/pc';

export function pcPageUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${PC_PAGE_PATH}`;
}

/** /pc on the site the owner is using now (printqs.com in production). */
export function currentPcPageUrl(): string {
  return pcPageUrl(typeof window === 'undefined' ? 'https://printqs.com' : window.location.origin);
}

/** The link as people type it: "printqs.com/pc", no scheme or www. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/^www\./, '');
}

/** A phone or tablet can't run the Windows app, so it should send the link to the PC instead. */
export function isPhoneLike(coarsePointer: boolean, userAgent: string): boolean {
  return coarsePointer || /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
}

export function detectPhoneLike(): boolean {
  try {
    return isPhoneLike(window.matchMedia?.('(pointer: coarse)').matches ?? false, navigator.userAgent);
  } catch {
    return false;
  }
}
