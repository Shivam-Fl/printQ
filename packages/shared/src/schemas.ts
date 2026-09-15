import { z } from 'zod';
import { JOB_MODES, PRINTER_STATUSES } from './types.js';

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

/** Paper/binding are shop-defined ids — validated against the shop at request time. */
const optionId = z.string().trim().min(1).max(40);

export const jobSpecsSchema = z.object({
  copies: z.number().int().min(1).max(100),
  paperSize: optionId,
  color: z.boolean(),
  duplex: z.boolean(),
  binding: optionId.nullable().default(null),
  pageRange: pageRangeSchema.nullable().default(null),
});
export type JobSpecsInput = z.infer<typeof jobSpecsSchema>;

/** Shop's configurable print menu (Settings page). */
export const printOptionsSchema = z.object({
  papers: z
    .array(
      z.object({
        id: optionId,
        label: z.string().trim().min(1).max(40),
        bwPaise: z.number().int().min(0).max(1_000_000),
        colorPaise: z.number().int().min(0).max(1_000_000).nullable(),
      }),
    )
    .min(1, 'Add at least one paper type')
    .max(12),
  bindings: z
    .array(
      z.object({
        id: optionId,
        label: z.string().trim().min(1).max(40),
        paise: z.number().int().min(0).max(1_000_000),
      }),
    )
    .max(12),
  duplexEnabled: z.boolean(),
});

export const printerInputSchema = z.object({
  label: z.string().trim().min(1).max(80),
  paperSizesLoaded: z.array(optionId).min(1),
  colorSupport: z.boolean(),
  currentlyLoadedPaper: z.string().trim().max(80).optional(),
  finishingOptions: z.array(optionId).default([]),
  avgPagesPerMinute: z.number().int().min(1).max(200).default(15),
  status: z.enum(PRINTER_STATUSES).default('online'),
  /** exact OS/spooler printer name to dispatch to — set via the detected-printer picker */
  osPrinterName: z.string().trim().min(1).max(200).nullable().optional(),
  /**
   * Per shop-paper mapping to the Windows driver's physical paper size and
   * optional tray/bin name. Example: `college` -> A4 from "Tray 2".
   */
  mediaConfig: z.record(
    optionId,
    z.object({
      paperSize: z.string().trim().min(1).max(80),
      bin: z.string().trim().min(1).max(120).nullable().optional(),
    }),
  ).optional(),
});
export type PrinterInput = z.infer<typeof printerInputSchema>;

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

const shopEmail = z.string().trim().toLowerCase().email().max(254);
/** Short numeric PIN — fast entry on a shared counter PC, not a full password. */
const staffPin = z.string().trim().regex(/^\d{4,6}$/, 'PIN is 4-6 digits');

export const requestPasswordResetSchema = z.object({ email: shopEmail });

export const confirmPasswordResetSchema = z.object({
  email: shopEmail,
  otp: z.string().trim().regex(/^\d{6}$/, 'Code is 6 digits'),
  newPassword: z.string().min(8).max(128),
});

export const createStaffSchema = z.object({
  email: shopEmail,
  name: z.string().trim().min(1).max(80),
  pin: staffPin,
});

export const staffLoginSchema = z.object({
  email: shopEmail,
  pin: staffPin,
});

export const releaseOtpSchema = z.object({
  otp: z.string().trim().regex(/^\d{6}$/, 'OTP is 6 digits'),
  /** manual-mode: shop picks the printer; auto-mode: omitted */
  printerId: z.string().uuid().optional(),
  /** Explicit staff confirmation for a paid order outside the near-front window. */
  overrideQueue: z.boolean().default(false),
  /** Required before a cash order can transition to the printer. */
  cashReceived: z.boolean().default(false),
});

export const couponCodeSchema = z.string().trim().min(1).max(40);

export const createJobSchema = z
  .object({
    fileId: z.string().uuid(),
    specs: jobSpecsSchema,
    mode: z.enum(JOB_MODES).default('instant'),
    /** required for scheduled mode: 15 min – 72 h ahead */
    scheduledTime: z.coerce.date().optional(),
    couponCode: couponCodeSchema.optional(),
    paymentMethod: z.enum(['online', 'cash']).default('online'),
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
