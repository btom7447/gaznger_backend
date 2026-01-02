import { Router } from "express";
import User from "../models/User";
import Point from "../models/Point";

const router = Router();

/**
 * Helper: compute user's effective points (ignoring pending & expired)
 */
async function getEffectivePoints(userId: string) {
  const now = new Date();

  const points = await Point.find({
    user: userId,
    $and: [
      {
        $or: [
          { pendingUntil: { $lte: now } },
          { pendingUntil: { $exists: false } },
        ],
      },
      {
        $or: [{ expiresAt: { $gte: now } }, { expiresAt: { $exists: false } }],
      },
    ],
  });

  return points.reduce((sum, p) => sum + p.change, 0);
}

// ===================== GET CURRENT POINTS =====================
/**
 * @swagger
 * /api/points/{userId}:
 *   get:
 *     summary: Get current effective points for a user
 *     tags: [Points]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Current points
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.get("/:userId", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const effectivePoints = await getEffectivePoints(user._id.toString());
    res.json({ userId: user._id, points: effectivePoints });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch points" });
  }
});

// ===================== GET POINT HISTORY =====================
/**
 * @swagger
 * /api/points/{userId}/history:
 *   get:
 *     summary: Get full point transaction history for a user
 *     tags: [Points]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Array of point transactions
 *       500:
 *         description: Server error
 */
router.get("/:userId/history", async (req, res) => {
  try {
    const pointsHistory = await Point.find({ user: req.params.userId }).sort({
      createdAt: -1,
    });
    res.json(pointsHistory);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch point history" });
  }
});

// ===================== PATCH/UPDATE POINTS =====================
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
 *               description:
 *                 type: string
 *               pendingUntil:
 *                 type: string
 *                 format: date-time
 *               expiresAt:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Updated effective points
 *       400:
 *         description: Invalid points change
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.patch("/:userId", async (req, res) => {
  try {
    const { change, description, pendingUntil, expiresAt } = req.body;
    if (typeof change !== "number")
      return res.status(400).json({ message: "Invalid points change" });

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const now = new Date();
    const isPending = pendingUntil && new Date(pendingUntil) > now;

    if (!isPending) {
      user.points += change;
      if (user.points < 0) user.points = 0;
      await user.save();
    }

    await Point.create({
      user: user._id.toString(),
      change,
      type: change > 0 ? "earn" : "redeem",
      description: description || "",
      pendingUntil: pendingUntil ? new Date(pendingUntil) : undefined,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    });

    const effectivePoints = await getEffectivePoints(user._id.toString());
    res.json({ userId: user._id, points: effectivePoints });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update points" });
  }
});

export default router;