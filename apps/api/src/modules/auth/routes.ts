import { Router } from 'express';
import argon2 from 'argon2';
import { requestLoginOtpSchema, shopLoginSchema, verifyLoginOtpSchema } from '@printq/shared';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, unauthorized } from '../../lib/errors.js';
import { generateOtp, hashOtp, verifyOtpHash } from '../../lib/otp.js';
import { signShopToken, signStudentToken } from '../../lib/tokens.js';
import { validateBody } from '../../middleware/validate.js';
import { loginLimiter, otpRequestLimiter, otpVerifyLimiter } from '../../middleware/rateLimit.js';
import { requireStudent } from '../../middleware/auth.js';
import { notify } from '../../providers/notification/index.js';
import { env } from '../../config/env.js';

export const authRouter = Router();

const LOGIN_OTP_TTL_MS = 5 * 60_000;
const MAX_LOGIN_OTP_ATTEMPTS = 5;

/** Step 1 of student login: send a 6-digit OTP to the phone. */
authRouter.post(
  '/student/request-otp',
  otpRequestLimiter,
  validateBody(requestLoginOtpSchema),
  asyncHandler(async (req, res) => {
    const { phone } = req.body as { phone: string };

    const otp = generateOtp();
    await prisma.loginOtp.create({
      data: {
        phone,
        otpHash: await hashOtp(otp),
        expiresAt: new Date(Date.now() + LOGIN_OTP_TTL_MS),
      },
    });
    // in dev (console provider) the OTP appears in the API logs
    await notify(phone, `PrintQ login code: ${otp}. Valid for 5 minutes.`);
    res.json({ ok: true });
  }),
);

/** Step 2: verify OTP → JWT. Creates the student record on first login. */
authRouter.post(
  '/student/verify-otp',
  otpVerifyLimiter,
  validateBody(verifyLoginOtpSchema),
  asyncHandler(async (req, res) => {
    const { phone, otp } = req.body as { phone: string; otp: string };

    const record = await prisma.loginOtp.findFirst({
      where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!record) throw badRequest('Code expired or not found — request a new one');
    if (record.attempts >= MAX_LOGIN_OTP_ATTEMPTS) {
      throw badRequest('Too many wrong attempts — request a new code');
    }

    const valid = await verifyOtpHash(record.otpHash, otp);
    if (!valid) {
      await prisma.loginOtp.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      throw unauthorized('Incorrect code');
    }

    await prisma.loginOtp.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
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

/** Shop staff login: email + password (argon2id). */
authRouter.post(
  '/shop/login',
  loginLimiter,
  validateBody(shopLoginSchema),
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
      token: signShopToken(user.id, user.shopId, user.role),
      user: { id: user.id, name: user.name, role: user.role, shopId: user.shopId },
      otpWindowMinutes: env.OTP_WINDOW_MINUTES,
    });
  }),
);
