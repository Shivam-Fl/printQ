import { readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
// @pdf-lib/fontkit's Indic (Devanagari) shaper is built with babel and needs this global at runtime
import 'regenerator-runtime/runtime.js';
import fontkit from '@pdf-lib/fontkit';
import { normalizePageRange, type JobSpecs, type PriceBreakdown } from '@printq/shared';
import { logger } from './logger.js';
import { prisma } from './prisma.js';

/** Hand-over time from the audit trail (updatedAt also moves when a rating is saved). */
export async function loadCompletedAt(jobId: string, status: string): Promise<Date | null> {
  if (status !== 'completed') return null;
  const event = await prisma.jobEvent.findFirst({
    where: { jobId, toStatus: 'completed' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return event?.createdAt ?? null;
}

export interface ReceiptData {
  jobId: string;
  createdAt: Date;
  shopName: string;
  shopAddress: string;
  studentLabel: string;
  specs: JobSpecs;
  breakdown: PriceBreakdown;
  totalPaise: number;
  paymentStatus: string;
  /** When the order was handed over (completed). Falls back to creation for orders still in flight. */
  completedAt?: Date | null;
  /** How the shop collected payment at the counter. */
  counterPaymentMethod?: 'cash' | 'shop_upi' | null;
  /** Document page count, used to show the page range in its normalized form. */
  totalPages?: number | null;
  /** Student receipts show a single final charge; owner copies may be itemized. */
  showPriceBreakdown?: boolean;
}

const rupees = (paise: number) => `Rs ${(paise / 100).toFixed(2)}`;

/** Payment method wording; never any shop base price or platform commission. */
export function paymentLine(data: Pick<ReceiptData, 'paymentStatus' | 'counterPaymentMethod'>): string {
  if (data.paymentStatus !== 'paid') return data.paymentStatus;
  if (data.counterPaymentMethod === 'cash') return 'Paid at shop (cash)';
  if (data.counterPaymentMethod === 'shop_upi') return 'Paid at shop (UPI)';
  return 'Paid at shop';
}

// ---------------------------------------------------------------------------
// Unicode text support: Noto Sans (Latin/Greek/Cyrillic) + Noto Sans Devanagari
// (both SIL OFL 1.1, apps/api/assets/fonts). Each code point is drawn with the
// first font that has a glyph for it; anything neither font covers (emoji,
// Arabic/Hebrew, CJK, ...) is shown as '?'. Receipt rendering never throws.
// ---------------------------------------------------------------------------

const FONT_DIR = new URL('../../assets/fonts/', import.meta.url);

interface FontFiles {
  latin: Uint8Array;
  latinBold: Uint8Array;
  deva: Uint8Array;
  devaBold: Uint8Array;
  latinChars: Set<number>;
  devaChars: Set<number>;
}

let fontFiles: Promise<FontFiles> | null = null;

function loadFontFiles(): Promise<FontFiles> {
  const loading: Promise<FontFiles> = (fontFiles ??= (async () => {
    const load = async (name: string) => new Uint8Array(await readFile(new URL(name, FONT_DIR)));
    const [latin, latinBold, deva, devaBold] = await Promise.all([
      load('NotoSans-Regular.ttf'),
      load('NotoSans-Bold.ttf'),
      load('NotoSansDevanagari-Regular.ttf'),
      load('NotoSansDevanagari-Bold.ttf'),
    ]);
    const charsOf = (bytes: Uint8Array) => {
      const font = fontkit.create(Buffer.from(bytes) as never) as unknown as { characterSet: number[] };
      return new Set<number>(font.characterSet);
    };
    return { latin, latinBold, deva, devaBold, latinChars: charsOf(latin), devaChars: charsOf(deva) };
  })());
  loading.catch(() => {
    fontFiles = null; // retry next time (e.g. a transient read failure)
  });
  return loading;
}

interface FontSet {
  latin: PDFFont;
  deva: PDFFont;
}

const isDevaRange = (cp: number) =>
  (cp >= 0x0900 && cp <= 0x097f) || (cp >= 0xa8e0 && cp <= 0xa8ff) || (cp >= 0x1cd0 && cp <= 0x1cff);
/** Format/control characters that would otherwise confuse layout (newlines, bidi marks, ZW spaces, BOM). */
const isIgnorable = (cp: number) =>
  cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0x200b && cp <= 0x200f && cp !== 0x200c && cp !== 0x200d)
  || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0xfeff || cp === 0x2028 || cp === 0x2029;

/** Collapse control chars to spaces/nothing, cap the length (by code points) and trim. */
function cleanText(value: unknown, maxCodePoints: number): string {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  const out: string[] = [];
  let lastSpace = true;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x2028 || cp === 0x2029) {
      if (!lastSpace) out.push(' ');
      lastSpace = true;
    } else if (!isIgnorable(cp)) {
      out.push(ch);
      lastSpace = ch === ' ';
    }
    if (out.length >= maxCodePoints) break;
  }
  return out.join('').trim();
}

const isNeutral = (cp: number) => cp === 0x20 || cp === 0x2d || cp === 0x2c || cp === 0x2e;

/** Split text into same-font runs; unsupported code points become '?' in the Latin font. */
function toRuns(text: string, files: Pick<FontFiles, 'latinChars' | 'devaChars'>): { script: 'latin' | 'deva'; text: string }[] {
  const runs: { script: 'latin' | 'deva'; text: string }[] = [];
  let previous = 'latin' as 'latin' | 'deva';
  const push = (script: 'latin' | 'deva', chunk: string) => {
    const last = runs[runs.length - 1];
    if (last && last.script === script) last.text += chunk;
    else runs.push({ script, text: chunk });
    previous = script;
  };
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x200c || cp === 0x200d) {
      if (previous === 'deva' && runs.length) push('deva', ch); // joiners only matter inside Devanagari
      continue;
    }
    if (isDevaRange(cp)) {
      if (files.devaChars.has(cp)) push('deva', ch);
      else push('latin', '?');
    } else if (isNeutral(cp) && previous === 'deva' && files.devaChars.has(cp)) {
      push('deva', ch); // keep spaces inside a Devanagari phrase in one shaped run
    } else if (files.latinChars.has(cp)) {
      push('latin', ch);
    } else if (files.devaChars.has(cp)) {
      push('deva', ch);
    } else {
      push('latin', '?'); // emoji, RTL scripts, CJK, ...
    }
  }
  return runs;
}

