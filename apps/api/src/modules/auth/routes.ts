import { Router } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import {
  DEFAULT_PRINT_OPTIONS,
  confirmPasswordResetSchema,
  requestLoginOtpSchema,
  requestPasswordResetSchema,
  shopLoginSchema,
  shopRegisterSchema,
  staffLoginSchema,
  verifyLoginOtpSchema,
} from '@printq/shared';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound, tooMany, unauthorized } from '../../lib/errors.js';
import { generateOtp, hashOtp, verifyOtpHash } from '../../lib/otp.js';
import { signShopToken, signStudentToken } from '../../lib/tokens.js';
import { validateBody } from '../../middleware/validate.js';
import {
  firebaseSessionLimiter,
  loginLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  pinLoginFailureLimiter,
  registerLimiter,
} from '../../middleware/rateLimit.js';
import { requireShopUser, requireStudent } from '../../middleware/auth.js';
import { sendLoginOtp } from '../../providers/notification/index.js';
import { emailProvider } from '../../providers/email/index.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { verifyFirebasePhoneIdToken } from '../../providers/firebaseAuth/index.js';

export const authRouter = Router();

const LOGIN_OTP_TTL_MS = 5 * 60_000;
const MAX_LOGIN_OTP_ATTEMPTS = 5;
const LOGIN_OTP_RESEND_MS = 60_000;
const MAX_LOGIN_OTP_SENDS_PER_PHONE_PER_DAY = 10;

/** Step 1 of student login: send a 6-digit OTP to the phone. */
authRouter.post(
  '/student/request-otp',
  otpRequestLimiter,
  validateBody(requestLoginOtpSchema),
  asyncHandler(async (req, res) => {
    if (env.STUDENT_AUTH_PROVIDER !== 'local') throw notFound();
    const { phone } = req.body as { phone: string };

    // A per-IP limiter alone is weak on mobile networks and campus Wi-Fi. These
    // database-backed phone limits also survive Redis restarts and directly
    // cap the maximum paid-SMS exposure for one number.
    const now = new Date();
    const recent = await prisma.loginOtp.findFirst({
      where: { phone, createdAt: { gt: new Date(now.getTime() - LOGIN_OTP_RESEND_MS) } },
      select: { id: true },
    });
    if (recent) throw tooMany('Please wait a minute before requesting another code');
    const sentToday = await prisma.loginOtp.count({
      where: { phone, createdAt: { gt: new Date(now.getTime() - 24 * 60 * 60_000) } },
    });
    if (sentToday >= MAX_LOGIN_OTP_SENDS_PER_PHONE_PER_DAY) {
      throw tooMany('Too many codes requested for this number today', 3_600);
    }

    const otp = generateOtp();
    await prisma.loginOtp.create({
      data: {
        phone,
        otpHash: await hashOtp(otp),
        expiresAt: new Date(Date.now() + LOGIN_OTP_TTL_MS),
      },
    });
    // dev: the code appears in the API console; launch: wire SMS in sendLoginOtp
    await sendLoginOtp(phone, otp);
    res.json({ ok: true });
  }),
);

