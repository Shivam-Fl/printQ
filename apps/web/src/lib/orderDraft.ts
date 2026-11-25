/**
 * The order a student is putting together at one shop: its files (each
 * uploaded and prepared on its own), their print order, the pages chosen, and
 * the single joined document the order is priced and placed on.
 *
 * It lives outside React so uploads keep going while the student moves from
 * the shop page to the order page, and so files can be added at any moment.
 * The joined document's id is mirrored in the order page's URL (?doc=), which
 * is enough to rebuild the order after a refresh: a joined document knows its
 * files (GET /api/files/:id → parts).
 */
import { useSyncExternalStore } from 'react';
import { api, uploadForm } from '../api.js';
import { getStudentSocket } from '../socket.js';
import { fileKind, fitToRoom, localFileProblem, MAX_ORDER_FILES, type FileKind } from './fileChoice.js';
import type { DocPart, Excluded } from './pageSelection.js';

export type ItemStatus = 'uploading' | 'preparing' | 'ready' | 'failed';

export interface DraftItem {
  /** stable key for the UI (a file id only exists after upload) */
  key: string;
  name: string;
  size: number | null;
  kind: FileKind;
  status: ItemStatus;
  /** 0..1 while uploading */
  progress: number;
  fileId?: string;
  pages?: number;
  error?: string;
  /** object URL of a chosen photo, for an instant thumbnail */
  localThumb?: string;
  /** kept only after a failed UPLOAD, so "Try again" needs no new pick */
  retryFile?: File;
}

export interface DraftDoc {
  /** the files joined, in print order */
  ids: string[];
  fileId: string;
  status: 'preparing' | 'ready' | 'failed';
  error?: string;
}

export interface Draft {
  slug: string;
  items: DraftItem[];
  doc: DraftDoc | null;
  excluded: Excluded;
  /** a one-off message about the last action (e.g. files over the limit) */
  notice: string | null;
  /** rebuilding from a link failed */
  loadError: string | null;
  loading: boolean;
}

const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();
const composeTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** the files of a join request still on its way, per shop (no second request for the same files) */
const composing = new Map<string, string[]>();
let keySeq = 0;
const nextKey = () => `item-${Date.now().toString(36)}-${(keySeq++).toString(36)}`;

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDraft(slug: string): Draft | null {
  return drafts.get(slug) ?? null;
}

/** The live order draft for a shop (null until a file is added or a link is opened). */
export function useOrderDraft(slug: string): Draft | null {
  return useSyncExternalStore(subscribe, () => getDraft(slug), () => null);
}

function update(slug: string, change: (draft: Draft) => Draft): Draft {
  const current = drafts.get(slug) ?? emptyDraft(slug);
  const next = change(current);
  drafts.set(slug, next);
  emit();
  return next;
}

function emptyDraft(slug: string): Draft {
  return { slug, items: [], doc: null, excluded: {}, notice: null, loadError: null, loading: false };
}

function patchItem(slug: string, match: (item: DraftItem) => boolean, patch: Partial<DraftItem>): void {
  update(slug, (draft) => ({ ...draft, items: draft.items.map((item) => (match(item) ? { ...item, ...patch } : item)) }));
}

// ---------------------------------------------------------------- derived

