import { describe, expect, it, vi } from 'vitest';
import { GcsStorage } from './gcs.js';

describe('GCS storage namespace and private-object contract', () => {
  it('uses the environment namespace for every object operation and creates a short-lived read URL', async () => {
    const file = {
      save: vi.fn().mockResolvedValue(undefined),
      download: vi.fn().mockResolvedValue([Buffer.from('converted')]),
      delete: vi.fn().mockResolvedValue(undefined),
      getSignedUrl: vi.fn().mockResolvedValue(['https://storage.example.test/signed-preview']),
    };
    const bucket = { file: vi.fn().mockReturnValue(file) };
    const storage = new GcsStorage('printqs-development-private', 'printq-test', {
      bucket: vi.fn().mockReturnValue(bucket),
    });

    await storage.put('orig/upload.pdf', Buffer.from('source'), 'application/pdf');
    await expect(storage.get('conv/upload.pdf')).resolves.toEqual(Buffer.from('converted'));
    await storage.delete('conv/upload.pdf');
    await expect(storage.getSignedUrl('conv/upload.pdf', 300)).resolves.toBe('https://storage.example.test/signed-preview');

    expect(bucket.file).toHaveBeenNthCalledWith(1, 'printq-test/orig/upload.pdf');
    expect(file.save).toHaveBeenCalledWith(Buffer.from('source'), {
      resumable: false,
      metadata: { contentType: 'application/pdf', contentDisposition: 'attachment' },
    });
    expect(bucket.file).toHaveBeenNthCalledWith(2, 'printq-test/conv/upload.pdf');
    expect(bucket.file).toHaveBeenNthCalledWith(3, 'printq-test/conv/upload.pdf');
    expect(file.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
    expect(bucket.file).toHaveBeenNthCalledWith(4, 'printq-test/conv/upload.pdf');
    expect(file.getSignedUrl).toHaveBeenCalledWith(expect.objectContaining({ version: 'v4', action: 'read' }));
  });
});
