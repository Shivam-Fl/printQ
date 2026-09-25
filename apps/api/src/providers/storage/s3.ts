import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';
import type { StorageDriver } from './index.js';

export class S3Storage implements StorageDriver {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly namespace: string;

  constructor() {
    this.bucket = env.S3_BUCKET!;
    this.namespace = env.STORAGE_NAMESPACE;
    this.client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID!,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      },
    });
  }

  private objectKey(key: string): string {
    // All callers pass generated logical keys (orig/, conv/); the environment
    // namespace is deliberately outside database values and prevents a dev
    // configuration from reaching a production object path.
    return `${this.namespace}/${key}`;
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
        Body: data,
        ContentType: contentType,
        // never render as active content in a browser context
        ContentDisposition: 'attachment',
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
  }

  async getSignedUrl(key: string, expiresSeconds: number): Promise<string | null> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }), {
      expiresIn: expiresSeconds,
    });
  }
}
