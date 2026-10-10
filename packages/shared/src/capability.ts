import type { JobSpecs, PrinterProfile } from './types.js';

export type UnsupportedCode = 'color' | 'paper_size' | 'binding' | 'combination';

export interface UnsupportedSpec {
  code: UnsupportedCode;
  /** Student-friendly, no jargon. */
  message: string;
}

type CapabilityPrinter = Pick<PrinterProfile, 'paperSizesLoaded' | 'colorSupport' | 'finishingOptions'>;

const pretty = (id: string) => id.replace(/_/g, ' ');

/**
 * Can this shop's configured hardware produce the requested job at all?
 *
 * Capability is judged over every configured printer profile, online or not:
 * a printer that is temporarily offline must not block ordering, but a shop
 * with no colour (or no A3, or no binding) printer cannot ever fulfil the job,
 * so the student should hear it now rather than at the counter. Duplex is not
 * modelled on printer profiles (the driver downgrades it), so it is not checked.
 * Returns [] when the job is producible.
 */
export function unsupportedSpecs(printers: CapabilityPrinter[], specs: JobSpecs): UnsupportedSpec[] {
  if (printers.length === 0) return [];
  const out: UnsupportedSpec[] = [];
  const paperOk = printers.some((p) => p.paperSizesLoaded.includes(specs.paperSize));
  const colorOk = !specs.color || printers.some((p) => p.colorSupport);
  const bindingOk = !specs.binding || printers.some((p) => p.finishingOptions.includes(specs.binding as string));
  if (!paperOk) {
    out.push({ code: 'paper_size', message: `This shop doesn't have ${specs.paperSize.toUpperCase()} paper available. Choose another paper size.` });
  }
  if (!colorOk) {
    out.push({ code: 'color', message: "This shop can't print in colour. Choose black & white." });
  }
  if (!bindingOk) {
    out.push({ code: 'binding', message: `This shop can't do ${pretty(specs.binding as string)}. Choose no binding.` });
  }
  if (out.length === 0) {
    const jointly = printers.some(
      (p) =>
        p.paperSizesLoaded.includes(specs.paperSize)
        && (!specs.color || p.colorSupport)
        && (!specs.binding || p.finishingOptions.includes(specs.binding)),
    );
    if (!jointly) {
      out.push({
        code: 'combination',
        message: 'No printer at this shop can do this exact combination of options. Try changing the paper, colour or binding.',
      });
    }
  }
  return out;
}
