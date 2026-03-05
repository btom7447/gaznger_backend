"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const crypto_1 = __importDefault(require("crypto"));
const User_1 = __importDefault(require("../models/User"));
const RefreshToken_1 = __importDefault(require("../models/RefreshToken"));
const hash_1 = require("../utils/hash");
const jwt_1 = require("../utils/jwt");
const email_1 = require("../utils/email");
const auth_1 = require("../middleware/auth");
const validate_1 = require("../middleware/validate");
const auth_validators_1 = require("../validators/auth.validators");
const router = (0, express_1.Router)();
/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: User authentication and token management
 */
const saveRefreshToken = async (userId, token) => {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    await RefreshToken_1.default.create({ user: userId, token, expiresAt });
};
const generateOtp = () => crypto_1.default.randomInt(10000, 99999).toString();
// ===================== REGISTER =====================
router.post("/register", (0, validate_1.validate)(auth_validators_1.registerSchema), async (req, res) => {
    try {
        const { email, phone, password, displayName, profileImage, gender } = req.body;
        const existing = await User_1.default.findOne({ email });
        if (existing)
            return res.status(400).json({ message: "Email already in use" });
        const passwordHash = await (0, hash_1.hashPassword)(password);
        const user = await User_1.default.create({
            email,
            phone: phone || "",
            passwordHash,
            displayName: displayName || "Guest",
            gender: gender || "male",
            profileImage,
            isVerified: false,
        });
        const otp = generateOtp();
        const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);
        user.otpCode = otp;
        user.otpExpiresAt = otpExpiry;
        await user.save();
        await (0, email_1.sendOtpEmail)(user.email, otp);
        const userIdStr = user._id.toString();
        const accessToken = (0, jwt_1.signAccessToken)({ id: userIdStr });
        const refreshToken = (0, jwt_1.signRefreshToken)({ id: userIdStr });
        await saveRefreshToken(userIdStr, refreshToken);
        res.status(201).json({
            message: "User registered successfully. Please verify your email.",
            user: { email: user.email, displayName: user.displayName },
            accessToken,
            refreshToken,
        });
    }
    catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
});
// ===================== VERIFY OTP =====================
router.post("/verify-otp", (0, validate_1.validate)(auth_validators_1.verifyOtpSchema), async (req, res) => {
    try {
        const { email, otp } = req.body;
        const user = await User_1.default.findOne({ email });
        if (!user)
            return res.status(400).json({ message: "User not found" });
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
    }
    catch (err) {
        return res.status(500).json({ message: "Internal server error" });
    }
});
// ===================== RESEND OTP =====================
router.post("/resend-otp", (0, validate_1.validate)(auth_validators_1.resendOtpSchema), async (req, res) => {
    try {
        const { email } = req.body;
        const user = await User_1.default.findOne({ email });
        if (!user)
            return res.status(400).json({ message: "User not found" });
        if (user.isVerified)
            return res.status(400).json({ message: "User is already verified" });
        const otp = generateOtp();
        user.otpCode = otp;
        user.otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
        await user.save();
        await (0, email_1.sendOtpEmail)(user.email, otp);
        return res.status(200).json({ message: "OTP resent successfully" });
    }
    catch (err) {
        return res.status(500).json({ message: "Internal server error" });
    }
});
// ===================== FORGOT PASSWORD =====================
router.post("/forgot-password", (0, validate_1.validate)(auth_validators_1.forgotPasswordSchema), async (req, res) => {
    try {
        const { email } = req.body;
        const user = await User_1.default.findOne({ email });
        // Always return success to prevent email enumeration
        if (!user)
            return res.status(200).json({ message: "If that email exists, an OTP has been sent." });
        const otp = generateOtp();
        user.otpCode = otp;
        user.otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
        await user.save();
        await (0, email_1.sendOtpEmail)(user.email, otp);
        return res.status(200).json({ message: "If that email exists, an OTP has been sent." });
    }
    catch (err) {
        return res.status(500).json({ message: "Internal server error" });
    }
});
// ===================== RESET PASSWORD =====================
router.post("/reset-password", (0, validate_1.validate)(auth_validators_1.resetPasswordSchema), async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body;
        const user = await User_1.default.findOne({ email });
        if (!user)
            return res.status(400).json({ message: "Invalid request" });
        if (!user.otpCode || !user.otpExpiresAt)
            return res.status(400).json({ message: "No OTP found. Please request a new one." });
        if (new Date() > user.otpExpiresAt)
            return res.status(400).json({ message: "OTP expired. Please request a new one." });
        if (user.otpCode !== otp)
            return res.status(400).json({ message: "Invalid OTP" });
        user.passwordHash = await (0, hash_1.hashPassword)(newPassword);
        user.otpCode = undefined;
        user.otpExpiresAt = undefined;
        await user.save();
        // Revoke all existing refresh tokens for this user
        await RefreshToken_1.default.deleteMany({ user: user._id });
        return res.status(200).json({ message: "Password reset successfully. Please log in again." });
    }
    catch (err) {
        return res.status(500).json({ message: "Internal server error" });
    }
});
// ===================== LOGIN =====================
router.post("/login", (0, validate_1.validate)(auth_validators_1.loginSchema), async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User_1.default.findOne({ email });
        if (!user)
            return res.status(400).json({ message: "Invalid credentials" });
        const isMatch = await (0, hash_1.comparePassword)(password, user.passwordHash);
        if (!isMatch)
            return res.status(400).json({ message: "Invalid credentials" });
        if (!user.isVerified)
            return res.status(401).json({ message: "Email not verified" });
        const userIdStr = user._id.toString();
        const accessToken = (0, jwt_1.signAccessToken)({ id: userIdStr });
        const refreshToken = (0, jwt_1.signRefreshToken)({ id: userIdStr });
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
                deviceTokens: user.deviceTokens,
            },
            accessToken,
            refreshToken,
        });
    }
    catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
});
// ===================== REFRESH TOKEN =====================
router.post("/refresh-token", async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken)
            return res.status(400).json({ message: "Refresh token required" });
        const storedToken = await RefreshToken_1.default.findOne({ token: refreshToken });
        if (!storedToken)
            return res.status(401).json({ message: "Invalid refresh token" });
        const payload = (0, jwt_1.verifyRefreshToken)(refreshToken);
        if (!payload)
            return res.status(401).json({ message: "Invalid refresh token" });
        const accessToken = (0, jwt_1.signAccessToken)({ id: payload.id });
        res.json({ accessToken });
    }
    catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
});
// ===================== LOGOUT =====================
router.post("/logout", async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken)
            return res.status(400).json({ message: "Refresh token required" });
        await RefreshToken_1.default.findOneAndDelete({ token: refreshToken });
        res.json({ message: "Logged out successfully" });
    }
    catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
});
// ===================== GET CURRENT USER =====================
router.get("/me", auth_1.requireAuth, async (req, res) => {
    try {
        const user = await User_1.default.findById(req.userId).select("-passwordHash -otpCode -otpExpiresAt");
        if (!user)
            return res.status(404).json({ message: "User not found" });
        res.json(user);
    }
    catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
});
// ===================== UPDATE PROFILE =====================
router.put("/me", auth_1.requireAuth, (0, validate_1.validate)(auth_validators_1.updateProfileSchema), async (req, res) => {
    try {
        const { displayName, phone, gender, profileImage } = req.body;
        const updates = {};
        if (displayName !== undefined)
            updates.displayName = displayName;
        if (phone !== undefined)
            updates.phone = phone;
        if (gender !== undefined)
            updates.gender = gender;
        if (profileImage !== undefined)
            updates.profileImage = profileImage;
        const user = await User_1.default.findByIdAndUpdate(req.userId, { $set: updates }, { new: true }).select("-passwordHash -otpCode -otpExpiresAt");
        if (!user)
            return res.status(404).json({ message: "User not found" });
        res.json(user);
    }
    catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
});
// ===================== REGISTER DEVICE TOKEN =====================
router.post("/device-token", auth_1.requireAuth, async (req, res) => {
    try {
        const { token } = req.body;
        if (!token)
            return res.status(400).json({ message: "token is required" });
        await User_1.default.findByIdAndUpdate(req.userId, {
            $addToSet: { deviceTokens: token },
        });
        res.json({ message: "Device token registered" });
    }
    catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
});
// ===================== REMOVE DEVICE TOKEN =====================
router.delete("/device-token", auth_1.requireAuth, async (req, res) => {
    try {
        const { token } = req.body;
        if (!token)
            return res.status(400).json({ message: "token is required" });
        await User_1.default.findByIdAndUpdate(req.userId, {
            $pull: { deviceTokens: token },
        });
        res.json({ message: "Device token removed" });
    }
    catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
});
exports.default = router;
//# sourceMappingURL=auth.js.map