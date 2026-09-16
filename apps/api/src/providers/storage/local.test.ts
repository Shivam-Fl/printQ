import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalStorage } from './local.js';

let root: string | null = null;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe('local storage namespace', () => {
  it('places generated logical keys beneath the environment namespace', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'printq-storage-'));
    const storage = new LocalStorage(root, 'printq-test');
    await storage.put('orig/document.pdf', Buffer.from('safe'), 'application/pdf');

    await expect(readFile(path.join(root, 'printq-test', 'orig', 'document.pdf'), 'utf8')).resolves.toBe('safe');
    await expect(access(path.join(root, 'orig', 'document.pdf'))).rejects.toBeTruthy();
  });
});
