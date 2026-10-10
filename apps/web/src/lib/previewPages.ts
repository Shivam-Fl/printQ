import { parsePageRange } from '@printq/shared';

/**
 * The 1-based pages of the document the order will actually print. A missing
 * or unparsable range falls back to the whole document so the preview never
 * goes blank because of a half-typed range.
 */
export function selectedPreviewPages(totalPages: number, pageRange: string | null): number[] {
  const all = Array.from({ length: Math.max(0, totalPages) }, (_, i) => i + 1);
  if (!pageRange) return all;
  try {
    return parsePageRange(pageRange, totalPages);
  } catch {
    return all;
  }
}

export const PREVIEW_ZOOM_STEPS = [1, 1.5, 2, 3] as const;

/** CSS pixel width a page is drawn at for a container width and zoom step. */
export function previewPageWidth(containerWidth: number, zoom: number): number {
  return Math.max(120, Math.floor(containerWidth * zoom));
}
