import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const server = vi.hoisted(() => ({
  files: new Map<string, { status: string; pages: number | null }>(),
  composed: [] as string[][],
  uploads: 0,
}));

vi.mock('../socket.js', () => ({ getStudentSocket: () => null }));
vi.mock('../api.js', () => ({
  uploadForm: vi.fn(async (_path: string, form: FormData, opts: { onProgress?: (f: number) => void }) => {
    opts.onProgress?.(0.5);
    const names = form.getAll('files').map((f) => (f as File).name);
    const files = names.map((name, index) => {
      const id = `f${++server.uploads}`;
      server.files.set(id, { status: 'converting', pages: null });
      return { index, id, name, status: 'uploaded', sizeBytes: 1 };
    });
    return { files, rejected: [] };
  }),
  api: vi.fn(async (path: string, init?: { body?: { fileIds: string[] } }) => {
    if (path === '/api/files/compose') {
      server.composed.push(init!.body!.fileIds);
      const id = `joined${server.composed.length}`;
      server.files.set(id, { status: 'converting', pages: null });
      return { file: { id } };
    }
    const id = path.split('/').pop()!;
    const file = server.files.get(id)!;
    return { file: { id, ...file, originalName: id, error: null, parts: null } };
  }),
}));

import { addFiles, docMatches, getDraft, moveItem, removeItem, resetDraftsForTests } from './orderDraft.js';

const pdf = (name: string) => new File(['%PDF'], name, { type: 'application/pdf' });
const finish = (id: string, pages: number) => server.files.set(id, { status: 'ready', pages });
const tick = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };

beforeEach(() => {
  vi.useFakeTimers();
  server.files.clear();
  server.composed.length = 0;
  server.uploads = 0;
});
afterEach(() => {
  resetDraftsForTests();
  vi.useRealTimers();
});

describe('order draft', () => {
  it('uploads, follows preparation, and joins several files in print order', async () => {
    addFiles('shop', [pdf('a.pdf'), pdf('b.pdf')]);
    expect(getDraft('shop')!.items.map((i) => i.status)).toEqual(['uploading', 'uploading']);
    await tick(0);
    expect(getDraft('shop')!.items.map((i) => [i.status, i.fileId])).toEqual([['preparing', 'f1'], ['preparing', 'f2']]);

    finish('f1', 3);
    finish('f2', 2);
    await tick(2500); // poll picks both up
    expect(getDraft('shop')!.items.map((i) => [i.status, i.pages])).toEqual([['ready', 3], ['ready', 2]]);
    expect(docMatches(getDraft('shop'))).toBe(false); // the join is debounced

    await tick(450);
    expect(server.composed).toEqual([['f1', 'f2']]);
    finish('joined1', 5);
    await tick(2500);
    expect(docMatches(getDraft('shop'))).toBe(true);
    expect(getDraft('shop')!.doc!.fileId).toBe('joined1');
  });

  it('re-joins after a reorder, an added file or a removal, and needs no join for one file', async () => {
    addFiles('shop', [pdf('a.pdf'), pdf('b.pdf')]);
    await tick(0);
    finish('f1', 1); finish('f2', 1);
    await tick(2500 + 450);
    finish('joined1', 2);
    await tick(2500);

    const [first] = getDraft('shop')!.items;
    moveItem('shop', first!.key, 1);
    expect(docMatches(getDraft('shop'))).toBe(false);
    await tick(450);
    expect(server.composed.at(-1)).toEqual(['f2', 'f1']);

    // a file forgotten earlier: added straight from the order page
    addFiles('shop', [pdf('c.pdf')]);
    await tick(0);
    finish('f3', 4);
    await tick(2500 + 450);
    expect(server.composed.at(-1)).toEqual(['f2', 'f1', 'f3']);

    for (const item of getDraft('shop')!.items.slice(1)) removeItem('shop', item.key);
    await tick(0);
    expect(getDraft('shop')!.doc).toEqual({ ids: ['f2'], fileId: 'f2', status: 'ready' });
    expect(docMatches(getDraft('shop'))).toBe(true);
  });

  it('marks a wrong file at once instead of uploading it, and caps an order at 15 files', () => {
    addFiles('shop', [new File(['x'], 'old.doc'), ...Array.from({ length: 15 }, (_, i) => pdf(`${i}.pdf`))]);
    const draft = getDraft('shop')!;
    expect(draft.items).toHaveLength(15);
    expect(draft.items[0]).toMatchObject({ status: 'failed' });
    expect(draft.notice).toMatch(/up to 15 files\. 1 file was not added/);
  });
});
