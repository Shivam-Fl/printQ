import { MulterError } from 'multer';
import { describe, expect, it, vi } from 'vitest';
import { PageRangeError } from '@printq/shared';
import { errorHandler } from './error.js';

function responseRecorder() {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  return response;
}

describe('errorHandler upload and validation errors', () => {
  it('returns JSON 413 for an over-limit Multer upload', () => {
    const res = responseRecorder();
    errorHandler(new MulterError('LIMIT_FILE_SIZE'), { method: 'POST', path: '/api/files' } as never, res as never, vi.fn());
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Each file must be 25 MB or smaller',
      code: 'FILE_TOO_LARGE',
    });
  });

  it('returns JSON 400 for an invalid page range', () => {
    const res = responseRecorder();
    errorHandler(new PageRangeError('Selected pages are outside this document'), { method: 'POST', path: '/api/jobs/quote' } as never, res as never, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Selected pages are outside this document',
      code: 'INVALID_PAGE_RANGE',
    });
  });
});
