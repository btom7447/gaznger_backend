import { Router } from "express";
import crypto from "crypto";
import User from "../models/User";
import RefreshToken from "../models/RefreshToken";
import OtpRecord from "../models/OtpRecord";
import VerificationToken from "../models/VerificationToken";
import { hashPassword, comparePassword } from "../utils/hash";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { idempotencyKey } from "../middleware/idempotency";
import { withIdempotency } from "../utils/idempotencyCache";
import { DEV_FIXED_OTP, isDevSmsMode, sendOtpSms } from "../utils/sms";
import {
  assertNotLocked,
  clearPinFailures,
  recordPinFailure,
  PinLockedError,
  MAX_FAILURES,
} from "../utils/pinLockout";
import { emitToUser } from "../socket";
import {
  checkPhoneSchema,
  sendOtpSchema,
  verifyOtpSchema,
  signupSchema,
  phoneLoginSchema,
  forgotPinStartSchema,
  forgotPinVerifySchema,
  forgotPinResetSchema,
  verificationSubmitSchema,
  updateProfileSchema,
  setPinSchema,
  verifyPinSchema,
  clearPinSchema,
  savedCylinderSchema,
} from "../validators/auth.validators";

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: User authentication and token management
 */

/**
 * Persist a refresh token with optional device metadata. The metadata
 * powers the Active Sessions screen — without it, every row reads as
 * "Unknown device". Callers should pass `req` so we can sniff the UA
 * + IP at the same time.
 */
const saveRefreshToken = async (
  userId: string,
  token: string,
  meta?: { userAgent?: string; device?: string; ip?: string }
) => {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  await RefreshToken.create({
    user: userId,
    token,
    expiresAt,
    userAgent: meta?.userAgent,
    device: meta?.device,
    ip: meta?.ip,
    lastUsedAt: new Date(),
  });
};

/**
 * Pull device metadata off an incoming request for session bookkeeping.
 * Header `X-Device-Label` is mobile-only; it carries a friendlier label
 * than the User-Agent string (e.g. "iPhone 15 Pro").
 */
const sessionMeta = (req: import("express").Request) => ({
  userAgent: req.get("user-agent") ?? undefined,
  device: (req.get("x-device-label") as string | undefined) ?? undefined,
  ip: req.ip,
});

// =============================================================
// PHONE-FIRST AUTH (v4 slice — supersedes the legacy email auth).
// Contracts: docs/handoff/_server-asks/auth-{phone-otp,signup-pin,
// login,recovery,device-binding,edge-states,verification-status}.md
// =============================================================

const OTP_EXPIRY_MS = 5 * 60 * 1000;          // 5 min
const RESEND_COOLDOWN_MS = 60 * 1000;          // 60s
const VERIFY_TTL_SIGNUP_MS = 15 * 60 * 1000;   // 15 min
const VERIFY_TTL_RECOVERY_MS = 10 * 60 * 1000; // 10 min
const KNOWN_DEVICES_CAP = 5;
const MAX_OTP_ATTEMPTS = 5;

function generateOtp(): string {
  return crypto.randomInt(100000, 999999).toString();
}

function newVerificationToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/**
 * Append (or refresh) a knownDevice entry. Caps the array at
 * KNOWN_DEVICES_CAP, evicting oldest by lastSeenAt. Idempotent — same
 * deviceId hits the existing entry's lastSeenAt only.
 */
