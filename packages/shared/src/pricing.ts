import type { JobSpecs, PriceBreakdown, PrintOptions, ResolvedCoupon } from './types.js';
import { countSelectedPages } from './pageRange.js';

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

  const perPagePaise = specs.color ? paper.colorPaise : paper.bwPaise;
  if (perPagePaise == null) throw new PricingError(`${paper.label} is available in black & white only`);

  const pagesPerCopy = countSelectedPages(specs.pageRange, totalPages);
  const pagesTotalPaise = perPagePaise * pagesPerCopy * specs.copies;

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
    copies: specs.copies,
    perPagePaise,
    pagesTotalPaise,
    bindingLabel,
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