function runsWidth(runs: { script: 'latin' | 'deva'; text: string }[], fonts: FontSet, size: number): number {
  return runs.reduce((sum, r) => sum + fonts[r.script].widthOfTextAtSize(r.text, size), 0);
}

/** Greedy word wrap to maxWidth; over-long words are broken per code point; capped at maxLines with an ellipsis. */
function wrap(
  text: string,
  files: FontFiles,
  fonts: FontSet,
  size: number,
  maxWidth: number,
  maxLines: number,
): string[] {
  const widthOf = (s: string) => runsWidth(toRuns(s, files), fonts, size);
  const lines: string[] = [];
  let current = '';
  let truncated = false;
  const flush = () => {
    if (current) lines.push(current);
    current = '';
  };
  outer: for (const word of text.split(' ')) {
    if (!word) continue;
    const candidate = current ? `${current} ${word}` : word;
    if (widthOf(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    flush();
    if (lines.length >= maxLines) {
      truncated = true;
      break;
    }
    // the word on its own line, hard-broken if even that is too wide
    for (const ch of word) {
      if (widthOf(current + ch) > maxWidth && current) {
        flush();
        if (lines.length >= maxLines) {
          truncated = true;
          break outer;
        }
      }
      current += ch;
    }
  }
  flush();
  if (lines.length > maxLines) {
    lines.length = maxLines;
    truncated = true;
  }
  if (truncated && lines.length > 0) {
    let last = lines[lines.length - 1]!;
    while (last && widthOf(`${last}...`) > maxWidth) last = [...last].slice(0, -1).join('');
    lines[lines.length - 1] = `${last}...`;
  }
  return lines.length ? lines : [''];
}

type Op =
  | { kind: 'text'; lines: string[]; size: number; bold: boolean; gap: number }
  | { kind: 'rule' }
  | { kind: 'space'; amount: number };

const MARGIN_X = 24;
const CONTENT_WIDTH = 252;

function buildOps(data: ReceiptData, files: FontFiles, fonts: { regular: FontSet; bold: FontSet }): Op[] {
  const ops: Op[] = [];
  const text = (
    value: string,
    opts: { size?: number; bold?: boolean; gap?: number; maxLines?: number; maxChars?: number } = {},
  ) => {
    const size = opts.size ?? 10;
    const set = opts.bold ? fonts.bold : fonts.regular;
    const clean = cleanText(value, opts.maxChars ?? 200);
    ops.push({
      kind: 'text',
      lines: wrap(clean, files, set, size, CONTENT_WIDTH, opts.maxLines ?? 2),
      size,
      bold: Boolean(opts.bold),
      gap: opts.gap ?? size + 6,
    });
  };
  const rule = () => ops.push({ kind: 'rule' });
  const space = (amount: number) => ops.push({ kind: 'space', amount });

  text('PrintQ', { size: 16, bold: true, gap: 22 });
  text(data.shopName, { size: 12, bold: true, maxLines: 2 });
  text(data.shopAddress, { size: 9, maxLines: 3, maxChars: 300 });
  space(4);
  rule();

  text(`Job: ${data.jobId.slice(0, 8)}`);
  text(
    data.completedAt
      ? `Completed: ${data.completedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
      : `Ordered: ${data.createdAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
  );
  text(`Student: ${data.studentLabel}`, { maxLines: 2 });
  // The uploaded file's name is deliberately NOT printed: it is personal data
  // that is deleted after printing and a receipt outlives it.
  text(data.totalPages ? `Document (${data.totalPages} ${data.totalPages === 1 ? 'page' : 'pages'})` : 'Document');
  space(4);
  rule();

  text(`Copies: ${data.specs.copies}`);
  text(`Paper: ${data.specs.paperSize}${data.specs.color ? ' (colour)' : ' (B/W)'}`);
  text(`Sides: ${data.specs.duplex ? 'Both' : 'One'}`);
  text(`Binding: ${data.specs.binding ?? 'None'}`);
  text(`Pages: ${normalizePageRange(data.specs.pageRange, data.totalPages ?? null) ?? 'All'}`);
  space(4);
  rule();

  if (data.showPriceBreakdown !== false) {
    text(`Pages x copies: ${rupees(data.breakdown.pagesTotalPaise)}`);
    if (data.breakdown.bindingPaise > 0) text(`Binding: ${rupees(data.breakdown.bindingPaise)}`);
  }
  text(`Total: ${rupees(data.totalPaise)}`, { size: 12, bold: true, gap: 20 });
  text(`Payment: ${paymentLine(data)}`, { size: 9 });

  space(10);
  text('Thank you for using PrintQ.', { size: 8, gap: 12 });
  return ops;
}

function opHeight(op: Op): number {
  if (op.kind === 'text') return op.lines.length * op.gap;
  if (op.kind === 'rule') return 10;
  return op.amount;
}

async function prepareReceipt(data: ReceiptData) {
  const files = await loadFontFiles();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const [latin, latinBold, deva, devaBold] = await Promise.all([
    doc.embedFont(files.latin, { subset: true }),
    doc.embedFont(files.latinBold, { subset: true }),
    doc.embedFont(files.deva, { subset: true }),
    doc.embedFont(files.devaBold, { subset: true }),
  ]);
  const fonts = { regular: { latin, deva }, bold: { latin: latinBold, deva: devaBold } };

  return { doc, files, fonts, ops: buildOps(data, files, fonts) };
}

/** The wrapped text lines of the receipt, as laid out (before per-glyph substitution). For tests. */
export async function receiptLines(data: ReceiptData): Promise<string[]> {
  const { ops } = await prepareReceipt(data);
  return ops.flatMap((op) => (op.kind === 'text' ? op.lines : []));
}

/** Which font draws which part of a string, with unsupported characters already replaced by '?'. For tests. */
export async function receiptRuns(text: string): Promise<{ script: 'latin' | 'deva'; text: string }[]> {
  return toRuns(text, await loadFontFiles());
}

async function renderUnicodeReceipt(data: ReceiptData): Promise<Uint8Array> {
  const { doc, files, fonts, ops } = await prepareReceipt(data);
  const height = Math.max(380, 40 + ops.reduce((sum, op) => sum + opHeight(op), 0) + 30);
  const page = doc.addPage([300, height]);
  const color = rgb(0.1, 0.1, 0.1);

  let y = height - 40;
  for (const op of ops) {
    if (op.kind === 'rule') {
      page.drawLine({ start: { x: MARGIN_X, y }, end: { x: MARGIN_X + CONTENT_WIDTH, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
      y -= 10;
    } else if (op.kind === 'space') {
      y -= op.amount;
    } else {
      const set = op.bold ? fonts.bold : fonts.regular;
      for (const line of op.lines) {
        let x = MARGIN_X;
        for (const run of toRuns(line, files)) {
          const font = set[run.script];
          page.drawText(run.text, { x, y, size: op.size, font, color });
          x += font.widthOfTextAtSize(run.text, op.size);
        }
        y -= op.gap;
      }
    }
  }
  return doc.save();
}

/** Plain ASCII: anything outside printable ASCII becomes '?'. Only used if the Unicode path fails. */
const ascii = (value: unknown, max: number) =>
  [...cleanText(value, max)].map((ch) => (ch.codePointAt(0)! >= 0x20 && ch.codePointAt(0)! < 0x7f ? ch : '?')).join('');

async function renderAsciiReceipt(data: ReceiptData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 360]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = [
    'PrintQ receipt',
    ascii(data.shopName, 60),
    `Job: ${ascii(data.jobId, 8)}`,
    `Student: ${ascii(data.studentLabel, 40)}`,
    data.totalPages ? `Document (${Number(data.totalPages) || 0} pages)` : 'Document',
    `Copies: ${Number(data.specs?.copies) || 1}`,
    `Total: ${rupees(Number(data.totalPaise) || 0)}`,
    `Payment: ${ascii(paymentLine(data), 40)}`,
  ];
  let y = 330;
  for (const line of lines) {
    page.drawText(line.slice(0, 48), { x: MARGIN_X, y, size: 10, font });
    y -= 18;
  }
  return doc.save();
}

/**
 * A simple one-page receipt PDF — no external template dependency. All text is
 * Unicode-safe (Noto Sans + Devanagari, per-glyph fallback) and the function
 * never throws: a failure degrades to a minimal ASCII receipt.
 */
export async function renderReceipt(data: ReceiptData): Promise<Uint8Array> {
  try {
    return await renderUnicodeReceipt(data);
  } catch (error) {
    logger.error({ error, jobId: data.jobId }, 'receipt_unicode_render_failed');
  }
  try {
    return await renderAsciiReceipt(data);
  } catch (error) {
    logger.error({ error, jobId: data.jobId }, 'receipt_ascii_render_failed');
  }
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  page.drawText('PrintQ receipt', { x: MARGIN_X, y: 150, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  return doc.save();
}