function upsertKnownDevice(
  user: import("../models/User").IUser,
  deviceId: string,
  label?: string
) {
  const list = user.knownDevices ?? [];
  const existing = list.find((d) => d.deviceId === deviceId);
  const now = new Date();
  if (existing) {
    existing.lastSeenAt = now;
    if (label && !existing.label) existing.label = label;
    user.knownDevices = list;
    return;
  }
  list.push({ deviceId, label, firstSeenAt: now, lastSeenAt: now });
  if (list.length > KNOWN_DEVICES_CAP) {
    list.sort((a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime());
    list.shift();
  }
  user.knownDevices = list;
}

/**
 * Pull the X-Device-Id + label off the request. Both are optional on
 * read paths (check-phone) and required on write paths (signup,
 * login). Caller decides; this just reads.
 */
function deviceFromReq(req: import("express").Request): {
  deviceId?: string;
  label?: string;
} {
  return {
    deviceId: (req.get("x-device-id") as string | undefined) ?? undefined,
    label: (req.get("x-device-label") as string | undefined) ?? undefined,
  };
}

/** Mirror of the SessionUser fields the mobile expects on auth responses. */
function publicUser(user: import("../models/User").IUser) {
  const obj = user.toObject();
  delete obj.passwordHash;
  delete obj.pinHash;
  delete obj.otpCode;
  delete obj.otpExpiresAt;
  return {
    ...obj,
    hasPin: Boolean(user.pinHash),
  };
}

/* ─────────── /auth/check-phone ─────────── */

router.post(
  "/check-phone",
  validate(checkPhoneSchema),
  async (req, res) => {
    try {
      const { phone } = req.body as { phone: string };
      const { deviceId } = deviceFromReq(req);

      const user = await User.findOne({ phone });
      if (!user) {
        return res.json({ exists: false, hasPin: false, knownDevice: false });
      }

      // Suspended account → mobile routes to /states/suspended.
      if (user.accountStatus === "suspended") {
        return res.status(403).json({
          accountStatus: "suspended",
          reason: undefined,
          message: "Account suspended.",
        });
      }

      const knownDevice =
        Boolean(deviceId) &&
        Boolean(user.knownDevices?.some((d) => d.deviceId === deviceId));

      // Refresh lastSeenAt opportunistically — best-effort.
      if (knownDevice) {
        const list = user.knownDevices ?? [];
        const entry = list.find((d) => d.deviceId === deviceId);
        if (entry) {
          entry.lastSeenAt = new Date();
          user.knownDevices = list;
          await user.save().catch(() => {});
        }
      }

      return res.json({
        exists: true,
        hasPin: Boolean(user.pinHash),
        knownDevice,
        accountStatus: user.accountStatus,
      });
    } catch {
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);

/* ─────────── /auth/send-otp ─────────── */

router.post(
  "/send-otp",
  idempotencyKey(),
  validate(sendOtpSchema),
  async (req, res) => {
    await withIdempotency(req, res, async () => {
      const { phone, purpose } = req.body as {
        phone: string;
        purpose: "signup" | "login" | "recovery";
      };

      const existing = await User.findOne({ phone });

      // Purpose-specific gates.
      if (purpose === "signup" && existing) {
        return {
          statusCode: 409,
          body: { message: "An account already exists for this number." },
        };
      }
      if (purpose === "recovery" && !existing) {
        return {
          statusCode: 404,
          body: { message: "No account found for that number." },
        };
      }
      if (existing && existing.accountStatus === "suspended") {
        return {
          statusCode: 403,
          body: {
            accountStatus: "suspended",
            message: "Account suspended.",
          },
        };
      }

      const code = generateOtp();
      const codeHash = await hashPassword(code);
      const now = Date.now();
      const expiresAt = new Date(now + OTP_EXPIRY_MS);
      const resendAvailableAt = new Date(now + RESEND_COOLDOWN_MS);

      // Replace any prior outstanding OTP for this phone × purpose.
      await OtpRecord.findOneAndUpdate(
        { phone, purpose },
        {
          $set: {
            codeHash,
            attempts: 0,
            expiresAt,
            resendAvailableAt,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      try {
        await sendOtpSms(phone, code);
      } catch (err) {
        // SMS provider failures shouldn't leak as 500s to clients —
        // surface as a 502 so mobile can render a recoverable state.
        return {
          statusCode: 502,
          body: {
            message:
              err instanceof Error
                ? err.message
                : "SMS provider unavailable. Try again.",
          },
        };
      }

      return {
        statusCode: 200,
        body: {
          otpExpiresAt: expiresAt.toISOString(),
          resendAvailableAt: resendAvailableAt.toISOString(),
        },
      };
    });
  }
);

/* ─────────── /auth/verify-otp ─────────── */

router.post(
  "/verify-otp",
  validate(verifyOtpSchema),
  async (req, res) => {
    try {
      const { phone, otp, purpose } = req.body as {
        phone: string;
        otp: string;
        purpose: "signup" | "login" | "recovery";
      };
      const { deviceId } = deviceFromReq(req);

      const record = await OtpRecord.findOne({ phone, purpose });
      if (!record) {
        return res.status(400).json({
          message: "No active code. Request a new one.",
        });
      }
      if (record.expiresAt.getTime() < Date.now()) {
        await record.deleteOne();
        return res.status(410).json({ message: "Code expired. Request a new one." });
      }
      if (record.attempts >= MAX_OTP_ATTEMPTS) {
        await record.deleteOne();
        return res.status(429).json({
          message: "Too many attempts. Request a new code.",
          retryAfter: 60,
        });
      }

      // Dev shortcut: in dev mode (no Termii key) the fixed code 123456
      // also matches. Real codes still work either way.
      const matches =
        (isDevSmsMode() && otp === DEV_FIXED_OTP) ||
        (await comparePassword(otp, record.codeHash));

      if (!matches) {
        record.attempts += 1;
        await record.save();
        const left = Math.max(0, MAX_OTP_ATTEMPTS - record.attempts);
        return res.status(400).json({
          message: "That code didn't match. Try again.",
          attemptsRemaining: left,
        });
      }

      // SECURITY (audit E.5): consume the OTP atomically BEFORE we
      // mint a verification token. Two concurrent requests with the
      // same valid OTP would both pass the match check above; only
      // the request whose `findOneAndDelete` returns a doc proceeds.
      // The other gets a 400 instead of a second valid token.
      const consumed = await OtpRecord.findOneAndDelete({ _id: record._id });
      if (!consumed) {
        return res.status(400).json({
          message: "Code already used. Request a new one.",
        });
      }

      const ttlMs =
        purpose === "recovery" ? VERIFY_TTL_RECOVERY_MS : VERIFY_TTL_SIGNUP_MS;
      const token = newVerificationToken();
      await VerificationToken.create({
        token,
        phone,
        purpose,
        deviceId,
        expiresAt: new Date(Date.now() + ttlMs),
      });

      return res.json({
        verificationToken: token,
        ttl: Math.floor(ttlMs / 1000),
      });
    } catch {
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);

/* ─────────── /auth/signup ─────────── */

router.post(
  "/signup",
  idempotencyKey(),
  validate(signupSchema),
  async (req, res) => {
    await withIdempotency(req, res, async () => {
      const { verificationToken, role, pin, profile } = req.body as {
        verificationToken: string;
        role: "customer" | "rider" | "vendor";
        pin: string;
        biometricPreference?: string;
        profile: Record<string, unknown>;
      };
      const { deviceId, label } = deviceFromReq(req);

      const tokenDoc = await VerificationToken.findOne({
        token: verificationToken,
        purpose: "signup",
      });
      if (!tokenDoc || tokenDoc.expiresAt.getTime() < Date.now()) {
        return {
          statusCode: 401,
          body: { message: "Verification expired. Restart from your phone number." },
        };
      }

      // Race vs check-phone — mobile already gated, but a parallel
      // signup from a second device on the same phone is possible.
      const existing = await User.findOne({ phone: tokenDoc.phone });
      if (existing) {
        await tokenDoc.deleteOne();
        return {
          statusCode: 409,
          body: { message: "An account already exists for this number." },
        };
      }

      // Build role-specific profile fields. We persist the customer/
      // rider/vendor data on the User doc directly for v1 — vendor
      // station details + rider profile both live here. When the rider
      // queue / vendor dashboard need richer per-role docs they'll
      // copy fields out on first dashboard mount.
      const displayName = (() => {
        if (role === "customer") {
          const fn = (profile.firstName as string) ?? "";
          const ln = (profile.lastName as string) ?? "";
          return [fn, ln].filter(Boolean).join(" ").trim() || "Guest";
        }
        if (role === "rider") {
          return (profile.fullName as string) ?? "Rider";
        }
        return (profile.stationName as string) ?? "Station";
      })();

      const pinHash = await hashPassword(pin);
      const user = new User({
        phone: tokenDoc.phone,
        email: typeof profile.email === "string" ? (profile.email as string) : undefined,
        role,
        displayName,
        phoneVerified: true,
        pinHash,
        accountStatus: role === "customer" ? "active" : "active",
        verificationStatus: role === "customer" ? undefined : "pending",
        knownDevices: deviceId
          ? [
              {
                deviceId,
                label,
                firstSeenAt: new Date(),
                lastSeenAt: new Date(),
              },
            ]
          : [],
      });

      // Vendor profile fields → on User for now (banking/payouts flow
      // adds richer docs in the next slice). See _drift/.
      if (role === "vendor") {
        // Reuse the existing vendorVerification subdoc shape so admin
        // tooling that already reads it keeps working.
        user.vendorVerification = {
          status: "pending",
          documents: [],
        };
      }

      await user.save();

      // Vendor signup → create the FIRST station doc owned by this
      // user. The schema (Station.vendorId, non-unique) already
      // supports a vendor owning N stations; the dashboard's "Add
      // station" flow handles subsequent ones in a later slice.
      // Skipped silently if address/coords are missing so the signup
      // still succeeds and the vendor can complete the station from
      // the dashboard.
      if (role === "vendor") {
        const stationName = profile.stationName as string | undefined;
        const address = profile.address as string | undefined;
        const stateCode = profile.state as string | undefined;
        const lga = profile.lga as string | undefined;
        const latitude = profile.latitude as number | undefined;
        const longitude = profile.longitude as number | undefined;
        const products = profile.products as string[] | undefined;
        if (
          stationName &&
          address &&
          stateCode &&
          typeof latitude === "number" &&
          typeof longitude === "number"
        ) {
          try {
            const GasStation = (await import("../models/Station")).default;
            const FuelType = (await import("../models/FuelType")).default;
            // Map the mobile's product slugs (petrol, diesel, kerosene,
            // lpg) to FuelType ObjectIds. Missing fuels are skipped —
            // vendor can edit later.
            const fuelDocs = products?.length
              ? await FuelType.find({
                  name: {
                    $regex: `^(${products.join("|")})$`,
                    $options: "i",
                  },
                })
                  .select("_id")
                  .lean()
              : [];
            await GasStation.create({
              name: stationName,
              address,
              state: stateCode,
              lga: lga || "",
              location: { lat: latitude, lng: longitude },
              // The Station schema's `fuels.fuel` field is typed as a
              // mongoose Schema.Types.ObjectId mongoose-helper rather
              // than a plain ObjectId, which trips strict typing on
              // direct assignment. Cast through `any` here — the
              // runtime shape is correct (a ref to FuelType._id).
              fuels: fuelDocs.map((f) => ({
                fuel: f._id as never,
                pricePerUnit: 0, // vendor sets later
                available: true,
              })),
              vendorId: user._id,
              verified: false,
              isActive: false, // off until vendor sets prices + admin verifies
              autoAcceptOrders: false,
            });
          } catch {
            // Non-fatal — signup itself succeeded. Admin tooling can
            // create the station from the user record if needed.
          }
        }
      }

      const userIdStr = (user._id as { toString(): string }).toString();
      const accessToken = signAccessToken({ id: userIdStr });
      const refreshToken = signRefreshToken({ id: userIdStr });
      await saveRefreshToken(userIdStr, refreshToken, sessionMeta(req));

      // Verification token is single-use — invalidate after success.
      await tokenDoc.deleteOne();

      return {
        statusCode: 201,
        body: {
          user: publicUser(user),
          accessToken,
          refreshToken,
        },
      };
    });
  }
);

/* ─────────── /auth/login ─────────── */

router.post("/login", validate(phoneLoginSchema), async (req, res) => {
  try {
    const { phone, pin, verificationToken } = req.body as {
      phone: string;
      pin: string;
      verificationToken?: string;
    };
    const { deviceId, label } = deviceFromReq(req);

    const user = await User.findOne({ phone });
    if (!user) {
      return res.status(404).json({ message: "No account found for that number." });
    }
    if (user.accountStatus === "suspended") {
      return res.status(403).json({
        accountStatus: "suspended",
        message: "Account suspended.",
      });
    }
    if (user.accountStatus === "deleted") {
      // Soft-deleted account — refuse with a generic 404 so the
      // attacker can't enumerate which numbers were deleted vs never
      // registered. After 30d the row hard-deletes and the phone
      // number is freed for re-signup.
      return res.status(404).json({
        message: "No account found for that number.",
      });
    }
    if (!user.pinHash) {
      return res
        .status(400)
        .json({ message: "PIN not set. Use phone + OTP to recover access." });
    }

    // SECURITY (audit A.4): per-account PIN lockout. Short-circuit
    // before bcrypt so an attacker can't burn CPU on a locked account.
    try {
      assertNotLocked(user);
    } catch (err) {
      if (err instanceof PinLockedError) {
        return res.status(423).json({
          message: "Too many wrong PIN attempts. Try again later.",
          retryAfterSec: err.retryAfterSec,
        });
      }
      throw err;
    }

    // If this is a new device for this user, require a fresh
    // verificationToken (login-purpose). Skip when the device is
    // already known — that's the OTP-skip fast path.
    const isKnownDevice =
      Boolean(deviceId) &&
      Boolean(user.knownDevices?.some((d) => d.deviceId === deviceId));

    if (!isKnownDevice) {
      if (!verificationToken) {
        return res.status(401).json({
          message: "OTP verification required for new device.",
        });
      }
      const tokenDoc = await VerificationToken.findOne({
        token: verificationToken,
        purpose: "login",
        phone,
      });
      if (!tokenDoc || tokenDoc.expiresAt.getTime() < Date.now()) {
        return res.status(401).json({
          message: "Verification expired. Restart from your phone number.",
        });
      }
      // Single-use.
      await tokenDoc.deleteOne();
    }

    const ok = await comparePassword(pin, user.pinHash);
    if (!ok) {
      const userIdStr = (user._id as { toString(): string }).toString();
      const { locked } = await recordPinFailure(userIdStr);
      if (locked) {
        return res.status(423).json({
          message: "Too many wrong PIN attempts. Try again later.",
          retryAfterSec: 15 * 60,
        });
      }
      return res.status(401).json({
        message: "Wrong PIN.",
        // Soft hint only — the per-account lockout is the real gate.
        attemptsRemaining: Math.max(
          0,
          MAX_FAILURES - ((user.pinFailures?.count ?? 0) + 1)
        ),
      });
    }

    // PIN matched — clear any prior failure record.
    {
      const userIdStr = (user._id as { toString(): string }).toString();
      await clearPinFailures(userIdStr);
    }

    if (deviceId) {
      upsertKnownDevice(user, deviceId, label);
      await user.save();
    }

    const userIdStr = (user._id as { toString(): string }).toString();
    const accessToken = signAccessToken({ id: userIdStr });
    const refreshToken = signRefreshToken({ id: userIdStr });
    await saveRefreshToken(userIdStr, refreshToken, sessionMeta(req));

    return res.json({
      user: publicUser(user),
      accessToken,
      refreshToken,
    });
  } catch {
    return res.status(500).json({ message: "Internal server error" });
  }
});

/* ─────────── /auth/forgot-pin/start ─────────── */

router.post(
  "/forgot-pin/start",
  idempotencyKey(),
  validate(forgotPinStartSchema),
  async (req, res) => {
    await withIdempotency(req, res, async () => {
      const { phone } = req.body as { phone: string };
      const user = await User.findOne({ phone });
      if (!user) {
        return {
          statusCode: 404,
          body: { message: "No account found for that number." },
        };
      }
      if (user.accountStatus === "suspended") {
        return {
          statusCode: 403,
          body: { accountStatus: "suspended", message: "Account suspended." },
        };
      }

      const code = generateOtp();
      const codeHash = await hashPassword(code);
      const now = Date.now();
      const expiresAt = new Date(now + OTP_EXPIRY_MS);
      const resendAvailableAt = new Date(now + RESEND_COOLDOWN_MS);

      await OtpRecord.findOneAndUpdate(
        { phone, purpose: "recovery" },
        { $set: { codeHash, attempts: 0, expiresAt, resendAvailableAt } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      try {
        await sendOtpSms(phone, code);
      } catch (err) {
        return {
          statusCode: 502,
          body: {
            message:
              err instanceof Error
                ? err.message
                : "SMS provider unavailable. Try again.",
          },
        };
      }

      return {
        statusCode: 200,
        body: {
          otpExpiresAt: expiresAt.toISOString(),
          resendAvailableAt: resendAvailableAt.toISOString(),
        },
      };
    });
  }
);

/* ─────────── /auth/forgot-pin/verify ─────────── */

router.post(
  "/forgot-pin/verify",
  validate(forgotPinVerifySchema),
  async (req, res) => {
    try {
      const { phone, otp } = req.body as { phone: string; otp: string };
      const { deviceId } = deviceFromReq(req);

      const record = await OtpRecord.findOne({ phone, purpose: "recovery" });
      if (!record) {
        return res.status(400).json({ message: "No active code. Request a new one." });
      }
      if (record.expiresAt.getTime() < Date.now()) {
        await record.deleteOne();
        return res.status(410).json({ message: "Code expired. Request a new one." });
      }
      if (record.attempts >= MAX_OTP_ATTEMPTS) {
        await record.deleteOne();
        return res.status(429).json({
          message: "Too many attempts. Request a new code.",
          retryAfter: 60,
        });
      }

      const matches =
        (isDevSmsMode() && otp === DEV_FIXED_OTP) ||
        (await comparePassword(otp, record.codeHash));

      if (!matches) {
        record.attempts += 1;
        await record.save();
        const left = Math.max(0, MAX_OTP_ATTEMPTS - record.attempts);
        return res.status(400).json({
          message: "That code didn't match. Try again.",
          attemptsRemaining: left,
        });
      }

      await record.deleteOne();

      const token = newVerificationToken();
      await VerificationToken.create({
        token,
        phone,
        purpose: "recovery",
        deviceId,
        expiresAt: new Date(Date.now() + VERIFY_TTL_RECOVERY_MS),
      });

      return res.json({
        resetToken: token,
        ttl: Math.floor(VERIFY_TTL_RECOVERY_MS / 1000),
      });
    } catch {
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);

/* ─────────── /auth/forgot-pin/reset ─────────── */

router.post(
  "/forgot-pin/reset",
  idempotencyKey(),
  validate(forgotPinResetSchema),
  async (req, res) => {
    await withIdempotency(req, res, async () => {
      const { resetToken, newPin } = req.body as {
        resetToken: string;
        newPin: string;
      };
      const { deviceId, label } = deviceFromReq(req);

      const tokenDoc = await VerificationToken.findOne({
        token: resetToken,
        purpose: "recovery",
      });
      if (!tokenDoc || tokenDoc.expiresAt.getTime() < Date.now()) {
        return {
          statusCode: 401,
          body: { message: "Reset expired. Try the recovery flow again." },
        };
      }

      const user = await User.findOne({ phone: tokenDoc.phone });
      if (!user) {
        await tokenDoc.deleteOne();
        return { statusCode: 404, body: { message: "Account not found." } };
      }

      // Best practice: revoke ALL refresh tokens — a forgotten PIN
      // implies possible compromised access on other devices.
      await RefreshToken.deleteMany({ user: user._id });

      user.pinHash = await hashPassword(newPin);
      if (deviceId) upsertKnownDevice(user, deviceId, label);
      await user.save();

      // Single-use.
      await tokenDoc.deleteOne();

      const userIdStr = (user._id as { toString(): string }).toString();
      const accessToken = signAccessToken({ id: userIdStr });
      const refreshToken = signRefreshToken({ id: userIdStr });
      await saveRefreshToken(userIdStr, refreshToken, sessionMeta(req));

      return {
        statusCode: 200,
        body: {
          user: publicUser(user),
          accessToken,
          refreshToken,
        },
      };
    });
  }
);

/* ─────────── /auth/verification (rider/vendor doc submit) ─────────── */

/**
 * Submit verification documents — pre-uploaded Cloudinary URLs from
 * /api/upload. Accumulates onto User.verificationDocs (replacing same
 * `kind`). Status stays `pending` — admin transitions via the admin
 * route below.
 */
router.patch(
  "/verification",
  requireAuth,
  validate(verificationSubmitSchema),
  async (req, res) => {
    try {
      const { documents } = req.body as {
        documents: Array<{ kind: string; url: string }>;
      };
      const user = await User.findById(req.userId);
      if (!user) return res.status(404).json({ message: "User not found" });
      if (user.role !== "rider" && user.role !== "vendor") {
        return res
          .status(400)
          .json({ message: "Verification only applies to rider/vendor." });
      }

      const existing = user.verificationDocs ?? [];
      const incomingKinds = new Set(documents.map((d) => d.kind));
      const merged = [
        ...existing.filter((d) => !incomingKinds.has(d.kind)),
        ...documents.map((d) => ({ ...d, uploadedAt: new Date() })),
      ];

      user.verificationDocs = merged;
      if (!user.verificationStatus) user.verificationStatus = "pending";
      await user.save();

      return res.json({
        verificationStatus: user.verificationStatus,
        verificationDocs: user.verificationDocs,
      });
    } catch {
      return res.status(500).json({ message: "Failed to submit verification" });
    }
  }
);

// ===================== LEGACY (REMOVED) =====================
// The legacy email-based register/verify-otp/resend-otp/forgot-password/
// reset-password/login flow was removed in the v4 auth slice. The stub
// below preserves the route name for any old client still hitting it
// — it returns a 410 with a pointer to the new flow. Safe to delete
// once telemetry confirms no callers remain.
const legacyHandler = (_req: import("express").Request, res: import("express").Response) =>
  res.status(410).json({
    message:
      "This auth path is retired. Update to the latest mobile build to continue.",
  });

router.post("/register", legacyHandler);
router.post("/verify-otp-email", legacyHandler);
router.post("/resend-otp", legacyHandler);
router.post("/forgot-password", legacyHandler);
router.post("/reset-password", legacyHandler);


// ===================== REFRESH TOKEN =====================
router.post("/refresh-token", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken)
      return res.status(400).json({ message: "Refresh token required" });

    // Verify the JWT signature + expiry FIRST. Order matters: if we
    // delete-then-verify, a malformed token deletes nothing (good)
    // but a forged-but-decode-able token would already have its
    // (non-existent) DB row "deleted" before we noticed. Verify
    // first → extract userId → atomic delete.
    const payload = verifyRefreshToken(refreshToken);
    if (!payload)
      return res.status(401).json({ message: "Invalid refresh token" });

    const storedToken = await RefreshToken.findOneAndDelete({ token: refreshToken });
    if (!storedToken) {
      // SECURITY (audit A.7): the JWT verified but the DB row is
      // gone. That means this refresh token has already been
      // consumed once — a legitimate replay can't happen because
      // rotation is single-use. This IS a reuse attempt. Revoke
      // ALL refresh tokens for this user so any active attacker
      // session is invalidated, and force the legitimate user to
      // re-authenticate. This trades "user gets logged out" for
      // "session theft is detected and contained".
      await RefreshToken.deleteMany({ user: payload.id });
      console.warn(
        `[auth] refresh-token reuse detected for user ${payload.id} — all sessions revoked`
      );
      return res.status(401).json({
        message: "Session reuse detected. Please sign in again.",
        code: "REFRESH_REUSE",
      });
    }

    const accessToken = signAccessToken({ id: payload.id });
    const newRefreshToken = signRefreshToken({ id: payload.id });
    await saveRefreshToken(payload.id, newRefreshToken, sessionMeta(req));

    res.json({ accessToken, refreshToken: newRefreshToken });
  } catch (err) {

    res.status(500).json({ message: "Internal server error" });
  }
});

// ===================== LOGOUT =====================
router.post("/logout", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken)
      return res.status(400).json({ message: "Refresh token required" });

    await RefreshToken.findOneAndDelete({ token: refreshToken });
    res.json({ message: "Logged out successfully" });
  } catch (err) {
    res.status(500).json({ message: "Internal server error" });
  }
});

// ===================== GET CURRENT USER =====================
router.get("/me", requireAuth, async (req, res) => {
  try {
    // SECURITY (audit E.8): explicitly exclude tokenisation/secret
    // fields from /auth/me. The Paystack authorizationCode is what
    // Paystack accepts as a charge token for the saved card; leaking
    // it = leaking the saved card. `bin` is mostly cosmetic but we
    // strip it too to avoid card-fingerprinting from a stolen access
    // token.
    const user = await User.findById(req.userId).select(
      "-passwordHash -otpCode -otpExpiresAt -pinHash" +
        " -lastPaystackAuth.authorizationCode -lastPaystackAuth.bin"
    );
    if (!user) return res.status(404).json({ message: "User not found" });

    // Suspended in-session — surface as 403 so mobile lib/api.ts
    // intercepts it and routes to /states/suspended without each
    // caller having to opt in. Body shape mirrors the auth endpoints.
    if (user.accountStatus === "suspended") {
      return res.status(403).json({
        accountStatus: "suspended",
        message: "Account suspended.",
      });
    }
    if (user.accountStatus === "deleted") {
      // Soft-deleted account — refuse with a generic 404 so the
      // attacker can't enumerate which numbers were deleted vs never
      // registered. After 30d the row hard-deletes and the phone
      // number is freed for re-signup.
      return res.status(404).json({
        message: "No account found for that number.",
      });
    }

    // Surface a count of completed LPG orders so the LPG flow can
    // unlock the saved-cylinder card + the "Skip — use last photos"
    // affordance for returning users (gated at 1+ per spec).
    let lpgOrderCount = 0;
    try {
      const Order = (await import("../models/Order")).default;
      const FuelType = (await import("../models/FuelType")).default;
      const lpg = await FuelType.findOne({ name: { $regex: /^(gas|lpg)$/i } })
        .select("_id")
        .lean();
      if (lpg) {
        lpgOrderCount = await Order.countDocuments({
          user: user._id,
          fuel: lpg._id,
          status: "delivered",
        });
      }
    } catch {
      // Non-fatal — profile still returns without the count.
    }

    // Re-read pinHash separately so we can derive `hasPin` without
    // ever returning the hash itself.
    const pinUser = await User.findById(req.userId).select("pinHash").lean();
    const hasPin = Boolean(pinUser?.pinHash);

    res.json({ ...user.toObject(), lpgOrderCount, hasPin });
  } catch (err) {
    res.status(500).json({ message: "Internal server error" });
  }
});

// ===================== DELETE ACCOUNT =====================
/**
 * POST /auth/me/delete — soft-delete with 30-day retention.
 *
 * App Store + Play Store reviews require an in-app deletion path
 * (audit B.1). We implement soft-delete:
 *   - Anonymise PII on User: phone → `+234DELETED-{userId}`, email
 *     → null, displayName → "Deleted user", profileImage → null,
 *     deviceTokens → [].
 *   - Set accountStatus = "deleted", deletedAt = now.
 *   - Revoke all refresh tokens so any active session is invalidated.
 *   - Order/payment history stays (linked by userId) for accounting
 *     + dispute purposes; admin still sees the rows.
 *
 * Hard delete (full row purge) lands as a v6.5 cron job that picks
 * up `accountStatus="deleted" AND deletedAt < now-30d`.
 *
 * The route requires the caller to step-up via PIN — the mobile
 * client uses `requireStepUpAuth` to gate the call BEFORE invoking
 * the route, but we re-verify here as defence-in-depth (a stolen
 * access token shouldn't be able to delete an account just because
 * the device had biometric enabled).
 */
router.post("/me/delete", requireAuth, async (req, res) => {
  try {
    const { pin } = req.body as { pin?: string };
    if (!pin || typeof pin !== "string") {
      return res.status(400).json({ message: "PIN required" });
    }
    const user = await User.findById(req.userId).select(
      "pinHash pinFailures phone _id"
    );
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!user.pinHash) {
      return res.status(400).json({ message: "Set a PIN before deleting your account" });
    }

    // Re-use the lockout helper (audit A.4) to gate brute-force.
    try {
      assertNotLocked(user);
    } catch (err) {
      if (err instanceof PinLockedError) {
        return res.status(423).json({
          message: "Too many wrong PIN attempts. Try again later.",
          retryAfterSec: err.retryAfterSec,
        });
      }
      throw err;
    }
    const ok = await comparePassword(pin, user.pinHash);
    if (!ok) {
      const { locked } = await recordPinFailure(req.userId!);
      if (locked) {
        return res.status(423).json({
          message: "Too many wrong PIN attempts. Try again later.",
          retryAfterSec: 15 * 60,
        });
      }
      return res.status(401).json({ message: "Incorrect PIN" });
    }
    await clearPinFailures(req.userId!);

    // Anonymise + flag deleted. Keep the row so order history remains
    // queryable for the rider/vendor/admin sides.
    const userIdStr = (user._id as { toString(): string }).toString();
    await User.updateOne(
      { _id: req.userId },
      {
        $set: {
          phone: `+234DELETED-${userIdStr}`,
          email: null,
          displayName: "Deleted user",
          profileImage: null,
          deviceTokens: [],
          accountStatus: "deleted",
          deletedAt: new Date(),
        },
      }
    );

    // Revoke every refresh token so any other device on this account
    // is logged out immediately.
    await RefreshToken.deleteMany({ user: req.userId });

    res.json({ message: "Account deleted" });
  } catch (err) {
    console.error("[auth/me/delete]", err);
    res.status(500).json({ message: "Failed to delete account" });
  }
});

// ===================== UPDATE PROFILE =====================
router.put("/me", requireAuth, validate(updateProfileSchema), async (req, res) => {
  try {
    const { displayName, phone, gender, profileImage, preferences } = req.body;

    // Build a `$set` payload with dot-paths so nested `preferences` fields
    // patch in place — Mongo's default behaviour with a top-level
    // `preferences` set would replace the whole subdocument, blowing
    // away any other preference the client didn't include in this call.
    const updates: Record<string, any> = {};
    if (displayName !== undefined) updates.displayName = displayName;
    if (phone !== undefined) updates.phone = phone;
    if (gender !== undefined) updates.gender = gender;
    if (profileImage !== undefined) updates.profileImage = profileImage;
    if (preferences && typeof preferences === "object") {
      const allowedKeys = [
        "autoRedeemPoints",
        "priceAlertsEnabled",
        "pushEnabled",
        "orderUpdates",
        "promotions",
        "notificationsFilter",
      ] as const;
      for (const key of allowedKeys) {
        const value = (preferences as Record<string, unknown>)[key];
        if (value !== undefined) {
          updates[`preferences.${key}`] = value;
        }
      }
    }

    const user = await User.findByIdAndUpdate(
      req.userId,
      { $set: updates },
      { new: true }
    ).select(
      // Mirror /auth/me: never echo PIN/password/Paystack auth code on
      // the write response either (audit E.8).
      "-passwordHash -otpCode -otpExpiresAt -pinHash" +
        " -lastPaystackAuth.authorizationCode -lastPaystackAuth.bin"
    );

    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: "Internal server error" });
  }
});

// ===================== REGISTER DEVICE TOKEN =====================
/**
 * SECURITY (audit A.8): validate shape + cap array size.
 *
 * Both Expo push tokens (`ExponentPushToken[...]`, ~50 chars) and
 * raw FCM/APNS tokens (~140-200 chars) fit in [32, 512]. Cap the
 * stored array at 8 — a user with 9+ devices is unusual; in
 * practice this prevents an attacker who's stolen a token from
 * polluting User.deviceTokens with garbage and growing the doc
 * until push fan-out becomes expensive.
 */
const MAX_DEVICE_TOKENS = 8;
const DEVICE_TOKEN_RE = /^[A-Za-z0-9_:.\-\[\]]{32,512}$/;

router.post("/device-token", requireAuth, async (req, res) => {
  try {
    const { token } = req.body as { token?: unknown };
    if (typeof token !== "string" || !DEVICE_TOKEN_RE.test(token)) {
      return res.status(400).json({ message: "Invalid device token" });
    }

    // Two-step dedupe + bounded-push:
    //   1. $pull removes any prior entry of the same token.
    //   2. $push with $each + $slice appends and trims to N.
    // Mongo can't combine $pull and $push on the same path in one
    // update; ordering them as two updates is fine — concurrent
    // requests for the same token converge.
    await User.updateOne(
      { _id: req.userId },
      { $pull: { deviceTokens: token } }
    );
    await User.updateOne(
      { _id: req.userId },
      {
        $push: {
          deviceTokens: {
            $each: [token],
            $slice: -MAX_DEVICE_TOKENS,
          },
        },
      }
    );

    res.json({ message: "Device token registered" });
  } catch (err) {

    res.status(500).json({ message: "Internal server error" });
  }
});

// ===================== REMOVE DEVICE TOKEN =====================
router.delete("/device-token", requireAuth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: "token is required" });

    await User.findByIdAndUpdate(req.userId, {
      $pull: { deviceTokens: token },
    });

    res.json({ message: "Device token removed" });
  } catch (err) {

    res.status(500).json({ message: "Internal server error" });
  }
});

