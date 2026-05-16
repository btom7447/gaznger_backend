import { z } from "zod";

/**
 * E.164 — leading "+" then 8-15 digits. Mobile normalises before send;
 * server enforces the same regex so a malformed number can't sneak
 * past via the mobile bypassing its own validation.
 */
const e164 = z.string().regex(/^\+\d{8,15}$/, "Phone must be in E.164 format (+countryDigits)");

const purposeEnum = z.enum(["signup", "login", "recovery"]);

const pin4 = z.string().regex(/^\d{4}$/, "PIN must be 4 digits");

export const checkPhoneSchema = z.object({
  phone: e164,
});

export const sendOtpSchema = z.object({
  phone: e164,
  purpose: purposeEnum,
});

export const verifyOtpSchema = z.object({
  phone: e164,
  otp: z.string().length(6, "OTP must be exactly 6 digits"),
  purpose: purposeEnum,
});

export const signupSchema = z.object({
  verificationToken: z.string().min(16, "verificationToken required"),
  role: z.enum(["customer", "rider", "vendor"]),
  pin: pin4,
  biometricPreference: z.enum(["face", "touch", "pin"]).optional(),
  // Profile is fully optional — the v7 unified onboarding wizard
  // creates the account with `profile: {}` and fills fields in via
  // PUT /auth/me + role-specific setup endpoints afterwards. Legacy
  // signup flows still send the full profile here in one shot.
  profile: z
    .object({
      displayName: z.string().min(2).max(120).optional(),
      // Customer fields
      firstName: z.string().min(2).max(60).optional(),
      lastName: z.string().min(2).max(60).optional(),
      email: z.string().email().optional(),
      // Rider fields
      fullName: z.string().min(3).max(120).optional(),
      plate: z.string().min(4).max(20).optional(),
      vehicleType: z.enum(["motorcycle", "tricycle", "van"]).optional(),
      // Vendor fields
      stationName: z.string().min(3).max(120).optional(),
      licence: z.string().min(6).max(64).optional(),
      contact: z.string().min(8).max(20).optional(),
      address: z.string().min(6).max(240).optional(),
      state: z.string().min(2).max(40).optional(),
      lga: z.string().max(80).optional(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      products: z.array(z.string()).max(8).optional(),
    })
    .optional()
    .default({}),
});

export const phoneLoginSchema = z.object({
  phone: e164,
  pin: pin4,
  /** Required when knownDevice was false on /auth/check-phone. */
  verificationToken: z.string().optional(),
});

export const forgotPinStartSchema = z.object({
  phone: e164,
});

export const forgotPinVerifySchema = z.object({
  phone: e164,
  otp: z.string().length(6, "OTP must be exactly 6 digits"),
});

export const forgotPinResetSchema = z.object({
  resetToken: z.string().min(16, "resetToken required"),
  newPin: pin4,
});

export const verificationSubmitSchema = z.object({
  documents: z
    .array(
      z.object({
        kind: z.string().min(2).max(64),
        url: z.string().url(),
      })
    )
    .min(1, "At least one document required")
    .max(20),
});

export const adminVerificationDecisionSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  reason: z.string().max(280).optional(),
});

export const updateProfileSchema = z.object({
  displayName: z.string().optional(),
  email: z.string().email("Invalid email").optional(),
  phone: z.string().refine(val => !val || val.length >= 10, "Phone number must be at least 10 digits").optional(),
  gender: z.enum(["male", "female"]).optional(),
  profileImage: z.string().url("Invalid image URL").optional(),
  vendorBusinessName: z
    .string()
    .min(2, "Business name must be at least 2 characters")
    .max(120)
    .optional(),

  /**
   * Customer preferences. Each field optional; the route handler patches
   * only the keys present so partial updates from the Settings screen
   * don't clobber unrelated flags.
   */
  preferences: z
    .object({
      autoRedeemPoints: z.boolean().optional(),
      priceAlertsEnabled: z.boolean().optional(),
      pushEnabled: z.boolean().optional(),
      orderUpdates: z.boolean().optional(),
      promotions: z.boolean().optional(),
      notificationsFilter: z.string().max(64).optional(),
    })
    .optional(),
});

/**
 * 4-digit PIN. We accept "set" (no current PIN exists yet, gated by
 * the user's password) and "change" (verify current → set new).
 */
export const setPinSchema = z.object({
  newPin: z.string().regex(/^\d{4}$/, "PIN must be 4 digits"),
  /** Required when the user already has a PIN. */
  currentPin: z.string().regex(/^\d{4}$/).optional(),
  /** Required when the user has no PIN — we ask for password instead. */
  password: z.string().optional(),
});

export const verifyPinSchema = z.object({
  pin: z.string().regex(/^\d{4}$/, "PIN must be 4 digits"),
});

export const clearPinSchema = z.object({
  /** Required to clear the PIN — never let a stolen unlocked phone wipe it. */
  currentPin: z.string().regex(/^\d{4}$/).optional(),
  password: z.string().optional(),
});

/**
 * Saved cylinder profile. All fields optional — user can save even a
 * partial profile and refine later. Photos are URLs (already uploaded
 * to Cloudinary by the dedicated upload endpoint).
 */
export const savedCylinderSchema = z.object({
  brand: z.string().max(64).optional(),
  valve: z.string().max(32).optional(),
  age: z.string().max(32).optional(),
  test: z.string().max(32).optional(),
  photos: z.array(z.string().url()).max(3).optional(),
});