/** The ready files, in print order: what the joined document is made of. */
export function readyParts(draft: Draft | null): DocPart[] {
  return (draft?.items ?? [])
    .filter((item) => item.status === 'ready' && item.fileId && item.pages)
    .map((item) => ({ fileId: item.fileId!, name: item.name, pages: item.pages! }));
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** The files the joined document must contain right now, or null while some are still on their way. */
export function wantedIds(items: readonly DraftItem[]): string[] | null {
  if (items.some((item) => item.status === 'uploading' || item.status === 'preparing')) return null;
  return items.filter((item) => item.status === 'ready' && item.fileId).map((item) => item.fileId!);
}

/** True when the order can be priced and placed on draft.doc. */
export function docMatches(draft: Draft | null): draft is Draft & { doc: DraftDoc } {
  if (!draft?.doc || draft.doc.status !== 'ready') return false;
  const wanted = wantedIds(draft.items);
  return wanted !== null && sameIds(wanted, draft.doc.ids);
}

// ---------------------------------------------------------------- adding files

type PartsResponse = {
  files: { index: number; id: string; name: string; status: string; sizeBytes: number }[];
  rejected: { index: number; name: string; error: string }[];
};

/** Add chosen files to the order and start uploading them (one request for the batch). */
export function addFiles(slug: string, chosen: readonly File[]): void {
  if (chosen.length === 0) return;
  const draft = drafts.get(slug) ?? emptyDraft(slug);
  const { take, overflow } = fitToRoom(chosen, draft.items.length);
  const fresh: DraftItem[] = take.map((file) => {
    const problem = localFileProblem(file);
    const kind = fileKind(file.name, file.type) ?? 'pdf';
    return {
      key: nextKey(),
      name: file.name || 'Photo.jpg',
      size: file.size,
      kind,
      status: problem ? 'failed' : 'uploading',
      progress: 0,
      error: problem ?? undefined,
      localThumb: !problem && kind === 'image' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined,
    };
  });
  update(slug, (d) => ({
    ...d,
    items: [...d.items, ...fresh],
    loadError: null,
    notice: overflow > 0
      ? `One order can have up to ${MAX_ORDER_FILES} files. ${overflow} file${overflow === 1 ? ' was' : 's were'} not added.`
      : null,
  }));
  const batch = fresh
    .map((item, i) => ({ item, file: take[i]! }))
    .filter(({ item }) => item.status === 'uploading');
  if (batch.length > 0) void uploadBatch(slug, batch);
  syncDoc(slug);
}

async function uploadBatch(slug: string, batch: { item: DraftItem; file: File }[]): Promise<void> {
  const keys = new Set(batch.map((b) => b.item.key));
  const form = new FormData();
  form.append('shopSlug', slug);
  for (const { file } of batch) form.append('files', file, file.name || 'photo.jpg');
  try {
    const res = await uploadForm<PartsResponse>('/api/files/parts', form, {
      role: 'student',
      onProgress: (fraction) => patchItem(slug, (item) => keys.has(item.key) && item.status === 'uploading', { progress: fraction }),
    });
    // results come back in the order sent; `index` makes that explicit
    const accepted = new Map(res.files.map((f) => [f.index, f]));
    const rejected = new Map(res.rejected.map((r) => [r.index, r]));
    batch.forEach(({ item }, index) => {
      const ok = accepted.get(index);
      const bad = rejected.get(index);
      if (ok) patchItem(slug, (it) => it.key === item.key, { status: 'preparing', fileId: ok.id, progress: 1, retryFile: undefined });
      else patchItem(slug, (it) => it.key === item.key, { status: 'failed', error: bad?.error ?? 'This file could not be uploaded.', retryFile: undefined });
    });
    watch();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed. Try again.';
    for (const { item, file } of batch) {
      patchItem(slug, (it) => it.key === item.key, { status: 'failed', error: message, retryFile: file, progress: 0 });
    }
  }
  syncDoc(slug);
}

/** Upload a file again after a failed upload (network, rate limit). */
export function retryItem(slug: string, key: string): void {
  const item = drafts.get(slug)?.items.find((it) => it.key === key);
  if (!item?.retryFile) return;
  const file = item.retryFile;
  patchItem(slug, (it) => it.key === key, { status: 'uploading', error: undefined, progress: 0, retryFile: undefined });
  void uploadBatch(slug, [{ item, file }]);
}

export function removeItem(slug: string, key: string): void {
  update(slug, (draft) => {
    const item = draft.items.find((it) => it.key === key);
    if (item?.localThumb) URL.revokeObjectURL(item.localThumb);
    const excluded = { ...draft.excluded };
    if (item?.fileId) delete excluded[item.fileId];
    return { ...draft, items: draft.items.filter((it) => it.key !== key), excluded, notice: null };
  });
  syncDoc(slug);
}

/** Move a file up (-1) or down (+1) in the print order. */
export function moveItem(slug: string, key: string, delta: -1 | 1): void {
  update(slug, (draft) => {
    const from = draft.items.findIndex((it) => it.key === key);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= draft.items.length) return draft;
    const items = [...draft.items];
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved!);
    return { ...draft, items };
  });
  syncDoc(slug);
}