// ===================== PIN: SET / CHANGE =====================
/**
 * Set or change the user's 4-digit PIN.
 *
 *   - First-time set (`hasPin` is false): require `password` so a
 *     stolen unlocked phone can't add a PIN that locks the legitimate
 *     owner out.
 *   - Change (`hasPin` is true): require `currentPin` to verify before
 *     accepting `newPin`.
 */
router.post("/pin/set", requireAuth, validate(setPinSchema), async (req, res) => {
  try {
    const { newPin, currentPin, password } = req.body as {
      newPin: string;
      currentPin?: string;
      password?: string;
    };

    const user = await User.findById(req.userId).select("passwordHash pinHash");
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.pinHash) {
      if (!currentPin)
        return res.status(400).json({ message: "Current PIN required" });
      const ok = await comparePassword(currentPin, user.pinHash);
      if (!ok) return res.status(401).json({ message: "Current PIN incorrect" });
    } else {
      if (!password)
        return res.status(400).json({ message: "Password required" });
      if (!user.passwordHash)
        return res.status(400).json({ message: "Set a PIN via the recovery flow" });
      const ok = await comparePassword(password, user.passwordHash);
      if (!ok) return res.status(401).json({ message: "Password incorrect" });
    }

    user.pinHash = await hashPassword(newPin);
    await user.save();

    res.json({ message: "PIN updated", hasPin: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to update PIN" });
  }
});

// ===================== PIN: VERIFY =====================
/**
 * Verify the user's PIN. Used by the client right before sensitive
 * actions (delete account, change phone, big withdrawals). Returns
 * `{ ok: true }` on match — never echoes the PIN back.
 */
router.post(
  "/pin/verify",
  requireAuth,
  validate(verifyPinSchema),
  async (req, res) => {
    try {
      const { pin } = req.body as { pin: string };
      const user = await User.findById(req.userId).select("pinHash pinFailures");
      if (!user || !user.pinHash)
        return res.status(400).json({ message: "No PIN set" });

      // SECURITY (audit A.4): step-up PIN-verify route was previously
      // gated only by the generic apiLimiter (100/min). With an
      // existing access token, an attacker could brute-force the PIN
      // to gate-bust delete-account / withdrawal flows.
      try {
        assertNotLocked(user);
      } catch (err) {
        if (err instanceof PinLockedError) {
          return res.status(423).json({
            message: "Too many wrong PIN attempts. Try again later.",
            retryAfterSec: err.retryAfterSec,
          });
        }
        throw err;
      }

      const ok = await comparePassword(pin, user.pinHash);
      if (!ok) {
        const { locked } = await recordPinFailure(req.userId!);
        if (locked) {
          return res.status(423).json({
            message: "Too many wrong PIN attempts. Try again later.",
            retryAfterSec: 15 * 60,
          });
        }
        return res.status(401).json({ message: "Incorrect PIN" });
      }
      await clearPinFailures(req.userId!);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ message: "Failed to verify PIN" });
    }
  }
);