/** Step 2: verify OTP → JWT. Creates the student record on first login. */
authRouter.post(
  '/student/verify-otp',
  otpVerifyLimiter,
  validateBody(verifyLoginOtpSchema),
  asyncHandler(async (req, res) => {
    if (env.STUDENT_AUTH_PROVIDER !== 'local') throw notFound();
    const { phone, otp } = req.body as { phone: string; otp: string };

    const record = await prisma.loginOtp.findFirst({
      where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, otpHash: true },
    });
    if (!record) throw badRequest('Code expired or not found — request a new one');

    // Claim one of the 5 attempts BEFORE checking the code. A read-then-increment
    // check let a parallel burst evaluate every guess (M1); this conditional
    // increment is atomic, so at most 5 requests ever reach verifyOtpHash.
    const claimed = await prisma.loginOtp.updateMany({
      where: { id: record.id, consumedAt: null, attempts: { lt: MAX_LOGIN_OTP_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) throw badRequest('Too many wrong attempts — request a new code');

    if (!(await verifyOtpHash(record.otpHash, otp))) throw unauthorized('Incorrect code');

    // Single use, even when the right code is sent twice at once.
    const consumed = await prisma.loginOtp.updateMany({
      where: { id: record.id, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw badRequest('Code expired or already used — request a new one');
    const student = await prisma.student.upsert({
      where: { phone },
      create: { phone },
      update: {},
    });
    res.json({
      token: signStudentToken(student.id),
      student: { id: student.id, phone: student.phone, name: student.name },
    });
  }),
);

/**
 * Production student login: Firebase proves control of the phone number, then
 * PrintQ creates its own student/session. The browser can never choose which
 * phone number is attached to the account.
 */
authRouter.post(
  '/student/firebase-login',
  firebaseSessionLimiter,
  validateBody(z.object({ idToken: z.string().min(100).max(8_000) })),
  asyncHandler(async (req, res) => {
    if (env.STUDENT_AUTH_PROVIDER !== 'firebase') throw notFound();
    const identity = await verifyFirebasePhoneIdToken((req.body as { idToken: string }).idToken);
    if (!identity) throw unauthorized('Phone verification expired — request a new code');

    const student = await prisma.$transaction(async (tx) => {
      const [byUid, byPhone] = await Promise.all([
        tx.student.findUnique({ where: { firebaseUid: identity.uid } }),
        tx.student.findUnique({ where: { phone: identity.phone } }),
      ]);
      // A UID/phone mismatch is an account-security event; never silently
      // rebind an internal student record to a different Firebase identity.
      if (byUid && byUid.phone !== identity.phone) throw unauthorized('Firebase account identity changed');
      if (byPhone?.firebaseUid && byPhone.firebaseUid !== identity.uid) {
        throw unauthorized('This phone is linked to a different Firebase account');
      }
      if (byUid) return byUid;
      if (byPhone) {
        return tx.student.update({ where: { id: byPhone.id }, data: { firebaseUid: identity.uid } });
      }
      return tx.student.create({ data: { phone: identity.phone, firebaseUid: identity.uid } });
    });
    res.json({
      token: signStudentToken(student.id),
      student: { id: student.id, phone: student.phone, name: student.name },
    });
  }),
);

authRouter.get(
  '/student/me',
  requireStudent,
  asyncHandler(async (req, res) => {
    const student = await prisma.student.findUnique({
      where: { id: req.student!.id },
      select: { id: true, phone: true, name: true },
    });
    res.json({ student });
  }),
);

/** Set/update the student's display name (post-login only). */
authRouter.patch(
  '/student/me',
  requireStudent,
  asyncHandler(async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : '';
    if (!name) throw badRequest('Name is required');
    const student = await prisma.student.update({
      where: { id: req.student!.id },
      data: { name },
      select: { id: true, phone: true, name: true },
    });
    res.json({ student });
  }),
);

const DUPLICATE_EMAIL = 'An account with this email already exists';

/** Phase 2: self-serve shop onboarding — creates the shop + its owner login. */
authRouter.post(
  '/shop/register',
  registerLimiter,
  validateBody(shopRegisterSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof shopRegisterSchema>;

    // Known trade-off: this reveals whether an email is registered (account
    // enumeration). Kept deliberately so a returning owner gets a clear message;
    // the endpoint is behind registerLimiter.
    const emailTaken = async () =>
      Boolean(await prisma.shopUser.findUnique({ where: { email: body.email }, select: { id: true } }));
    if (await emailTaken()) throw conflict(DUPLICATE_EMAIL);

    const baseSlug = body.shopName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'shop';
    const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });

    // Shop + owner are created together or not at all (S8): a retried or
    // double submit used to 500 and leave an owner-less auto-live shop behind.
    // A unique-constraint race is either the same email (clean 409) or two
    // same-name shops grabbing one slug (pick the next free slug and retry).
    const createShopWithOwner = (slug: string) =>
      prisma.$transaction(async (tx) => {
        const shop = await tx.shop.create({
          data: {
            slug,
            name: body.shopName,
            address: body.address,
            campusName: body.campusName ?? null,
            // New shops go live automatically once setup is complete; no campus required.
            autoLive: true,
            autoAssignEnabled: true,
            rateCard: {}, // legacy column, superseded by printOptions
            printOptions: DEFAULT_PRINT_OPTIONS as unknown as object,
          },
          select: { id: true, slug: true, name: true },
        });
        const user = await tx.shopUser.create({
          data: { shopId: shop.id, email: body.email, passwordHash, name: body.ownerName, role: 'owner' },
          select: { id: true, name: true, role: true },
        });
        return { shop, user };
      });

    let created: Awaited<ReturnType<typeof createShopWithOwner>> | null = null;
    for (let attempt = 0; !created; attempt += 1) {
      let slug = baseSlug;
      for (let i = 2; await prisma.shop.findUnique({ where: { slug }, select: { id: true } }); i++) {
        slug = `${baseSlug}-${i}`;
      }
      try {
        created = await createShopWithOwner(slug);
      } catch (error) {
        const uniqueRace = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        if (!uniqueRace) throw error;
        if (await emailTaken()) throw conflict(DUPLICATE_EMAIL);
        if (attempt >= 4) throw error;
      }
    }
    const { shop, user } = created;

    res.status(201).json({
      token: signShopToken(user.id, shop.id, 'owner'),
      user: { id: user.id, name: user.name, role: user.role, shopId: shop.id },
      shop: { slug: shop.slug, name: shop.name },
    });
  }),
);

/** Shop staff login: email + password (argon2id). */
authRouter.post(
  '/shop/login',
  loginLimiter,
  validateBody(shopLoginSchema),
  // a staff PIN also works here, so PIN-shaped guesses share the per-account brake
  pinLoginFailureLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as { email: string; password: string };
    const user = await prisma.shopUser.findUnique({ where: { email } });
    // verify against a dummy hash when the user doesn't exist so response
    // timing doesn't reveal which emails are registered
    const hash =
      user?.passwordHash ??
      '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const valid = await argon2.verify(hash, password).catch(() => false);
    if (!user || !valid) throw unauthorized('Invalid email or password');

    res.json({
      token: signShopToken(user.id, user.shopId, user.role, user.sessionVersion),
      user: { id: user.id, name: user.name, role: user.role, shopId: user.shopId },
      otpWindowMinutes: env.OTP_WINDOW_MINUTES,
    });
  }),
);

