import { Router } from "express";
import mongoose from "mongoose";
import User from "../models/User";
import Point from "../models/Point";
import Order from "../models/Order";
import { requireAuth } from "../middleware/auth";
import { idempotencyKey } from "../middleware/idempotency";
import { parsePagination } from "../utils/pagination";

const router = Router();

// ===================== GET MY POINTS =====================
router.get("/", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("points").lean();
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ userId: req.userId, points: user.points || 0 });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch points" });
  }
});

// ===================== GET MY POINT HISTORY (paginated) =====================
router.get("/history", requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const { page: pageNum, limit: limitNum, skip } = parsePagination(req.query as Record<string, unknown>);

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
    res.status(500).json({ message: "Failed to fetch point history" });
  }
});

// ===================== REDEEM POINTS =====================
// BUSINESS P0-3 — server-side cap so client can't redeem more than
// the order's outstanding total (would otherwise debit points
// without a matching discount).
// BUSINESS P1-1 — wrapped in a Mongo transaction so deduct + order
// update + Point.create either ALL happen or none. Idempotency
// header dedupes a retry of the same logical operation.
router.post("/redeem", requireAuth, idempotencyKey(), async (req, res) => {
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

    // BUSINESS P0-3 — clamp at the smaller of (user points balance,
    // request, order total). 1 point = ₦1.
    const cappedRedeem = Math.min(pointsToRedeem, order.totalPrice);
    if (cappedRedeem <= 0) {
      return res.status(400).json({
        message: "Order total is already zero; nothing to redeem against.",
      });
    }

    // BUSINESS P1-1 — guard against double-redeem races. Pre-check
    // outside the transaction is for fast-fail UX; the actual
    // dedupe lives in the unique-keyed Point doc (same description
    // hash) so a concurrent second writer hits a duplicate-key
    // error inside the txn and the txn aborts cleanly.
    const alreadyRedeemed = await Point.findOne({
      user: req.userId,
      type: "redeem",
      description: { $regex: order._id.toString() },
    });
    if (alreadyRedeemed)
      return res.status(409).json({ message: "Points have already been redeemed on this order" });

    const discountAmount = cappedRedeem;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        order.totalPrice = Math.max(0, order.totalPrice - discountAmount);
        await order.save({ session });

        user.points -= cappedRedeem;
        await user.save({ session });

        await Point.create(
          [
            {
              user: req.userId,
              change: -cappedRedeem,
              type: "redeem",
              description: `Redeemed ${cappedRedeem} points on order #${order._id.toString().slice(-6).toUpperCase()}`,
              settled: true,
            },
          ],
          { session },
        );
      });
    } finally {
      session.endSession();
    }

    res.json({
      message: `${cappedRedeem} points redeemed. Order discount: ₦${discountAmount}`,
      newPointsBalance: user.points,
      updatedOrderTotal: order.totalPrice,
      cappedAt: cappedRedeem !== pointsToRedeem ? cappedRedeem : undefined,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to redeem points" });
  }
});


export default router;
