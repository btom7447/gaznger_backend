import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  displayName: z.string().optional(),
  phone: z.string().refine(val => !val || val.length >= 10, "Phone number must be at least 10 digits").optional(),
  gender: z.enum(["male", "female"]).optional(),
  profileImage: z.string().url("Invalid image URL").optional(),
});

export const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export const verifyOtpSchema = z.object({
  email: z.string().email("Invalid email address"),
  otp: z.string().length(5, "OTP must be exactly 5 digits"),
});

export const resendOtpSchema = z.object({
  email: z.string().email("Invalid email address"),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email("Invalid email address"),
});

export const resetPasswordSchema = z.object({
  email: z.string().email("Invalid email address"),
  otp: z.string().length(5, "OTP must be exactly 5 digits"),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

export const updateProfileSchema = z.object({
  displayName: z.string().optional(),
  phone: z.string().refine(val => !val || val.length >= 10, "Phone number must be at least 10 digits").optional(),
  gender: z.enum(["male", "female"]).optional(),
  profileImage: z.string().url("Invalid image URL").optional(),
});
