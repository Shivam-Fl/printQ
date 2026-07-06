import { DEFAULT_PRINT_OPTIONS, type PrintOptions } from '@printq/shared';

/** A shop's print menu, falling back to sensible defaults when unset. */
export function shopOptions(shop: { printOptions: unknown }): PrintOptions {
  return (shop.printOptions as PrintOptions | null) ?? DEFAULT_PRINT_OPTIONS;
}
