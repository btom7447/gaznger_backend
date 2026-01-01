import { Router } from "express";
import User from "../models/User";
import RefreshToken from "../models/RefreshToken";
import { hashPassword, comparePassword } from "../utils/hash";
import { signAccessToken, signRefreshToken } from "../utils/jwt";
import jwt from "jsonwebtoken";

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: User authentication and token management
 */

/**
 * Helper function to save refresh token in DB
 * Each refresh token expires in 7 days
 */
const saveRefreshToken = async (userId: string, token: string) => {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiry
  await RefreshToken.create({ user: userId, token, expiresAt });
};

// ===================== REGISTER =====================
/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 example: user@example.com
 *               phone:
 *                 type: string
 *                 example: "08012345678"
 *               password:
 *                 type: string
 *                 example: "password123"
 *               displayName:
 *                 type: string
 *                 example: "John Doe"
 *               profileImage:
 *                 type: string
 *                 format: uri
 *                 example: "https://avatar.iran.liara.run/public/19"
 *     responses:
 *       201:
 *         description: User registered successfully
 *       400:
 *         description: Email already in use
 *       500:
 *         description: Server error
 */
// ===================== REGISTER =====================
router.post("/register", async (req, res) => {
  try {
    const { email, phone, password, displayName, profileImage, gender } =
      req.body;

    // Check if user already exists
    const existing = await User.findOne({ email });
    if (existing)
      return res.status(400).json({ message: "Email already in use" });

    const passwordHash = await hashPassword(password);

    // Create user
    const user = await User.create({
      email,
      phone: phone || "",
      passwordHash,
      displayName: displayName || "Guest",
      gender: gender || "male", // model default is also male, this ensures TypeScript sees it
      // profileImage will automatically use the schema default function
      profileImage,
    });

    const userIdStr = user._id.toString();

    const accessToken = signAccessToken({ id: userIdStr });
    const refreshToken = signRefreshToken({ id: userIdStr });

    await saveRefreshToken(userIdStr, refreshToken);

    res.status(201).json({ user, accessToken, refreshToken });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err });
  }
});

// ===================== LOGIN =====================
/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Login a user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 example: user@example.com
 *               password:
 *                 type: string
 *                 example: "password123"
 *     responses:
 *       200:
 *         description: Logged in successfully
 *       400:
 *         description: Invalid credentials
 *       500:
 *         description: Server error
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    const isMatch = await comparePassword(password, user.passwordHash);
    if (!isMatch)
      return res.status(400).json({ message: "Invalid credentials" });

    const userIdStr = user._id.toString();

    const accessToken = signAccessToken({ id: userIdStr });
    const refreshToken = signRefreshToken({ id: userIdStr });

    await saveRefreshToken(userIdStr, refreshToken);

    res.json({ user, accessToken, refreshToken });
  } catch (err) {
    res.status(500).json({ error: err });
  }
});

// ===================== REFRESH TOKEN =====================
/**
 * @swagger
 * /auth/refresh-token:
 *   post:
 *     summary: Refresh access token using refresh token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: New access token issued
 *       400:
 *         description: Refresh token required
 *       401:
 *         description: Invalid refresh token
 *       500:
 *         description: Server error
 */
router.post("/refresh-token", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken)
      return res.status(400).json({ message: "Refresh token required" });

    const storedToken = await RefreshToken.findOne({ token: refreshToken });
    if (!storedToken)
      return res.status(401).json({ message: "Invalid refresh token" });

    const payload: any = jwt.verify(refreshToken, process.env.JWT_SECRET || "");
    if (!payload)
      return res.status(401).json({ message: "Invalid refresh token" });

    const accessToken = signAccessToken({ id: payload.id });
    res.json({ accessToken });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not refresh token" });
  }
});

// ===================== LOGOUT =====================
/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Logout user and remove refresh token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Logged out successfully
 *       400:
 *         description: Refresh token required
 *       500:
 *         description: Server error
 */
router.post("/logout", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken)
      return res.status(400).json({ message: "Refresh token required" });

    await RefreshToken.findOneAndDelete({ token: refreshToken });
    res.json({ message: "Logged out successfully" });
  } catch (err) {
    res.status(500).json({ message: "Logout failed" });
  }
});

export default router;
