"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
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
/**
 * Persist a refresh token with optional device metadata. The metadata
 * powers the Active Sessions screen — without it, every row reads as
 * "Unknown device". Callers should pass `req` so we can sniff the UA
 * + IP at the same time.
 */
const saveRefreshToken = async (userId, token, meta) => {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    await RefreshToken_1.default.create({
        user: userId,
        token,
        expiresAt,
        userAgent: meta?.userAgent,
        device: meta?.device,
        ip: meta?.ip,
        lastUsedAt: new Date(),
    });
};
const generateOtp = () => crypto_1.default.randomInt(100000, 999999).toString();
/**
 * Pull device metadata off an incoming request for session bookkeeping.
 * Header `X-Device-Label` is mobile-only; it carries a friendlier label
 * than the User-Agent string (e.g. "iPhone 15 Pro").
 */
const sessionMeta = (req) => ({
    userAgent: req.get("user-agent") ?? undefined,
    device: req.get("x-device-label") ?? undefined,
    ip: req.ip,
});
// ===================== REGISTER =====================
router.post("/register", (0, validate_1.validate)(auth_validators_1.registerSchema), async (req, res) => {
    try {
        const { email, phone, password, displayName, profileImage, gender, role } = req.body;
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
            role: role || "customer",
            isOnboarded: role === "customer", // customers skip onboarding, others do not
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
        await saveRefreshToken(userIdStr, refreshToken, sessionMeta(req));
        res.status(201).json({
            message: "User registered successfully. Please verify your email.",
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
        await saveRefreshToken(userIdStr, refreshToken, sessionMeta(req));
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
        const storedToken = await RefreshToken_1.default.findOneAndDelete({ token: refreshToken });
        if (!storedToken)
            return res.status(401).json({ message: "Invalid refresh token" });
        const payload = (0, jwt_1.verifyRefreshToken)(refreshToken);
        if (!payload)
            return res.status(401).json({ message: "Invalid refresh token" });
        const accessToken = (0, jwt_1.signAccessToken)({ id: payload.id });
        const newRefreshToken = (0, jwt_1.signRefreshToken)({ id: payload.id });
        await saveRefreshToken(payload.id, newRefreshToken, sessionMeta(req));
        res.json({ accessToken, refreshToken: newRefreshToken });
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
        const user = await User_1.default.findById(req.userId).select("-passwordHash -otpCode -otpExpiresAt -pinHash");
        if (!user)
            return res.status(404).json({ message: "User not found" });
        // Surface a count of completed LPG orders so the LPG flow can
        // unlock the saved-cylinder card + the "Skip — use last photos"
        // affordance for returning users (gated at 1+ per spec).
        let lpgOrderCount = 0;
        try {
            const Order = (await Promise.resolve().then(() => __importStar(require("../models/Order")))).default;
            const FuelType = (await Promise.resolve().then(() => __importStar(require("../models/FuelType")))).default;
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
        }
        catch {
            // Non-fatal — profile still returns without the count.
        }
        // Re-read pinHash separately so we can derive `hasPin` without
        // ever returning the hash itself.
        const pinUser = await User_1.default.findById(req.userId).select("pinHash").lean();
        const hasPin = Boolean(pinUser?.pinHash);
        res.json({ ...user.toObject(), lpgOrderCount, hasPin });
    }
    catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
});
// ===================== UPDATE PROFILE =====================
router.put("/me", auth_1.requireAuth, (0, validate_1.validate)(auth_validators_1.updateProfileSchema), async (req, res) => {
    try {
        const { displayName, phone, gender, profileImage, preferences } = req.body;
        // Build a `$set` payload with dot-paths so nested `preferences` fields
        // patch in place — Mongo's default behaviour with a top-level
        // `preferences` set would replace the whole subdocument, blowing
        // away any other preference the client didn't include in this call.
        const updates = {};
        if (displayName !== undefined)
            updates.displayName = displayName;
        if (phone !== undefined)
            updates.phone = phone;
        if (gender !== undefined)
            updates.gender = gender;
        if (profileImage !== undefined)
            updates.profileImage = profileImage;
        if (preferences && typeof preferences === "object") {
            const allowedKeys = [
                "autoRedeemPoints",
                "priceAlertsEnabled",
                "pushEnabled",
                "orderUpdates",
                "promotions",
                "notificationsFilter",
            ];
            for (const key of allowedKeys) {
                const value = preferences[key];
                if (value !== undefined) {
                    updates[`preferences.${key}`] = value;
                }
            }
        }
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
router.post("/pin/set", auth_1.requireAuth, (0, validate_1.validate)(auth_validators_1.setPinSchema), async (req, res) => {
    try {
        const { newPin, currentPin, password } = req.body;
        const user = await User_1.default.findById(req.userId).select("passwordHash pinHash");
        if (!user)
            return res.status(404).json({ message: "User not found" });
        if (user.pinHash) {
            if (!currentPin)
                return res.status(400).json({ message: "Current PIN required" });
            const ok = await (0, hash_1.comparePassword)(currentPin, user.pinHash);
            if (!ok)
                return res.status(401).json({ message: "Current PIN incorrect" });
        }
        else {
            if (!password)
                return res.status(400).json({ message: "Password required" });
            const ok = await (0, hash_1.comparePassword)(password, user.passwordHash);
            if (!ok)
                return res.status(401).json({ message: "Password incorrect" });
        }
        user.pinHash = await (0, hash_1.hashPassword)(newPin);
        await user.save();
        res.json({ message: "PIN updated", hasPin: true });
    }
    catch (err) {
        res.status(500).json({ message: "Failed to update PIN" });
    }
});
// ===================== PIN: VERIFY =====================
/**
 * Verify the user's PIN. Used by the client right before sensitive
 * actions (delete account, change phone, big withdrawals). Returns
 * `{ ok: true }` on match — never echoes the PIN back.
 */
router.post("/pin/verify", auth_1.requireAuth, (0, validate_1.validate)(auth_validators_1.verifyPinSchema), async (req, res) => {
    try {
        const { pin } = req.body;
        const user = await User_1.default.findById(req.userId).select("pinHash");
        if (!user || !user.pinHash)
            return res.status(400).json({ message: "No PIN set" });
        const ok = await (0, hash_1.comparePassword)(pin, user.pinHash);
        if (!ok)
            return res.status(401).json({ message: "Incorrect PIN" });
        res.json({ ok: true });
    }
    catch (err) {
        res.status(500).json({ message: "Failed to verify PIN" });
    }
});
// ===================== PIN: CLEAR =====================
router.delete("/pin", auth_1.requireAuth, (0, validate_1.validate)(auth_validators_1.clearPinSchema), async (req, res) => {
    try {
        const { currentPin, password } = req.body;
        const user = await User_1.default.findById(req.userId).select("passwordHash pinHash");
        if (!user)
            return res.status(404).json({ message: "User not found" });
        if (!user.pinHash)
            return res.json({ message: "No PIN set", hasPin: false });
        // Either currentPin or password may unlock the clear — same threat
        // model as set: we want at least one factor that proves identity.
        if (currentPin) {
            const ok = await (0, hash_1.comparePassword)(currentPin, user.pinHash);
            if (!ok)
                return res.status(401).json({ message: "Current PIN incorrect" });
        }
        else if (password) {
            const ok = await (0, hash_1.comparePassword)(password, user.passwordHash);
            if (!ok)
                return res.status(401).json({ message: "Password incorrect" });
        }
        else {
            return res
                .status(400)
                .json({ message: "Current PIN or password required" });
        }
        user.pinHash = undefined;
        await user.save();
        res.json({ message: "PIN cleared", hasPin: false });
    }
    catch (err) {
        res.status(500).json({ message: "Failed to clear PIN" });
    }
});
// ===================== ACTIVE SESSIONS: LIST =====================
/**
 * Returns every refresh-token row for the current user (= every active
 * session). The row matching the bearer's refresh token is flagged as
 * `current: true`. The body `currentRefreshToken` is optional but
 * recommended — without it the client can't tell which row is "this
 * device".
 */
router.get("/sessions", auth_1.requireAuth, async (req, res) => {
    try {
        const sessions = await RefreshToken_1.default.find({ user: req.userId })
            .sort({ updatedAt: -1 })
            .select("_id userAgent device ip lastUsedAt createdAt expiresAt token")
            .lean();
        const passedToken = req.query.current ?? null;
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
    }
    catch (err) {
        res.status(500).json({ message: "Failed to list sessions" });
    }
});
// ===================== ACTIVE SESSIONS: REVOKE ONE =====================
router.delete("/sessions/:id", auth_1.requireAuth, async (req, res) => {
    try {
        const result = await RefreshToken_1.default.findOneAndDelete({
            _id: req.params.id,
            user: req.userId,
        });
        if (!result)
            return res.status(404).json({ message: "Session not found" });
        res.json({ message: "Session revoked" });
    }
    catch (err) {
        res.status(500).json({ message: "Failed to revoke session" });
    }
});
// ===================== SAVED CYLINDER: PUT =====================
/**
 * Replace the user's saved-cylinder profile with the supplied fields.
 * Each field is optional — clients can save a partial profile and
 * refine later. Photos are pre-uploaded URLs (Cloudinary), max 3.
 */
router.put("/saved-cylinder", auth_1.requireAuth, (0, validate_1.validate)(auth_validators_1.savedCylinderSchema), async (req, res) => {
    try {
        const { brand, valve, age, test, photos } = req.body;
        const updates = {
            "savedCylinder.savedAt": new Date(),
        };
        if (brand !== undefined)
            updates["savedCylinder.brand"] = brand;
        if (valve !== undefined)
            updates["savedCylinder.valve"] = valve;
        if (age !== undefined)
            updates["savedCylinder.age"] = age;
        if (test !== undefined)
            updates["savedCylinder.test"] = test;
        if (photos !== undefined)
            updates["savedCylinder.photos"] = photos;
        const user = await User_1.default.findByIdAndUpdate(req.userId, { $set: updates }, { new: true }).select("savedCylinder");
        if (!user)
            return res.status(404).json({ message: "User not found" });
        res.json({ savedCylinder: user.savedCylinder });
    }
    catch (err) {
        res.status(500).json({ message: "Failed to save cylinder" });
    }
});
// ===================== SAVED CYLINDER: DELETE =====================
router.delete("/saved-cylinder", auth_1.requireAuth, async (req, res) => {
    try {
        await User_1.default.findByIdAndUpdate(req.userId, {
            $unset: { savedCylinder: "" },
        });
        res.json({ message: "Saved cylinder cleared", savedCylinder: null });
    }
    catch (err) {
        res.status(500).json({ message: "Failed to clear saved cylinder" });
    }
});
// ===================== ACTIVE SESSIONS: REVOKE ALL OTHERS =====================
/**
 * Sign out of every other device. The current session (matched on
 * `currentRefreshToken` in the body) is preserved so the user doesn't
 * get logged out of the device they're using.
 */
router.delete("/sessions", auth_1.requireAuth, async (req, res) => {
    try {
        const { currentRefreshToken } = req.body;
        const filter = { user: req.userId };
        if (currentRefreshToken)
            filter.token = { $ne: currentRefreshToken };
        const result = await RefreshToken_1.default.deleteMany(filter);
        res.json({ message: "Other sessions revoked", count: result.deletedCount });
    }
    catch (err) {
        res.status(500).json({ message: "Failed to revoke sessions" });
    }
});
exports.default = router;
//# sourceMappingURL=auth.js.map