/** Fast counter login for staff/owner alike: email + short numeric PIN. */
authRouter.post(
  '/shop/staff-login',
  loginLimiter,
  validateBody(staffLoginSchema),
  pinLoginFailureLimiter,
  asyncHandler(async (req, res) => {
    const { email, pin } = req.body as { email: string; pin: string };
    const user = await prisma.shopUser.findUnique({ where: { email } });
    const hash =
      user?.passwordHash ??
      '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const valid = await argon2.verify(hash, pin).catch(() => false);
    if (!user || !valid) throw unauthorized('Invalid email or PIN');

    res.json({
      token: signShopToken(user.id, user.shopId, user.role, user.sessionVersion),
      user: { id: user.id, name: user.name, role: user.role, shopId: user.shopId },
      otpWindowMinutes: env.OTP_WINDOW_MINUTES,
    });
  }),
);

const RESET_OTP_TTL_MS = 15 * 60_000;
const MAX_RESET_OTP_ATTEMPTS = 5;
const RESET_OTP_RESEND_MS = 60_000;
const MAX_RESET_OTP_SENDS_PER_EMAIL_PER_DAY = 10;

/** Step 1 of forgot-password: email a 6-digit reset code (always 200 — no email enumeration). */
authRouter.post(
  '/shop/request-reset',
  otpRequestLimiter,
  validateBody(requestPasswordResetSchema),
  asyncHandler(async (req, res) => {
    const { email } = req.body as { email: string };
    // Answer first (S27/AUTH-8): hashing the code and calling the email
    // provider took ~200 ms only for registered emails, so the response time
    // revealed which emails have accounts. Now every caller gets the same
    // instant {ok:true} and the real work runs after the response is sent.
    res.json({ ok: true });
    try {
      await sendPasswordResetCode(email);
    } catch (error) {
      logger.error({ error }, 'password_reset_request_failed');
    }
  }),
);

