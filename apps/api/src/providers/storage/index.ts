import { env } from '../../config/env.js';
import { GcsStorage } from './gcs.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';

export interface StorageDriver {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /**
   * Presigned direct URL when the backend supports it (S3/GCS); null means the
   * caller must stream the bytes through the API instead (local driver).
   */
  getSignedUrl(key: string, expiresSeconds: number): Promise<string | null>;
}

export const storage: StorageDriver =
  env.STORAGE_DRIVER === 's3'
    ? new S3Storage()
    : env.STORAGE_DRIVER === 'gcs'
      ? new GcsStorage()
    : new LocalStorage(env.STORAGE_LOCAL_DIR, env.STORAGE_NAMESPACE);
