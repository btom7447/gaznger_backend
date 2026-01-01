import { Router } from "express";
import User from "../models/User";

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Points
 *   description: Manage user points
 */

// ===================== GET USER POINTS =====================
/**
 * @swagger
 * /api/points/{userId}:
 *   get:
 *     summary: Get current points for a user
 *     tags: [Points]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the user
 *     responses:
 *       200:
 *         description: Current points
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 userId:
 *                   type: string
 *                 points:
 *                   type: number
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.get("/:userId", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select("points");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ userId: user._id, points: user.points });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch points" });
  }
});

// ===================== UPDATE USER POINTS =====================
/**
 * @swagger
 * /api/points/{userId}:
 *   patch:
 *     summary: Add or reduce points for a user
 *     tags: [Points]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [change]
 *             properties:
 *               change:
 *                 type: number
 *                 description: Positive to add points, negative to reduce
 *                 example: 50
 *     responses:
 *       200:
 *         description: Updated points
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 userId:
 *                   type: string
 *                 points:
 *                   type: number
 *       404:
 *         description: User not found
 *       400:
 *         description: Invalid points change
 *       500:
 *         description: Server error
 */
router.patch("/:userId", async (req, res) => {
  try {
    const { change } = req.body;
    if (typeof change !== "number")
      return res.status(400).json({ message: "Invalid points change" });

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.points += change;

    // Optional: prevent negative points
    if (user.points < 0) user.points = 0;

    await user.save();
    res.json({ userId: user._id, points: user.points });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update points" });
  }
});

export default router;