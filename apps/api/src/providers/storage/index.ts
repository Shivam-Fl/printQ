import { env } from '../../config/env.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';

export interface StorageDriver {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /**
   * Presigned direct URL when the backend supports it (s3); null means the
   * caller must stream the bytes through the API instead (local driver).
   */
  getSignedUrl(key: string, expiresSeconds: number): Promise<string | null>;
}

export const storage: StorageDriver =
  env.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage(env.STORAGE_LOCAL_DIR);
