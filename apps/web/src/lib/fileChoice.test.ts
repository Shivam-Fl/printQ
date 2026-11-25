import { describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES, fileKind, fitToRoom, formatBytes, localFileProblem } from './fileChoice.js';

describe('checking chosen files before upload', () => {
  it('recognises printable kinds by extension, and camera photos without a name', () => {
    expect(fileKind('Notes.PDF')).toBe('pdf');
    expect(fileKind('lab.docx')).toBe('word');
    expect(fileKind('IMG_1.jpeg')).toBe('image');
    expect(fileKind('scan', 'image/jpeg')).toBe('image');
    expect(fileKind('old.doc')).toBeNull();
  });

  it('explains each problem in plain words', () => {
    expect(localFileProblem({ name: 'a.pdf', size: 10 })).toBeNull();
    expect(localFileProblem({ name: 'old.doc', size: 10 })).toMatch(/\.docx or PDF/);
    expect(localFileProblem({ name: 'photo.heic', size: 10 })).toMatch(/HEIC/);
    expect(localFileProblem({ name: 'slides.pptx', size: 10 })).toMatch(/Only PDF/);
    expect(localFileProblem({ name: 'a.pdf', size: 0 })).toBe('This file is empty.');
    expect(localFileProblem({ name: 'a.pdf', size: MAX_FILE_BYTES + 1 })).toMatch(/up to 25 MB/);
  });

  it('formats sizes and keeps an order within 15 files', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
    expect(fitToRoom([1, 2, 3], 13)).toEqual({ take: [1, 2], overflow: 1 });
    expect(fitToRoom([1], 15)).toEqual({ take: [], overflow: 1 });
  });
});
