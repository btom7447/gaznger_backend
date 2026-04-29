import { Router } from "express";
import mongoose from "mongoose";
import Dispute from "../models/Dispute";
import Order from "../models/Order";
import { requireAuth } from "../middleware/auth";
import { notifyUser } from "../utils/notify";
import { emitToUser } from "../socket";
import { parsePagination } from "../utils/pagination";

const router = Router();

/**
 * POST /api/disputes
 * Customer raises a problem on an order. Opening a dispute freezes the
 * order's escrow release until admin resolves it (settleOrderEarnings
 * checks for an open dispute).
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    const { orderId, reason, description, evidence } = req.body;
    if (!orderId) return res.status(400).json({ message: "orderId is required" });
    if (!reason) return res.status(400).json({ message: "reason is required" });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.user.toString() !== req.userId)
      return res.status(403).json({ message: "Forbidden" });

    if (!["paid", "refunded"].includes(order.paymentStatus)) {
      return res.status(400).json({
        message: "Only paid orders can be disputed",
      });
    }

    const existing = await Dispute.findOne({ order: orderId });
    if (existing) {
      return res
        .status(409)
        .json({ message: "A dispute already exists for this order", dispute: existing });
    }

    const dispute = await Dispute.create({
      order: orderId,
      raisedBy: req.userId,
      reason,
      description: description ?? "",
      evidence: Array.isArray(evidence) ? evidence : [],
      status: "open",
    });

    // Notify admin team — for now, just emit a socket; admin dashboard
    // wires up its own listener.
    emitToUser(req.userId!, "dispute:opened", {
      disputeId: dispute._id,
      orderId: order._id,
    });

    await notifyUser(
      req.userId!,
      "order",
      "Dispute Opened",
      "We've received your report. The team will review it shortly."
    );

    res.status(201).json(dispute);
  } catch (err) {
    console.error("[disputes/POST]", err);
    res.status(500).json({ message: "Failed to open dispute" });
  }
});

/**
 * GET /api/disputes/me
 * Caller's disputes (paginated).
 */
router.get("/me", requireAuth, async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
    const filter = { raisedBy: req.userId };

    const [items, total] = await Promise.all([
      Dispute.find(filter)
        .populate("order")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Dispute.countDocuments(filter),
    ]);

    res.json({
      data: items,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("[disputes/me]", err);
    res.status(500).json({ message: "Failed to fetch disputes" });
  }
});

/**
 * GET /api/disputes/:id
 * Disputed order detail. Caller must be the raiser (or admin — admin
 * uses the admin route family for their queue view).
 */
router.get("/:id", requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id))
      return res.status(400).json({ message: "Invalid dispute id" });

    const dispute = await Dispute.findById(req.params.id)
      .populate("order")
      .lean();
    if (!dispute) return res.status(404).json({ message: "Not found" });
    if (dispute.raisedBy.toString() !== req.userId)
      return res.status(403).json({ message: "Forbidden" });
    res.json(dispute);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch dispute" });
  }
});

export default router;
