import type { JobSpecs, PriceBreakdown, PriceLine, PrintOptions, PrintPart, ResolvedCoupon } from './types.js';
import { countSelectedPages, formatPageList, parsePageRange } from './pageRange.js';

/** Sensible starting options for a new shop (owner edits these in Settings). */
export const DEFAULT_PRINT_OPTIONS: PrintOptions = {
  papers: [
    { id: 'A4', label: 'A4', bwPaise: 200, colorPaise: 1000 },
    { id: 'A3', label: 'A3', bwPaise: 500, colorPaise: 2000 },
  ],
  bindings: [
    { id: 'stapling', label: 'Stapling', paise: 0 },
    { id: 'spiral_binding', label: 'Spiral binding', paise: 3000 },
  ],
  duplexEnabled: true,
};

export class PricingError extends Error {}

/**
 * The validated per-part plan of an order, or null for one-setting orders.
 * Every part must name pages inside the document, and no page may be in two
 * parts. Throws PricingError otherwise.
 */
export function printPlan(specs: Pick<JobSpecs, 'parts'>, totalPages: number): PrintPart[] | null {
  const parts = specs.parts;
  if (!parts || parts.length === 0) return null;
  const seen = new Set<number>();
  for (const part of parts) {
    let pages: number[];
    try {
      pages = parsePageRange(part.pages, totalPages);
    } catch {
      throw new PricingError('Some selected pages are not in this order');
    }
    for (const page of pages) {
      if (seen.has(page)) throw new PricingError('A page can only be printed with one set of settings');
      seen.add(page);
    }
  }
  return parts;
}

/**
 * The specs the server stores for a job. For a per-part order the order-level
 * fields become summaries (any colour, any two-sided, every chosen page,
 * copies 1), so hardware checks, queue estimates and older readers stay right.
 */
export function normalizeJobSpecs(specs: JobSpecs, totalPages: number): JobSpecs {
  const plan = printPlan(specs, totalPages);
  const { parts: _parts, ...rest } = specs;
  if (!plan) return rest;
  const pages = new Set(plan.flatMap((part) => parsePageRange(part.pages, totalPages)));
  return {
    ...rest,
    copies: 1,
    color: plan.some((part) => part.color),
    duplex: plan.some((part) => part.duplex),
    pageRange: pages.size === totalPages ? null : formatPageList(pages),
    parts: plan.map((part) => ({ pages: formatPageList(parsePageRange(part.pages, totalPages)), copies: part.copies, color: part.color, duplex: part.duplex })),
  };
}

/** The shared per-page rate of some lines, or 0 when they differ. */
const sharedRate = (lines: PriceLine[]): number =>
  lines.every((line) => line.perPagePaise === lines[0]?.perPagePaise) ? (lines[0]?.perPagePaise ?? 0) : 0;

/**
 * Server-side price computation. The client only sends specs (paper/binding
 * ids); this function, with the shop's PrintOptions, is the single authority
 * for what a job costs. Throws PricingError if the specs reference an option
 * the shop doesn't offer.
 */
export function computePrice(
  specs: JobSpecs,
  totalPages: number,
  options: PrintOptions,
): PriceBreakdown {
  const paper = options.papers.find((p) => p.id === specs.paperSize);
  if (!paper) throw new PricingError(`This shop doesn't offer "${specs.paperSize}" paper`);

  const rate = (color: boolean): number => {
    const paise = color ? paper.colorPaise : paper.bwPaise;
    if (paise == null) throw new PricingError(`${paper.label} is available in black & white only`);
    return paise;
  };

  const plan = printPlan(specs, totalPages);
  let lines: PriceLine[] | undefined;
  let perPagePaise: number;
  let pagesPerCopy: number;
  let copies: number;
  let pagesTotalPaise: number;
  if (plan) {
    lines = plan.map((part) => {
      const pages = countSelectedPages(part.pages, totalPages);
      const perPage = rate(part.color);
      return { pages, copies: part.copies, color: part.color, perPagePaise: perPage, totalPaise: perPage * pages * part.copies };
    });
    perPagePaise = sharedRate(lines);
    pagesPerCopy = lines.reduce((sum, line) => sum + line.pages * line.copies, 0);
    copies = 1;
    pagesTotalPaise = lines.reduce((sum, line) => sum + line.totalPaise, 0);
  } else {
    perPagePaise = rate(specs.color);
    pagesPerCopy = countSelectedPages(specs.pageRange, totalPages);
    copies = specs.copies;
    pagesTotalPaise = perPagePaise * pagesPerCopy * copies;
  }

  let bindingPaise = 0;
  let bindingLabel: string | null = null;
  if (specs.binding) {
    const binding = options.bindings.find((b) => b.id === specs.binding);
    if (!binding) throw new PricingError(`This shop doesn't offer that binding`);
    bindingPaise = binding.paise;
    bindingLabel = binding.label;
  }

  return {
    paperLabel: paper.label,
    pagesPerCopy,
    copies,
    perPagePaise,
    pagesTotalPaise,
    bindingLabel,
    bindingPaise,
    discountPaise: 0,
    totalPaise: pagesTotalPaise + bindingPaise,
    ...(lines ? { lines } : {}),
  };
}

/**
 * Convert the shop's private base rate into the only price students see.
 * Markup is applied to each sellable unit in integer paise so the displayed
 * per-page price always multiplies exactly to the displayed subtotal.
 */
export function applyPlatformMarkup(base: PriceBreakdown, markupBps: number): PriceBreakdown {
  if (!Number.isInteger(markupBps) || markupBps < 0 || markupBps > 10_000) {
    throw new PricingError('Platform markup must be between 0% and 100%');
  }
  const multiplier = (10_000 + markupBps) / 10_000;
  const bindingPaise = Math.round(base.bindingPaise * multiplier);
  if (base.lines) {
    // each run is marked up per page, so every line still multiplies exactly
    const lines = base.lines.map((line) => {
      const perPage = Math.round(line.perPagePaise * multiplier);
      return { ...line, perPagePaise: perPage, totalPaise: perPage * line.pages * line.copies };
    });
    const pagesTotalPaise = lines.reduce((sum, line) => sum + line.totalPaise, 0);
    return {
      ...base,
      lines,
      perPagePaise: sharedRate(lines),
      pagesTotalPaise,
      bindingPaise,
      discountPaise: 0,
      totalPaise: pagesTotalPaise + bindingPaise,
    };
  }
  const perPagePaise = Math.round(base.perPagePaise * multiplier);
  const pagesTotalPaise = perPagePaise * base.pagesPerCopy * base.copies;
  return {
    ...base,
    perPagePaise,
    pagesTotalPaise,
    bindingPaise,
    discountPaise: 0,
    totalPaise: pagesTotalPaise + bindingPaise,
  };
}

/** Minimum a job can cost after any discount — matches the platform's ₹1 order floor. */
const MIN_ORDER_PAISE = 100;

/** Applies an already-resolved (valid, in-scope) coupon on top of a computed price. */
export function applyCoupon(breakdown: PriceBreakdown, coupon: ResolvedCoupon): PriceBreakdown {
  const preDiscountTotal = breakdown.pagesTotalPaise + breakdown.bindingPaise;
  const rawDiscount = coupon.percentOff
    ? Math.round((preDiscountTotal * coupon.percentOff) / 100)
    : (coupon.paiseOff ?? 0);
  const discountPaise = Math.min(rawDiscount, Math.max(0, preDiscountTotal - MIN_ORDER_PAISE));

  return {
    ...breakdown,
    discountPaise,
    totalPaise: preDiscountTotal - discountPaise,
  };
}
