import { Router } from "express";
import crypto from "crypto";
import User from "../models/User";
import RefreshToken from "../models/RefreshToken";
import { hashPassword, comparePassword } from "../utils/hash";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt";
import { sendOtpEmail } from "../utils/email";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import {
  registerSchema,
  loginSchema,
  verifyOtpSchema,
  resendOtpSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  updateProfileSchema,
} from "../validators/auth.validators";

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: User authentication and token management
 */

const saveRefreshToken = async (userId: string, token: string) => {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  await RefreshToken.create({ user: userId, token, expiresAt });
};

const generateOtp = () => crypto.randomInt(100000, 999999).toString();

// ===================== REGISTER =====================
router.post("/register", validate(registerSchema), async (req, res) => {
  try {
    const { email, phone, password, displayName, profileImage, gender, role } = req.body;

    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ message: "Email already in use" });

    const passwordHash = await hashPassword(password);

    const user = await User.create({
      email,
      phone: phone || "",
      passwordHash,
      displayName: displayName || "Guest",
      gender: gender || "male",
      profileImage,
      role: role || "customer",
      isOnboarded: role === "customer", // customers skip onboarding, others do not
      isVerified: false,
    });

    const otp = generateOtp();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);
    user.otpCode = otp;
    user.otpExpiresAt = otpExpiry;
    await user.save();

    await sendOtpEmail(user.email, otp);

    const userIdStr = user._id.toString();
    const accessToken = signAccessToken({ id: userIdStr });
    const refreshToken = signRefreshToken({ id: userIdStr });
    await saveRefreshToken(userIdStr, refreshToken);

    res.status(201).json({
      message: "User registered successfully. Please verify your email.",
      user: { email: user.email, displayName: user.displayName },
      accessToken,
      refreshToken,
    });
  } catch (err) {

    res.status(500).json({ message: "Internal server error" });
  }
});

// ===================== VERIFY OTP =====================
router.post("/verify-otp", validate(verifyOtpSchema), async (req, res) => {
  try {
    const { email, otp } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "User not found" });

    if (!user.otpCode || !user.otpExpiresAt)
      return res.status(400).json({ message: "No OTP found. Please request a new one." });

    if (new Date() > user.otpExpiresAt)
      return res.status(400).json({ message: "OTP expired. Please request a new one." });

    if (user.otpCode !== otp)
      return res.status(400).json({ message: "Invalid OTP" });

    user.isVerified = true;
    user.otpCode = undefined;
    user.otpExpiresAt = undefined;
    await user.save();

    return res.status(200).json({ message: "Email verified successfully" });
  } catch (err) {
    return res.status(500).json({ message: "Internal server error" });
  }
});

// ===================== RESEND OTP =====================
router.post("/resend-otp", validate(resendOtpSchema), async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "User not found" });

    if (user.isVerified)
      return res.status(400).json({ message: "User is already verified" });

    const otp = generateOtp();
    user.otpCode = otp;
    user.otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    await sendOtpEmail(user.email, otp);

    return res.status(200).json({ message: "OTP resent successfully" });
  } catch (err) {
    return res.status(500).json({ message: "Internal server error" });
  }
});

// ===================== FORGOT PASSWORD =====================
router.post("/forgot-password", validate(forgotPasswordSchema), async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });
    // Always return success to prevent email enumeration
    if (!user)
      return res.status(200).json({ message: "If that email exists, an OTP has been sent." });

    const otp = generateOtp();
    user.otpCode = otp;
    user.otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    await sendOtpEmail(user.email, otp);

    return res.status(200).json({ message: "If that email exists, an OTP has been sent." });
  } catch (err) {
    return res.status(500).json({ message: "Internal server error" });
  }
});

// ===================== RESET PASSWORD =====================
router.post("/reset-password", validate(resetPasswordSchema), async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "Invalid request" });

    if (!user.otpCode || !user.otpExpiresAt)
      return res.status(400).json({ message: "No OTP found. Please request a new one." });

    if (new Date() > user.otpExpiresAt)
      return res.status(400).json({ message: "OTP expired. Please request a new one." });

    if (user.otpCode !== otp)
      return res.status(400).json({ message: "Invalid OTP" });

    user.passwordHash = await hashPassword(newPassword);
    user.otpCode = undefined;
    user.otpExpiresAt = undefined;
    await user.save();

    // Revoke all existing refresh tokens for this user
    await RefreshToken.deleteMany({ user: user._id });

    return res.status(200).json({ message: "Password reset successfully. Please log in again." });
  } catch (err) {
    return res.status(500).json({ message: "Internal server error" });
  }
});

// ===================== LOGIN =====================
router.post("/login", validate(loginSchema), async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    const isMatch = await comparePassword(password, user.passwordHash);
    if (!isMatch) return res.status(400).json({ message: "Invalid credentials" });

    if (!user.isVerified)
      return res.status(401).json({ message: "Email not verified" });

    const userIdStr = user._id.toString();
    const accessToken = signAccessToken({ id: userIdStr });
    const refreshToken = signRefreshToken({ id: userIdStr });
    await saveRefreshToken(userIdStr, refreshToken);

    res.json({
      user: {
        _id: user._id,
        email: user.email,
        displayName: user.displayName,
        phone: user.phone,
        gender: user.gender,
        profileImage: user.profileImage,
        isVerified: user.isVerified,
        points: user.points,
        role: user.role,
        isOnboarded: user.isOnboarded,
        deviceTokens: user.deviceTokens,
      },
      accessToken,
      refreshToken,
    });
  } catch (err) {

    res.status(500).json({ message: "Internal server error" });
  }
});

// ===================== REFRESH TOKEN =====================
router.post("/refresh-token", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken)
      return res.status(400).json({ message: "Refresh token required" });

    const storedToken = await RefreshToken.findOneAndDelete({ token: refreshToken });
    if (!storedToken)
      return res.status(401).json({ message: "Invalid refresh token" });

    const payload = verifyRefreshToken(refreshToken);
    if (!payload)
      return res.status(401).json({ message: "Invalid refresh token" });

    const accessToken = signAccessToken({ id: payload.id });
    const newRefreshToken = signRefreshToken({ id: payload.id });
    await saveRefreshToken(payload.id, newRefreshToken);

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
    const user = await User.findById(req.userId).select(
      "-passwordHash -otpCode -otpExpiresAt"
    );
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (err) {

    res.status(500).json({ message: "Internal server error" });
  }
});

// ===================== UPDATE PROFILE =====================
router.put("/me", requireAuth, validate(updateProfileSchema), async (req, res) => {
  try {
    const { displayName, phone, gender, profileImage } = req.body;

    const updates: Record<string, any> = {};
    if (displayName !== undefined) updates.displayName = displayName;
    if (phone !== undefined) updates.phone = phone;
    if (gender !== undefined) updates.gender = gender;
    if (profileImage !== undefined) updates.profileImage = profileImage;

    const user = await User.findByIdAndUpdate(
      req.userId,
      { $set: updates },
      { new: true }
    ).select("-passwordHash -otpCode -otpExpiresAt");

    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (err) {

    res.status(500).json({ message: "Internal server error" });
  }
});

// ===================== REGISTER DEVICE TOKEN =====================
router.post("/device-token", requireAuth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: "token is required" });

    await User.findByIdAndUpdate(req.userId, {
      $addToSet: { deviceTokens: token },
    });

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

export default router;