export function setExcluded(slug: string, excluded: Excluded): void {
  update(slug, (draft) => ({ ...draft, excluded }));
}

export function dismissNotice(slug: string): void {
  update(slug, (draft) => ({ ...draft, notice: null }));
}

/** Forget the order (after it was placed, or when the student starts over). */
export function clearDraft(slug: string): void {
  const draft = drafts.get(slug);
  for (const item of draft?.items ?? []) if (item.localThumb) URL.revokeObjectURL(item.localThumb);
  const timer = composeTimers.get(slug);
  if (timer) clearTimeout(timer);
  composeTimers.delete(slug);
  composing.delete(slug);
  drafts.delete(slug);
  emit();
}

// ---------------------------------------------------------------- opening a link

type FileInfo = {
  id: string;
  status: string;
  pages: number | null;
  originalName: string;
  sizeBytes?: number;
  error?: string | null;
  parts?: DocPart[] | null;
};

function kindFromName(name: string): FileKind {
  return fileKind(name) ?? 'pdf';
}

/**
 * Rebuild the order from its joined document (a refresh, or a link from the
 * older /s/:slug/file/:id address). Keeps a draft that already describes it.
 */
export async function openDoc(slug: string, fileId: string): Promise<void> {
  const existing = drafts.get(slug);
  if (existing && (existing.doc?.fileId === fileId || existing.items.some((it) => it.fileId === fileId))) return;
  update(slug, () => ({ ...emptyDraft(slug), loading: true }));
  try {
    const { file } = await api<{ file: FileInfo }>(`/api/files/${fileId}`, { role: 'student' });
    if (file.status === 'failed' || file.status === 'deleted') {
      update(slug, (d) => ({ ...d, loading: false, loadError: file.error || 'This file is no longer available. Add your files again.' }));
      return;
    }
    const parts = file.parts ?? null;
    const items: DraftItem[] = parts
      ? parts.map((part) => ({ key: nextKey(), name: part.name, size: null, kind: kindFromName(part.name), status: 'ready', progress: 1, fileId: part.fileId, pages: part.pages }))
      : [{
          key: nextKey(), name: file.originalName, size: file.sizeBytes ?? null, kind: kindFromName(file.originalName),
          status: file.status === 'ready' ? 'ready' : 'preparing', progress: 1, fileId: file.id, pages: file.pages ?? undefined,
        }];
    const doc: DraftDoc = parts
      ? { ids: parts.map((p) => p.fileId), fileId: file.id, status: file.status === 'ready' ? 'ready' : 'preparing' }
      : { ids: [file.id], fileId: file.id, status: file.status === 'ready' ? 'ready' : 'preparing' };
    update(slug, (d) => ({ ...d, items, doc, loading: false }));
    watch();
    syncDoc(slug);
  } catch (err) {
    update(slug, (d) => ({ ...d, loading: false, loadError: err instanceof Error ? err.message : 'Could not open this order.' }));
  }
}

// ---------------------------------------------------------------- joining

/** Keep draft.doc equal to the ready files, joining them (debounced) when there are several. */
function syncDoc(slug: string): void {
  const draft = drafts.get(slug);
  if (!draft) return;
  const wanted = wantedIds(draft.items);
  if (wanted === null) return; // wait until every file is ready or failed
  if (draft.doc && sameIds(draft.doc.ids, wanted) && draft.doc.status !== 'failed') return;
  const timer = composeTimers.get(slug);
  if (timer) clearTimeout(timer);
  composeTimers.delete(slug);
  if (wanted.length === 0) {
    if (draft.doc) update(slug, (d) => ({ ...d, doc: null }));
    return;
  }
  if (wanted.length === 1) {
    update(slug, (d) => ({ ...d, doc: { ids: wanted, fileId: wanted[0]!, status: 'ready' } }));
    return;
  }
  if (draft.doc?.status === 'failed' && sameIds(draft.doc.ids, wanted)) return; // the student retries
  const inFlight = composing.get(slug);
  if (inFlight && sameIds(inFlight, wanted)) return;
  // several files: join them once the student stops rearranging
  update(slug, (d) => ({ ...d, doc: null }));
  composeTimers.set(slug, setTimeout(() => void compose(slug, wanted), 450));
}

