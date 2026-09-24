import { Storage } from '@google-cloud/storage';
import { env } from '../../config/env.js';
import type { StorageDriver } from './index.js';

interface GcsFile {
  save(data: Buffer, options: {
    resumable: boolean;
    metadata: { contentType: string; contentDisposition: string };
  }): Promise<unknown>;
  download(): Promise<[Buffer]>;
  delete(options: { ignoreNotFound: boolean }): Promise<unknown>;
  getSignedUrl(options: { version: 'v4'; action: 'read'; expires: number }): Promise<[string]>;
}

interface GcsBucket {
  file(name: string): GcsFile;
}

interface GcsClient {
  bucket(name: string): GcsBucket;
}

/**
 * Private Google Cloud Storage driver. On Cloud Run it uses the attached
 * runtime service identity through Application Default Credentials, never a
 * service-account JSON or HMAC access key in application configuration.
 */
export class GcsStorage implements StorageDriver {
  private readonly bucket: GcsBucket;
  private readonly namespace: string;

  constructor(
    bucketName = env.GCS_BUCKET!,
    namespace = env.STORAGE_NAMESPACE,
    client: GcsClient = new Storage(),
  ) {
    this.bucket = client.bucket(bucketName);
    this.namespace = namespace;
  }

  private objectKey(key: string): string {
    return `${this.namespace}/${key}`;
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.bucket.file(this.objectKey(key)).save(data, {
      resumable: false,
      metadata: {
        contentType,
        // Source documents and converted files must never be rendered as
        // active browser content when a signed URL is followed.
        contentDisposition: 'attachment',
      },
    });
  }

  async get(key: string): Promise<Buffer> {
    const [data] = await this.bucket.file(this.objectKey(key)).download();
    return data;
  }

  async delete(key: string): Promise<void> {
    // Idempotency is essential for the T+10 retry/sweeper path: a first
    // attempt may have deleted the object before its database write failed.
    await this.bucket.file(this.objectKey(key)).delete({ ignoreNotFound: true });
  }

  async getSignedUrl(key: string, expiresSeconds: number): Promise<string> {
    const [url] = await this.bucket.file(this.objectKey(key)).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + expiresSeconds * 1_000,
    });
    return url;
  }
}
