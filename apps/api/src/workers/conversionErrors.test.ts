import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

const state = vi.hoisted(() => ({
  file: null as Record<string, unknown> | null,
  update: vi.fn(),
  put: vi.fn(),
  events: [] as { event: string; payload: unknown }[],
  blobs: new Map<string, Buffer>(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    $disconnect: vi.fn(),
    uploadedFile: {
      findUnique: vi.fn(async () => state.file),
      update: (args: unknown) => state.update(args),
    },
  },
}));
vi.mock('../providers/storage/index.js', () => ({
  storage: {
    get: vi.fn(async (key: string) => state.blobs.get(key)),
    put: (...args: unknown[]) => state.put(...args),
  },
}));
vi.mock('../realtime/events.js', () => ({
  publishEvent: vi.fn((_room: string, event: string, payload: unknown) => {
    state.events.push({ event, payload });
  }),
}));
vi.mock('../lib/fileRetention.js', () => ({
  ACTIVE_FILE_JOB_STATUSES: ['queued'],
  ensureFileDeletionJob: vi.fn(),
  scheduleFileDeletion: vi.fn(),
  scheduleVerifiedPrintFileDeletion: vi.fn(),
}));

import { convertFile } from './conversion.js';
import {
  CONVERSION_ERRORS,
  MAX_DOCUMENT_PAGES,
  classifyConversionError,
  publicFileError,
} from './conversionErrors.js';

const RAW_LEAK = /Pages|undefined|TypeError|pdf-lib|\/tmp|stack/i;

function setup(bytes: Buffer, mime = 'application/pdf') {
  state.blobs.set('orig/x', bytes);
  state.file = {
    id: 'f1',
    studentId: 's1',
    status: 'uploaded',
    sources: null,
    originalKey: 'orig/x',
    mimeType: mime,
    originalName: 'x',
  };
}

function lastFailure() {
  const call = state.update.mock.calls.map((c) => c[0] as { data: { status: string; error?: string } }).find((c) => c.data.status === 'failed');
  return call?.data;
}

// A minimal PDF whose trailer carries /Encrypt (standard security handler).
const ENCRYPTED_PDF = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
    '4 0 obj<</Filter/Standard/V 1/R 2/O(aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)/U(bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)/P -4>>endobj',
    'trailer<</Root 1 0 R/Size 5/Encrypt 4 0 R/ID[<aa><aa>]>>',
    '%%EOF',
  ].join('\n'),
);

beforeEach(() => {
  state.update.mockReset();
  state.put.mockReset();
  state.events.length = 0;
  state.blobs.clear();
});

describe('conversion failures are mapped to friendly, safe codes', () => {
  it('corrupt PDF -> FILE_CORRUPT, raw pdf-lib message never stored or emitted', async () => {
    setup(Buffer.from('%PDF-1.4\n1 0 obj<<garbage>>\nnot a real pdf at all\n%%EOF'));
    await expect(convertFile('f1')).resolves.toBeUndefined(); // permanent: no BullMQ retry
    expect(lastFailure()).toEqual({ status: 'failed', error: 'FILE_CORRUPT' });
    const failed = state.events.find((e) => e.event === 'file:failed')!.payload as { error: string; errorCode: string };
    expect(failed.errorCode).toBe('FILE_CORRUPT');
    expect(failed.error).toBe(CONVERSION_ERRORS.FILE_CORRUPT);
    expect(failed.error).not.toMatch(RAW_LEAK);
  });

  it('header-only garbage PDF (parses leniently, fails at getPageCount) -> FILE_CORRUPT', async () => {
    setup(Buffer.from('%PDF-1.4\ngarbage that is not a pdf\n%%EOF'));
    await convertFile('f1');
    expect(lastFailure()?.error).toBe('FILE_CORRUPT');
  });

  it('password-protected PDF -> FILE_ENCRYPTED with the exact friendly message', async () => {
    setup(ENCRYPTED_PDF);
    await convertFile('f1');
    expect(lastFailure()?.error).toBe('FILE_ENCRYPTED');
    expect(CONVERSION_ERRORS.FILE_ENCRYPTED).toBe(
      'This PDF is password protected — remove the password and upload again.',
    );
  });

  it('corrupt image -> FILE_CORRUPT', async () => {
    setup(Buffer.from('definitely not a png'), 'image/png');
    await convertFile('f1');
    expect(lastFailure()?.error).toBe('FILE_CORRUPT');
  });

  it('DOCX without a converter -> FILE_UNSUPPORTED', async () => {
    setup(Buffer.from('PK'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    await convertFile('f1');
    expect(lastFailure()?.error).toBe('FILE_UNSUPPORTED');
  });

  it('too many pages -> TOO_MANY_PAGES', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i <= MAX_DOCUMENT_PAGES; i++) doc.addPage([100, 100]);
    setup(Buffer.from(await doc.save()));
    await convertFile('f1');
    expect(lastFailure()?.error).toBe('TOO_MANY_PAGES');
  }, 30_000);

  it('a valid PDF still converts', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    setup(Buffer.from(await doc.save()));
    await convertFile('f1');
    expect(lastFailure()).toBeUndefined();
    expect(state.events.some((e) => e.event === 'file:ready')).toBe(true);
  });

  it('timeouts and unexpected errors classify, and unexpected errors are retried', async () => {
    expect(classifyConversionError(Object.assign(new Error('x'), { killed: true }))).toBe('CONVERSION_TIMEOUT');
    expect(classifyConversionError(new Error('ENOENT /secret/path'))).toBe('CONVERSION_FAILED');

    setup(Buffer.from('%PDF-1.4'));
    state.put.mockRejectedValue(new Error('S3 AccessDenied bucket=secret'));
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    state.blobs.set('orig/x', Buffer.from(await doc.save()));
    await expect(convertFile('f1')).rejects.toThrow(); // transient -> BullMQ retry
    expect(lastFailure()).toEqual({ status: 'failed', error: 'CONVERSION_FAILED' });
    expect(JSON.stringify(state.events)).not.toMatch(/secret|AccessDenied/);
  });

  it('legacy raw messages in the DB are never returned to clients', () => {
    expect(publicFileError("Cannot read properties of undefined (reading 'Pages')")).toEqual({
      error: CONVERSION_ERRORS.CONVERSION_FAILED,
      errorCode: 'CONVERSION_FAILED',
    });
    expect(publicFileError(null)).toBeNull();
  });
});
