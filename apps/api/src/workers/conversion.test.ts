import { describe, expect, it } from 'vitest';
import { keysForDeletion } from './conversion.js';

describe('stored document deletion manifest', () => {
  it('includes every original and derivative exactly once', () => {
    expect(
      keysForDeletion({
        id: 'file-1',
        originalKey: 'orig/first.pdf',
        sources: [
          { key: 'orig/first.pdf', mime: 'application/pdf', name: 'first.pdf' },
          { key: 'orig/second.pdf', mime: 'application/pdf', name: 'second.pdf' },
        ],
        convertedKey: 'conv/normalized.pdf',
        previewKey: 'conv/normalized.pdf',
      }),
    ).toEqual(['orig/first.pdf', 'orig/second.pdf', 'conv/normalized.pdf']);
  });
});
