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
/** Sanity ceilings: no spec sets a price, these only stop typos like 2000 for 20. */
export const MAX_PAGE_PRICE_PAISE = 10_000; // Rs 100 per page
export const MAX_BINDING_PRICE_PAISE = 100_000; // Rs 1000 per job

export const printOptionsSchema = z
  .object({
    papers: z
      .array(
        z.object({
          id: optionId,
          label: z.string().trim().min(1).max(40),
          bwPaise: z.number().int().min(0).max(MAX_PAGE_PRICE_PAISE, 'Price per page can be at most ₹100'),
          colorPaise: z
            .number()
            .int()
            .min(0)
            .max(MAX_PAGE_PRICE_PAISE, 'Price per page can be at most ₹100')
            .nullable(),
        }),
      )
      .min(1, 'Add at least one paper type')
      .max(12),
    bindings: z
      .array(
        z.object({
          id: optionId,
          label: z.string().trim().min(1).max(40),
          paise: z.number().int().min(0).max(MAX_BINDING_PRICE_PAISE, 'Binding price can be at most ₹1000'),
        }),
      )
      .max(12),
    duplexEnabled: z.boolean(),
  })
  .superRefine((menu, ctx) => {
    const seenPapers = new Set<string>();
    menu.papers.forEach((paper, index) => {
      const key = paper.id.toLowerCase();
      if (seenPapers.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['papers', index, 'id'], message: `Duplicate paper type "${paper.id}"` });
      }
      seenPapers.add(key);
      if (paper.colorPaise != null && paper.colorPaise < paper.bwPaise) {
        ctx.addIssue({
          code: 'custom',
          path: ['papers', index, 'colorPaise'],
          message: `Colour price for "${paper.label}" cannot be lower than its black & white price`,
        });
      }
    });
    const seenBindings = new Set<string>();
    menu.bindings.forEach((binding, index) => {
      const key = binding.id.toLowerCase();
      if (key === 'none') {
        // "None" is always offered implicitly (binding: null); a real row with
        // this id would shadow it.
        ctx.addIssue({ code: 'custom', path: ['bindings', index, 'id'], message: '"none" is reserved — it is always offered automatically' });
      }
      if (seenBindings.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['bindings', index, 'id'], message: `Duplicate binding "${binding.id}"` });
      }
      seenBindings.add(key);
    });
  });

export const printerInputSchema = z.object({
  label: z.string().trim().min(1).max(80),
  paperSizesLoaded: z.array(optionId).min(1).max(12),
  colorSupport: z.boolean(),
  currentlyLoadedPaper: z.string().trim().max(80).optional(),
  finishingOptions: z.array(optionId).max(12).default([]),
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

/**
 * zod 4 dropped `required_error`: a missing (undefined) value gets the
 * field-named message, any other type error keeps zod's default text.
 */
const required = (message: string) => ({
  error: (issue: { input?: unknown }) => (issue.input === undefined ? message : undefined),
});

/** Self-serve shop onboarding. Messages name the field so the form can show them verbatim. */
export const shopRegisterSchema = z.object({
  shopName: z
    .string(required('Shop name is required'))
    .trim()
    .min(2, 'Shop name must be at least 2 characters')
    .max(120, 'Shop name must be at most 120 characters'),
  address: z
    .string(required('Address is required'))
    .trim()
    .min(3, 'Address must be at least 3 characters')
    .max(300, 'Address must be at most 300 characters'),
  campusName: z.string().trim().max(120, 'Campus name must be at most 120 characters').optional(),
  ownerName: z
    .string(required('Owner name is required'))
    .trim()
    .min(1, 'Owner name is required')
    .max(80, 'Owner name must be at most 80 characters'),
  email: z
    .string(required('Email is required'))
    .trim()
    .toLowerCase()
    .email('Email is invalid')
    .max(254, 'Email must be at most 254 characters'),
  password: z
    .string(required('Password is required'))
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
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
  printerId: z.uuid().optional(),
  /** Explicit staff confirmation for a paid order outside the revealed band. */
  overrideQueue: z.boolean().default(false),
  /**
   * An attended counter confirmation. Amount is deliberately absent: the API
   * always records the immutable server-calculated job total, never a value
   * supplied by a browser or a staff member.
   */
  paymentConfirmation: z.object({
    method: z.enum(['cash', 'shop_upi']),
    /** Optional merchant-app reference observed by staff; it is never proof by itself. */
    reference: z.string().trim().min(1).max(120).optional(),
  }).strict().optional(),
});

export const couponCodeSchema = z.string().trim().min(1).max(40);

export const createJobSchema = z
  .object({
    fileId: z.uuid(),
    specs: jobSpecsSchema,
    mode: z.enum(JOB_MODES).default('instant'),
    /** required for scheduled mode: 15 min – 72 h ahead */
    scheduledTime: z.coerce.date().optional(),
    couponCode: couponCodeSchema.optional(),
  })
  // There is one student checkout option: pay at shop. Reject stale online
  // and cash selector fields rather than silently accepting a client-selected
  // money rail during a rolling release.
  .strict()
  .superRefine((val, ctx) => {
    if (val.mode === 'scheduled') {
      if (!val.scheduledTime) {
        ctx.addIssue({ code: 'custom', path: ['scheduledTime'], message: 'Pick a time slot' });
        return;
      }
      const ahead = val.scheduledTime.getTime() - Date.now();
      if (ahead < 15 * 60_000 || ahead > 72 * 3_600_000) {
        ctx.addIssue({
          code: 'custom',
          path: ['scheduledTime'],
          message: 'Slot must be between 15 minutes and 72 hours from now',
        });
      }
    }
  });