// ===================== PIN: CLEAR =====================
router.delete("/pin", requireAuth, validate(clearPinSchema), async (req, res) => {
  try {
    const { currentPin, password } = req.body as {
      currentPin?: string;
      password?: string;
    };
    const user = await User.findById(req.userId).select("passwordHash pinHash");
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!user.pinHash)
      return res.json({ message: "No PIN set", hasPin: false });

    // Either currentPin or password may unlock the clear — same threat
    // model as set: we want at least one factor that proves identity.
    if (currentPin) {
      const ok = await comparePassword(currentPin, user.pinHash);
      if (!ok)
        return res.status(401).json({ message: "Current PIN incorrect" });
    } else if (password) {
      if (!user.passwordHash)
        return res.status(400).json({ message: "Use current PIN to clear." });
      const ok = await comparePassword(password, user.passwordHash);
      if (!ok) return res.status(401).json({ message: "Password incorrect" });
    } else {
      return res
        .status(400)
        .json({ message: "Current PIN or password required" });
    }

    user.pinHash = undefined;
    await user.save();
    res.json({ message: "PIN cleared", hasPin: false });
  } catch (err) {
    res.status(500).json({ message: "Failed to clear PIN" });
  }
});

// ===================== ACTIVE SESSIONS: LIST =====================
/**
 * Returns every refresh-token row for the current user (= every active
 * session). The row matching the bearer's refresh token is flagged as
 * `current: true`. The client passes its current refresh token in the
 * `X-Current-Refresh-Token` header so it can be excluded from server
 * access logs / proxy logs / browser history (audit F.2 — query string
 * leak). Falls back to `?current=` only if the header is absent.
 */