async function compose(slug: string, ids: string[]): Promise<void> {
  composeTimers.delete(slug);
  composing.set(slug, ids);
  try {
    const res = await api<{ file: { id: string } }>('/api/files/compose', { method: 'POST', role: 'student', body: { fileIds: ids } });
    const now = drafts.get(slug);
    const wanted = now ? wantedIds(now.items) : null;
    if (!wanted || !sameIds(wanted, ids)) return; // rearranged meanwhile: a newer join follows
    update(slug, (d) => ({ ...d, doc: { ids, fileId: res.file.id, status: 'preparing' } }));
    watch();
  } catch (err) {
    const now = drafts.get(slug);
    const wanted = now ? wantedIds(now.items) : null;
    if (!wanted || !sameIds(wanted, ids)) return;
    update(slug, (d) => ({
      ...d,
      doc: { ids, fileId: '', status: 'failed', error: err instanceof Error ? err.message : 'Could not put your files together.' },
    }));
  } finally {
    if (composing.get(slug) === ids) composing.delete(slug);
  }
}

/** Try joining the files again after a failure. */
export function retryJoin(slug: string): void {
  const draft = drafts.get(slug);
  const wanted = draft ? wantedIds(draft.items) : null;
  if (!wanted || wanted.length < 2) return;
  update(slug, (d) => ({ ...d, doc: null }));
  void compose(slug, wanted);
}

// ---------------------------------------------------------------- following conversions

let socketBound = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function onReady(fileId: string, pages: number | null): void {
  for (const draft of [...drafts.values()]) {
    const slug = draft.slug;
    if (draft.items.some((it) => it.fileId === fileId && it.status === 'preparing')) {
      patchItem(slug, (it) => it.fileId === fileId, { status: 'ready', pages: pages ?? undefined, error: undefined });
      syncDoc(slug);
    }
    if (draft.doc?.fileId === fileId && draft.doc.status === 'preparing') {
      update(slug, (d) => (d.doc?.fileId === fileId ? { ...d, doc: { ...d.doc, status: 'ready' } } : d));
    }
  }
}

function onFailed(fileId: string, error: string | null): void {
  const message = error || 'We couldn’t prepare this file. Remove it and try another copy.';
  for (const draft of [...drafts.values()]) {
    const slug = draft.slug;
    if (draft.items.some((it) => it.fileId === fileId && it.status === 'preparing')) {
      patchItem(slug, (it) => it.fileId === fileId, { status: 'failed', error: message });
      syncDoc(slug);
    }
    if (draft.doc?.fileId === fileId && draft.doc.status === 'preparing') {
      update(slug, (d) => (d.doc?.fileId === fileId ? { ...d, doc: { ...d.doc, status: 'failed', error: message } } : d));
    }
  }
}

function pendingIds(): string[] {
  const ids: string[] = [];
  for (const draft of drafts.values()) {
    for (const item of draft.items) if (item.status === 'preparing' && item.fileId) ids.push(item.fileId);
    if (draft.doc?.status === 'preparing') ids.push(draft.doc.fileId);
  }
  return ids;
}

/** Follow every file still being prepared: socket events, with polling as the safety net. */
function watch(): void {
  if (!socketBound) {
    const socket = getStudentSocket();
    if (socket) {
      socketBound = true;
      socket.on('file:ready', (p: { fileId: string; pages?: number }) => onReady(p.fileId, p.pages ?? null));
      socket.on('file:failed', (p: { fileId: string; error?: string }) => onFailed(p.fileId, p.error ?? null));
    }
  }
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    const ids = pendingIds();
    if (ids.length === 0) {
      clearInterval(pollTimer!);
      pollTimer = null;
      return;
    }
    for (const id of ids) {
      api<{ file: FileInfo }>(`/api/files/${id}`, { role: 'student' })
        .then(({ file }) => {
          if (file.status === 'ready') onReady(id, file.pages);
          else if (file.status === 'failed' || file.status === 'deleted') onFailed(id, file.error ?? null);
        })
        .catch(() => undefined); // keep polling
    }
  }, 2500);
}

/** Test hook: forget everything. */
export function resetDraftsForTests(): void {
  for (const slug of [...drafts.keys()]) clearDraft(slug);
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  socketBound = false;
}
