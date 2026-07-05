import type { JobSpecs, PriceBreakdown, RateCard } from './types.js';
import { countSelectedPages } from './pageRange.js';

export function pageRateKey(specs: Pick<JobSpecs, 'paperSize' | 'color'>): string {
  return `${specs.paperSize}_${specs.color ? 'color' : 'bw'}`;
}

/**
 * Server-side price computation. The client only ever sends specs — any price
 * it displays is advisory. This function (with the shop's rate card) is the
 * single authority for what a job costs.
 */
export function computePrice(
  specs: JobSpecs,
  totalPages: number,
  rateCard: RateCard,
): PriceBreakdown {
  const key = pageRateKey(specs);
  const perPagePaise = rateCard.pagePrices[key];
  if (perPagePaise === undefined) {
    throw new Error(`Shop has no rate configured for ${key}`);
  }
  const pagesPerCopy = countSelectedPages(specs.pageRange, totalPages);
  const pagesTotalPaise = perPagePaise * pagesPerCopy * specs.copies;
  const bindingPaise = specs.binding ? (rateCard.bindingPrices[specs.binding] ?? 0) : 0;
  return {
    pagesPerCopy,
    copies: specs.copies,
    perPagePaise,
    pagesTotalPaise,
    bindingPaise,
    totalPaise: pagesTotalPaise + bindingPaise,
  };
}

export const DEFAULT_RATE_CARD: RateCard = {
  pagePrices: {
    A4_bw: 200, // ₹2.00
    A4_color: 1000, // ₹10.00
    A3_bw: 500,
    A3_color: 2000,
  },
  bindingPrices: {
    stapling: 0,
    spiral_binding: 3000, // ₹30.00
  },
};