router.get("/sessions", requireAuth, async (req, res) => {
  try {
    const sessions = await RefreshToken.find({ user: req.userId })
      .sort({ updatedAt: -1 })
      .select("_id userAgent device ip lastUsedAt createdAt expiresAt token")
      .lean();

    const headerToken =
      typeof req.headers["x-current-refresh-token"] === "string"
        ? (req.headers["x-current-refresh-token"] as string)
        : null;
    const passedToken =
      headerToken ?? (req.query.current as string | undefined) ?? null;
    const out = sessions.map((s) => ({
      _id: s._id,
      userAgent: s.userAgent,
      device: s.device,
      ip: s.ip,
      lastUsedAt: s.lastUsedAt,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      current: passedToken ? s.token === passedToken : false,
    }));

    res.json({ sessions: out });
  } catch (err) {
    res.status(500).json({ message: "Failed to list sessions" });
  }
});

// ===================== ACTIVE SESSIONS: REVOKE ONE =====================
router.delete("/sessions/:id", requireAuth, async (req, res) => {
  try {
    const result = await RefreshToken.findOneAndDelete({
      _id: req.params.id,
      user: req.userId,
    });
    if (!result) return res.status(404).json({ message: "Session not found" });
    res.json({ message: "Session revoked" });
  } catch (err) {
    res.status(500).json({ message: "Failed to revoke session" });
  }
});

