import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StorageDriver } from './index.js';

/**
 * Dev-only disk storage. Keys are server-generated UUIDs (never user input),
 * but resolve + prefix-check anyway so a bad key can never escape the root.
 */
export class LocalStorage implements StorageDriver {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) {
      throw new Error('Invalid storage key');
    }
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async getSignedUrl(): Promise<string | null> {
    return null; // caller streams through the API with its own auth checks
  }
}
