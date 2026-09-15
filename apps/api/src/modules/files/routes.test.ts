import { beforeAll, describe, expect, it, vi } from 'vitest';

// The pure helpers below do not need Redis/BullMQ. Keeping those services out
// of this module test also prevents background connection logs at teardown.
vi.mock('../../lib/queues.js', () => ({ convertQueue: { add: vi.fn() } }));
vi.mock('../../middleware/rateLimit.js', () => ({
  uploadLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'x'.repeat(64);
process.env.OTP_PEPPER ??= 'y'.repeat(32);

let validateUploadFileType: typeof import('./routes.js')['validateUploadFileType'];
let setPreviewSecurityHeaders: typeof import('./routes.js')['setPreviewSecurityHeaders'];

beforeAll(async () => {
  ({ validateUploadFileType, setPreviewSecurityHeaders } = await import('./routes.js'));
});

describe('local preview security headers', () => {
  it('allows framing only from configured concrete origins and preserves the PDF sandbox', () => {
    const res = { removeHeader: vi.fn(), setHeader: vi.fn() };
    setPreviewSecurityHeaders(res, ['https://printqs.com', 'http://localhost:5173']);

    expect(res.removeHeader).toHaveBeenCalledWith('X-Frame-Options');
    expect(res.setHeader).toHaveBeenCalledWith('Cross-Origin-Resource-Policy', 'cross-origin');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Security-Policy',
      "sandbox; default-src 'none'; frame-ancestors https://printqs.com http://localhost:5173",
    );
  });

  it('does not turn a wildcard or malformed CORS value into a frame permission', () => {
    const res = { removeHeader: vi.fn(), setHeader: vi.fn() };
    setPreviewSecurityHeaders(res, ['*', 'not-an-origin']);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Security-Policy',
      "sandbox; default-src 'none'; frame-ancestors 'none'",
    );
  });
});

describe('upload type contract', () => {
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');

  it('accepts a matching PDF extension, browser MIME type and signature', async () => {
    await expect(validateUploadFileType(pdf, 'notes.PDF', 'application/pdf')).resolves.toMatchObject({ ext: 'pdf' });
    await expect(validateUploadFileType(pdf, 'notes.pdf', 'application/x-pdf')).resolves.toMatchObject({ ext: 'pdf' });
  });

  it('rejects a PDF disguised as a text file', async () => {
    await expect(validateUploadFileType(pdf, 'mismatch.txt', 'text/plain')).resolves.toBeNull();
  });

  it('rejects a matching extension when the declared MIME type conflicts', async () => {
    await expect(validateUploadFileType(pdf, 'mismatch.pdf', 'text/plain')).resolves.toBeNull();
  });
});
