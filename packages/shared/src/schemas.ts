import { z } from 'zod';
import { FINISHING_OPTIONS, JOB_MODES, PAPER_SIZES, PRINTER_STATUSES } from './types.js';

/** Indian mobile normalized to E.164 (+91XXXXXXXXXX). Accepts 10-digit input. */
export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .pipe(
    z
      .string()
      .regex(/^(\+91)?[6-9]\d{9}$/, 'Enter a valid Indian mobile number')
      .transform((v) => (v.startsWith('+91') ? v : `+91${v}`)),
  );

export const pageRangeSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^\d+(-\d+)?(\s*,\s*\d+(-\d+)?)*$/, 'Use a format like 1-5,8');

export const jobSpecsSchema = z.object({
  copies: z.number().int().min(1).max(100),
  paperSize: z.enum(PAPER_SIZES),
  color: z.boolean(),
  duplex: z.boolean(),
  binding: z.enum(FINISHING_OPTIONS).nullable().default(null),
  pageRange: pageRangeSchema.nullable().default(null),
});
export type JobSpecsInput = z.infer<typeof jobSpecsSchema>;

export const printerInputSchema = z.object({
  label: z.string().trim().min(1).max(80),
  paperSizesLoaded: z.array(z.enum(PAPER_SIZES)).min(1),
  colorSupport: z.boolean(),
  currentlyLoadedPaper: z.string().trim().max(80).optional(),
  finishingOptions: z.array(z.enum(FINISHING_OPTIONS)).default([]),
  avgPagesPerMinute: z.number().int().min(1).max(200).default(15),
  status: z.enum(PRINTER_STATUSES).default('online'),
});
export type PrinterInput = z.infer<typeof printerInputSchema>;

export const rateCardSchema = z.object({
  pagePrices: z.record(z.string(), z.number().int().min(0).max(1_000_000)),
  bindingPrices: z.record(z.enum(FINISHING_OPTIONS), z.number().int().min(0).max(1_000_000)),
});

export const requestLoginOtpSchema = z.object({
  phone: phoneSchema,
  name: z.string().trim().min(1).max(80).optional(),
});

export const verifyLoginOtpSchema = z.object({
  phone: phoneSchema,
  otp: z.string().trim().regex(/^\d{6}$/, 'OTP is 6 digits'),
});

export const shopLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(128),
});

export const releaseOtpSchema = z.object({
  otp: z.string().trim().regex(/^\d{6}$/, 'OTP is 6 digits'),
  /** manual-mode: shop picks the printer; auto-mode: omitted */
  printerId: z.string().uuid().optional(),
});

export const createJobSchema = z
  .object({
    fileId: z.string().uuid(),
    specs: jobSpecsSchema,
    mode: z.enum(JOB_MODES).default('instant'),
    /** required for scheduled mode: 15 min – 72 h ahead */
    scheduledTime: z.coerce.date().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.mode === 'scheduled') {
      if (!val.scheduledTime) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduledTime'], message: 'Pick a time slot' });
        return;
      }
      const ahead = val.scheduledTime.getTime() - Date.now();
      if (ahead < 15 * 60_000 || ahead > 72 * 3_600_000) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scheduledTime'],
          message: 'Slot must be between 15 minutes and 72 hours from now',
        });
      }
    }
  });