// ===================== SAVED CYLINDER: PUT =====================
/**
 * Replace the user's saved-cylinder profile with the supplied fields.
 * Each field is optional — clients can save a partial profile and
 * refine later. Photos are pre-uploaded URLs (Cloudinary), max 3.
 */
router.put(
  "/saved-cylinder",
  requireAuth,
  validate(savedCylinderSchema),
  async (req, res) => {
    try {
      const { brand, valve, age, test, photos } = req.body as {
        brand?: string;
        valve?: string;
        age?: string;
        test?: string;
        photos?: string[];
      };

      const updates: Record<string, unknown> = {
        "savedCylinder.savedAt": new Date(),
      };
      if (brand !== undefined) updates["savedCylinder.brand"] = brand;
      if (valve !== undefined) updates["savedCylinder.valve"] = valve;
      if (age !== undefined) updates["savedCylinder.age"] = age;
      if (test !== undefined) updates["savedCylinder.test"] = test;
      if (photos !== undefined) updates["savedCylinder.photos"] = photos;

      const user = await User.findByIdAndUpdate(
        req.userId,
        { $set: updates },
        { new: true }
      ).select("savedCylinder");

      if (!user) return res.status(404).json({ message: "User not found" });
      res.json({ savedCylinder: user.savedCylinder });
    } catch (err) {
      res.status(500).json({ message: "Failed to save cylinder" });
    }
  }
);

// ===================== SAVED CYLINDER: DELETE =====================
router.delete("/saved-cylinder", requireAuth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.userId, {
      $unset: { savedCylinder: "" },
    });
    res.json({ message: "Saved cylinder cleared", savedCylinder: null });
  } catch (err) {
    res.status(500).json({ message: "Failed to clear saved cylinder" });
  }
});

// ===================== ACTIVE SESSIONS: REVOKE ALL OTHERS =====================
/**
 * Sign out of every other device. The current session (matched on
 * `currentRefreshToken` in the body) is preserved so the user doesn't
 * get logged out of the device they're using.
 */
router.delete("/sessions", requireAuth, async (req, res) => {
  try {
    const { currentRefreshToken } = req.body as {
      currentRefreshToken?: string;
    };
    const filter: Record<string, unknown> = { user: req.userId };
    if (currentRefreshToken) filter.token = { $ne: currentRefreshToken };
    const result = await RefreshToken.deleteMany(filter);
    res.json({ message: "Other sessions revoked", count: result.deletedCount });
  } catch (err) {
    res.status(500).json({ message: "Failed to revoke sessions" });
  }
});

export default router;
