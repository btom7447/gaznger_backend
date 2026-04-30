import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  displayName: z.string().optional(),
  phone: z.string().refine(val => !val || val.length >= 10, "Phone number must be at least 10 digits").optional(),
  gender: z.enum(["male", "female"]).optional(),
  profileImage: z.string().url("Invalid image URL").optional(),
  role: z.enum(["customer", "vendor", "rider"]).optional().default("customer"),
});

export const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export const verifyOtpSchema = z.object({
  email: z.string().email("Invalid email address"),
  otp: z.string().length(6, "OTP must be exactly 6 digits"),
});

export const resendOtpSchema = z.object({
  email: z.string().email("Invalid email address"),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email("Invalid email address"),
});

export const resetPasswordSchema = z.object({
  email: z.string().email("Invalid email address"),
  otp: z.string().length(6, "OTP must be exactly 6 digits"),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

export const updateProfileSchema = z.object({
  displayName: z.string().optional(),
  phone: z.string().refine(val => !val || val.length >= 10, "Phone number must be at least 10 digits").optional(),
  gender: z.enum(["male", "female"]).optional(),
  profileImage: z.string().url("Invalid image URL").optional(),

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