async function sendPasswordResetCode(email: string): Promise<void> {
  const user = await prisma.shopUser.findUnique({ where: { email }, select: { id: true } });
  if (!user) return;

  const now = new Date();
  const recent = await prisma.passwordResetOtp.findFirst({
    where: { email, createdAt: { gt: new Date(now.getTime() - RESET_OTP_RESEND_MS) } },
    select: { id: true },
  });
  const sentToday = await prisma.passwordResetOtp.count({
    where: { email, createdAt: { gt: new Date(now.getTime() - 24 * 60 * 60_000) } },
  });
  // The existing valid code remains usable, while the per-email ceiling caps sender spend.
  if (recent || sentToday >= MAX_RESET_OTP_SENDS_PER_EMAIL_PER_DAY) return;

  const otp = generateOtp();
  const reset = await prisma.passwordResetOtp.create({
    data: { email, otpHash: await hashOtp(otp), expiresAt: new Date(now.getTime() + RESET_OTP_TTL_MS) },
  });
  try {
    const result = await emailProvider.send(
      email,
      'Reset your PrintQ password',
      `Your PrintQ password reset code is ${otp}. It expires in 15 minutes.`,
    );
    await prisma.passwordResetOtp.update({
      where: { id: reset.id },
      data: {
        deliveryProvider: emailProvider.name,
        deliveryMessageId: result.providerMessageId ?? null,
        deliveryAttemptedAt: new Date(),
        deliveryError: null,
      },
    });
  } catch (error) {
    await prisma.passwordResetOtp.update({
      where: { id: reset.id },
      data: {
        deliveryProvider: emailProvider.name,
        deliveryAttemptedAt: new Date(),
        deliveryError: error instanceof Error ? error.message.slice(0, 300) : 'Email delivery failed',
      },
    });
    logger.error({ error, resetId: reset.id, provider: emailProvider.name }, 'password_reset_email_failed');
  }
}

/** Step 2: verify the code and set a new password. */
authRouter.post(
  '/shop/reset-password',
  otpVerifyLimiter,
  validateBody(confirmPasswordResetSchema),
  asyncHandler(async (req, res) => {
    const { email, otp, newPassword } = req.body as { email: string; otp: string; newPassword: string };

    const record = await prisma.passwordResetOtp.findFirst({
      where: { email, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, otpHash: true },
    });
    if (!record) throw badRequest('Code expired or not found — request a new one');

    // Same atomic attempt claim as student verify-otp (M1): at most 5 guesses
    // per code are ever checked, however many requests arrive in parallel.
    const claimed = await prisma.passwordResetOtp.updateMany({
      where: { id: record.id, consumedAt: null, attempts: { lt: MAX_RESET_OTP_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) throw badRequest('Too many wrong attempts — request a new code');

    if (!(await verifyOtpHash(record.otpHash, otp))) throw unauthorized('Incorrect code');

    const user = await prisma.shopUser.findUnique({ where: { email }, select: { id: true } });
    if (!user) throw badRequest('Code expired or not found — request a new one');

    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await prisma.$transaction(async (tx) => {
      // single use: only the request that flips consumedAt may change the password
      const consumed = await tx.passwordResetOtp.updateMany({
        where: { id: record.id, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (consumed.count !== 1) throw badRequest('Code expired or already used — request a new one');
      await tx.shopUser.update({
        where: { id: user.id },
        // every token issued under the old password stops working
        data: { passwordHash, sessionVersion: { increment: 1 } },
      });
    });
    res.json({ ok: true });
  }),
);

/**
 * Sign out (shop owner or staff): revokes every session of this account, on all
 * devices, by bumping the session version the tokens are checked against.
 */
authRouter.post(
  '/shop/logout',
  requireShopUser,
  asyncHandler(async (req, res) => {
    await prisma.shopUser.updateMany({
      where: { id: req.shopUser!.id, shopId: req.shopUser!.shopId },
      data: { sessionVersion: { increment: 1 } },
    });
    res.json({ ok: true });
  }),
);
