import { Router } from "express";
import User from "../models/User";
import Point from "../models/Point";
import Order from "../models/Order";
import { requireAuth } from "../middleware/auth";

const router = Router();

// ===================== GET MY POINTS =====================
router.get("/", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("points").lean();
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ userId: req.userId, points: user.points || 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch points" });
  }
});

// ===================== GET MY POINT HISTORY (paginated) =====================
router.get("/history", requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const { page = "1", limit = "20" } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10)));
    const skip = (pageNum - 1) * limitNum;

    const [pointsHistory, total] = await Promise.all([
      Point.find({ user: req.userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Point.countDocuments({ user: req.userId }),
    ]);

    const enrichedHistory = pointsHistory.map((p) => {
      let status: "pending" | "available" | "expired" = "available";
      if (p.pendingUntil && new Date(p.pendingUntil) > now) {
        status = "pending";
      } else if (p.expiresAt && new Date(p.expiresAt) < now) {
        status = "expired";
      } else if (p.settled === false) {
        status = "pending";
      }
      return { ...p, status };
    });

    res.json({
      data: enrichedHistory,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch point history" });
  }
});

// ===================== REDEEM POINTS =====================
router.post("/redeem", requireAuth, async (req, res) => {
  try {
    const { orderId, pointsToRedeem } = req.body;

    if (!orderId || typeof pointsToRedeem !== "number" || pointsToRedeem <= 0)
      return res.status(400).json({ message: "orderId and a positive pointsToRedeem are required" });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.points < pointsToRedeem)
      return res.status(400).json({ message: "Insufficient points balance" });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (order.user.toString() !== req.userId)
      return res.status(403).json({ message: "Forbidden" });

    if (order.status !== "pending")
      return res.status(400).json({ message: "Points can only be redeemed on pending orders" });

    // Each point is worth ₦1 in discount (customize as needed)
    const discountAmount = pointsToRedeem;
    order.totalPrice = Math.max(0, order.totalPrice - discountAmount);
    await order.save();

    user.points -= pointsToRedeem;
    await user.save();

    await Point.create({
      user: req.userId,
      change: -pointsToRedeem,
      type: "redeem",
      description: `Redeemed ${pointsToRedeem} points on order #${order._id.toString().slice(-6).toUpperCase()}`,
      settled: true,
    });

    res.json({
      message: `${pointsToRedeem} points redeemed. Order discount: ₦${discountAmount}`,
      newPointsBalance: user.points,
      updatedOrderTotal: order.totalPrice,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to redeem points" });
  }
});

// ===================== ADMIN: UPDATE POINTS =====================
router.patch("/:userId", requireAuth, async (req, res) => {
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
      settled: !isPending,
    });

    res.json({ userId: user._id, points: user.points || 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update points" });
  }
});

export default router;
