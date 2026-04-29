import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth, requireAdmin } from "../middleware/auth";
import User from "../models/User";
import Order from "../models/Order";
import Withdrawal from "../models/Withdrawal";
import Dispute from "../models/Dispute";
import AuditLog from "../models/AuditLog";
import RiderProfile from "../models/RiderProfile";
import PlatformConfig from "../models/PlatformConfig";
import {
  invalidatePlatformConfig,
  getPlatformConfig,
} from "../utils/platformConfig";
import { refundOrderToWallet, settleOrderEarnings } from "../utils/earningsUtils";
import { refundTransaction } from "../utils/paystack";
import { notifyUser } from "../utils/notify";
import { emitToUser } from "../socket";
import { parsePagination } from "../utils/pagination";
import { idempotencyKey } from "../middleware/idempotency";

const router = Router();

// All admin routes require auth + admin role.
router.use(requireAuth, requireAdmin);

/* ──────────────────────────── helpers ────────────────────────────── */

async function writeAudit(args: {
  actor: string;
  action: any;
  targetKind: any;
  target: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  ip?: string;
}) {
  await AuditLog.create({
    actor: args.actor,
    action: args.action,
    targetKind: args.targetKind,
    target: args.target,
    before: args.before,
    after: args.after,
    reason: args.reason,
    ip: args.ip,
  });
}

/* ────────────────── PLATFORM CONFIG (commission %) ───────────────── */

/**
 * GET /api/admin/config
 * Read the singleton platform config (commission rates, windows, fees).
 */
router.get("/config", async (_req, res) => {
  try {
    const cfg = await getPlatformConfig();
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ message: "Failed to load config" });
  }
});

/**
 * PATCH /api/admin/config
 * Body: any subset of the editable fields.
 */
router.patch("/config", async (req, res) => {
  try {
    const editable = [
      "vendorCommission",
      "riderCommission",
      "disputeWindowHours",
      "withdrawalHoldHours",
      "minChargeNgn",
      "withdrawalFeeNgn",
      "paymentsEnabled",
      "withdrawalsEnabled",
    ] as const;

    const updates: Record<string, unknown> = {};
    for (const key of editable) {
      if (key in req.body) updates[key] = req.body[key];
    }
    if (Object.keys(updates).length === 0)
      return res.status(400).json({ message: "No editable fields supplied" });

    // Light validation — commissions in [0, 0.5], windows positive.
    if (
      "vendorCommission" in updates &&
      (typeof updates.vendorCommission !== "number" ||
        updates.vendorCommission < 0 ||
        updates.vendorCommission > 0.5)
    )
      return res.status(400).json({ message: "vendorCommission must be 0–0.5" });
    if (
      "riderCommission" in updates &&
      (typeof updates.riderCommission !== "number" ||
        updates.riderCommission < 0 ||
        updates.riderCommission > 0.5)
    )
      return res.status(400).json({ message: "riderCommission must be 0–0.5" });

    const before = await PlatformConfig.findOne({ key: "main" }).lean();
    const after = await PlatformConfig.findOneAndUpdate(
      { key: "main" },
      { $set: updates },
      { new: true, upsert: true }
    );
    invalidatePlatformConfig();

    await writeAudit({
      actor: req.userId!,
      action: "config.update",
      targetKind: "PlatformConfig",
      target: (after!._id as mongoose.Types.ObjectId).toString(),
      before,
      after,
      reason: req.body.reason,
      ip: req.ip,
    });

    res.json(after);
  } catch (err) {
    console.error("[admin/config]", err);
    res.status(500).json({ message: "Failed to update config" });
  }
});

/* ────────────────────── USER MANAGEMENT ───────────────────────── */

/**
 * POST /api/admin/users/:id/activate
 * Body: { reason? }
 */
router.post("/users/:id/activate", async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    const before = { accountStatus: user.accountStatus };
    user.accountStatus = "active";
    await user.save();
    await writeAudit({
      actor: req.userId!,
      action: "user.activate",
      targetKind: "User",
      target: user._id.toString(),
      before,
      after: { accountStatus: user.accountStatus },
      reason: req.body?.reason,
      ip: req.ip,
    });
    await notifyUser(
      user._id.toString(),
      "account",
      "Account Activated",
      "Your Gaznger account has been activated. You can now use all features."
    );
    res.json({ message: "User activated", user });
  } catch (err) {
    res.status(500).json({ message: "Failed to activate user" });
  }
});

/**
 * POST /api/admin/users/:id/suspend
 * Body: { reason }
 */
router.post("/users/:id/suspend", async (req, res) => {
  try {
    if (!req.body?.reason)
      return res.status(400).json({ message: "reason is required" });
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    const before = { accountStatus: user.accountStatus };
    user.accountStatus = "suspended";
    await user.save();
    await writeAudit({
      actor: req.userId!,
      action: "user.deactivate",
      targetKind: "User",
      target: user._id.toString(),
      before,
      after: { accountStatus: user.accountStatus },
      reason: req.body.reason,
      ip: req.ip,
    });
    await notifyUser(
      user._id.toString(),
      "account",
      "Account Suspended",
      `Your account has been suspended. Reason: ${req.body.reason}`
    );
    res.json({ message: "User suspended", user });
  } catch (err) {
    res.status(500).json({ message: "Failed to suspend user" });
  }
});

/**
 * POST /api/admin/users/:id/verify
 * Verifies vendor or rider KYC. Vendor → User.vendorVerification.status,
 * Rider → RiderProfile.verificationStatus + isVerified.
 * Body: { kind: "vendor" | "rider", note? }
 */
router.post("/users/:id/verify", async (req, res) => {
  try {
    const { kind, note } = req.body ?? {};
    if (kind !== "vendor" && kind !== "rider")
      return res.status(400).json({ message: "kind must be 'vendor' or 'rider'" });

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    let before: any;
    let after: any;

    if (kind === "vendor") {
      before = { status: user.vendorVerification?.status };
      user.vendorVerification = {
        ...(user.vendorVerification ?? { documents: [] }),
        status: "verified",
        reviewedAt: new Date(),
        note,
      } as any;
      await user.save();
      after = { status: user.vendorVerification?.status };
    } else {
      const profile = await RiderProfile.findOne({ user: user._id });
      if (!profile)
        return res.status(404).json({ message: "Rider profile not found" });
      before = { status: profile.verificationStatus };
      profile.verificationStatus = "verified";
      profile.isVerified = true;
      profile.verificationNote = note;
      await profile.save();
      after = { status: profile.verificationStatus };
    }

    await writeAudit({
      actor: req.userId!,
      action: "user.verify",
      targetKind: "User",
      target: user._id.toString(),
      before,
      after,
      reason: note,
      ip: req.ip,
    });
    await notifyUser(
      user._id.toString(),
      "account",
      "Verification Approved",
      "Your KYC has been approved. You can now receive payouts."
    );

    res.json({ message: "User verified", kind });
  } catch (err) {
    console.error("[admin/verify]", err);
    res.status(500).json({ message: "Failed to verify user" });
  }
});

/**
 * POST /api/admin/users/:id/reject
 * Body: { kind: "vendor" | "rider", reason }
 */
router.post("/users/:id/reject", async (req, res) => {
  try {
    const { kind, reason } = req.body ?? {};
    if (kind !== "vendor" && kind !== "rider")
      return res.status(400).json({ message: "kind must be 'vendor' or 'rider'" });
    if (!reason) return res.status(400).json({ message: "reason is required" });

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (kind === "vendor") {
      user.vendorVerification = {
        ...(user.vendorVerification ?? { documents: [] }),
        status: "rejected",
        reviewedAt: new Date(),
        note: reason,
      } as any;
      await user.save();
    } else {
      const profile = await RiderProfile.findOne({ user: user._id });
      if (!profile)
        return res.status(404).json({ message: "Rider profile not found" });
      profile.verificationStatus = "rejected";
      profile.isVerified = false;
      profile.verificationNote = reason;
      await profile.save();
    }

    await writeAudit({
      actor: req.userId!,
      action: "user.reject",
      targetKind: "User",
      target: user._id.toString(),
      reason,
      ip: req.ip,
    });
    await notifyUser(
      user._id.toString(),
      "account",
      "Verification Rejected",
      `Your KYC was rejected. Reason: ${reason}`
    );

    res.json({ message: "User rejected", kind });
  } catch (err) {
    res.status(500).json({ message: "Failed to reject user" });
  }
});

/**
 * POST /api/admin/users/:id/withdrawal-hold
 * Body: { active: boolean, reason? }
 */
router.post("/users/:id/withdrawal-hold", async (req, res) => {
  try {
    const { active, reason } = req.body ?? {};
    if (typeof active !== "boolean")
      return res.status(400).json({ message: "active must be boolean" });

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const before = { ...(user.withdrawalHold ?? { active: false }) };
    user.withdrawalHold = active
      ? {
          active: true,
          reason,
          setBy: new mongoose.Types.ObjectId(req.userId!),
          setAt: new Date(),
        }
      : { active: false };
    await user.save();

    await writeAudit({
      actor: req.userId!,
      action: active ? "user.withdrawal_hold.set" : "user.withdrawal_hold.clear",
      targetKind: "User",
      target: user._id.toString(),
      before,
      after: user.withdrawalHold,
      reason,
      ip: req.ip,
    });

    if (active) {
      await notifyUser(
        user._id.toString(),
        "payment",
        "Withdrawals on Hold",
        reason
          ? `Your withdrawals are on hold: ${reason}`
          : "Your withdrawals are temporarily on hold. Contact support."
      );
    }

    res.json({ message: active ? "Hold set" : "Hold cleared", user });
  } catch (err) {
    res.status(500).json({ message: "Failed to toggle hold" });
  }
});

/**
 * POST /api/admin/users/:id/message
 * Body: { title, message }
 * Sends a one-off in-app notification + push.
 */
router.post("/users/:id/message", async (req, res) => {
  try {
    const { title, message } = req.body ?? {};
    if (!title || !message)
      return res.status(400).json({ message: "title and message are required" });
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    await notifyUser(user._id.toString(), "account", title, message);
    await writeAudit({
      actor: req.userId!,
      action: "user.message",
      targetKind: "User",
      target: user._id.toString(),
      after: { title, message },
      ip: req.ip,
    });

    res.json({ message: "Message sent" });
  } catch (err) {
    res.status(500).json({ message: "Failed to send message" });
  }
});

/* ──────────────────────── REFUND ─────────────────────────────── */

/**
 * POST /api/admin/orders/:id/refund
 * Body: { amount?: number, reason: string, destination: "card"|"wallet" }
 *
 * Currently full refunds only — `amount` is treated as totalPrice if
 * omitted. v1 sends Paystack a /refund (card destination) or moves
 * escrow → customer wallet (wallet destination).
 *
 * NB: if the order has already been settled, the funds are out of
 * escrow and admin must claw back from recipients separately. The
 * endpoint surfaces a 409 in that case.
 */
router.post(
  "/orders/:id/refund",
  idempotencyKey({ enforce: true }),
  async (req, res) => {
    try {
      const { reason, destination } = req.body ?? {};
      if (!reason) return res.status(400).json({ message: "reason is required" });
      if (destination !== "card" && destination !== "wallet")
        return res
          .status(400)
          .json({ message: "destination must be 'card' or 'wallet'" });

      const order = await Order.findById(req.params.id);
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.paymentStatus !== "paid")
        return res.status(400).json({
          message: `Cannot refund order with paymentStatus=${order.paymentStatus}`,
        });
      if (order.status === "delivered")
        return res.status(409).json({
          message:
            "Order already delivered & settled — admin must claw back from vendor/rider directly.",
        });

      const amount = Number(req.body?.amount ?? order.totalPrice);
      if (amount <= 0 || amount > order.totalPrice)
        return res
          .status(400)
          .json({ message: "amount must be > 0 and ≤ order total" });

      if (destination === "wallet") {
        await refundOrderToWallet({
          orderId: order._id.toString(),
          amount,
          reason,
          adminId: req.userId,
        });
      } else {
        // Card refund — Paystack async. Mark Order optimistically; webhook
        // (refund.processed) will reconcile on success or revert on fail.
        if (!order.paymentRef)
          return res
            .status(400)
            .json({ message: "Order has no payment reference to refund" });
        await refundTransaction({
          transaction: order.paymentRef,
          amount: Math.round(amount * 100),
          customer_note: reason,
          merchant_note: `Refund by admin ${req.userId}`,
        });
      }

      order.paymentStatus = "refunded";
      order.cancellationReason = `Refund: ${reason}`;
      order.status = "cancelled";
      await order.save();

      await writeAudit({
        actor: req.userId!,
        action: "order.refund",
        targetKind: "Order",
        target: order._id.toString(),
        after: { amount, destination, reason },
        reason,
        ip: req.ip,
      });

      await notifyUser(
        order.user.toString(),
        "payment",
        "Refund Issued",
        destination === "card"
          ? `A refund of ₦${amount.toLocaleString()} has been sent back to your card.`
          : `₦${amount.toLocaleString()} has been credited to your Gaznger wallet.`
      );
      emitToUser(order.user.toString(), "order:update", {
        orderId: order._id,
        status: order.status,
        paymentStatus: order.paymentStatus,
      });

      res.json({ message: "Refund processed", order });
    } catch (err) {
      console.error("[admin/refund]", err);
      res.status(500).json({ message: "Failed to refund order" });
    }
  }
);

/* ───────────────────── DISPUTES (admin) ──────────────────────── */

/**
 * GET /api/admin/disputes?status=open
 * Paginated list of disputes for the admin queue.
 */
router.get("/disputes", async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
    const filter: any = {};
    if (req.query.status) filter.status = req.query.status;

    const [items, total] = await Promise.all([
      Dispute.find(filter)
        .populate({ path: "order" })
        .populate({ path: "raisedBy", select: "displayName email" })
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
    res.status(500).json({ message: "Failed to load disputes" });
  }
});

/**
 * POST /api/admin/disputes/:id/resolve
 * Body: { resolution, refundAmount?, refundDestination? }
 *
 * Resolution paths:
 *   - refundAmount > 0  → triggers a refund (default destination=wallet)
 *                          and then settles the order (so vendor/rider
 *                          still get paid for their portion).
 *   - refundAmount = 0  → settles the order normally, dispute closed.
 */
router.post("/disputes/:id/resolve", idempotencyKey(), async (req, res) => {
  try {
    const { resolution, refundAmount = 0, refundDestination = "wallet" } =
      req.body ?? {};
    if (!resolution)
      return res.status(400).json({ message: "resolution is required" });

    const dispute = await Dispute.findById(req.params.id);
    if (!dispute) return res.status(404).json({ message: "Not found" });
    if (dispute.status !== "open")
      return res
        .status(400)
        .json({ message: "Only open disputes can be resolved" });

    if (refundAmount > 0) {
      const order = await Order.findById(dispute.order);
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (refundDestination === "wallet") {
        await refundOrderToWallet({
          orderId: order._id.toString(),
          amount: refundAmount,
          reason: resolution,
          adminId: req.userId,
        });
      } else {
        if (!order.paymentRef)
          return res
            .status(400)
            .json({ message: "Order has no Paystack ref for card refund" });
        await refundTransaction({
          transaction: order.paymentRef,
          amount: Math.round(refundAmount * 100),
          customer_note: resolution,
          merchant_note: `Dispute ${dispute._id}`,
        });
      }
    }

    dispute.status = "resolved";
    dispute.resolver = new mongoose.Types.ObjectId(req.userId!);
    dispute.resolvedAt = new Date();
    dispute.resolution = resolution;
    dispute.refundAmount = refundAmount;
    await dispute.save();

    // Now that the dispute is closed, settle the order earnings.
    await settleOrderEarnings(dispute.order.toString());

    await writeAudit({
      actor: req.userId!,
      action: "dispute.resolve",
      targetKind: "Dispute",
      target: dispute._id.toString(),
      after: { resolution, refundAmount, refundDestination },
      reason: resolution,
      ip: req.ip,
    });

    await notifyUser(
      dispute.raisedBy.toString(),
      "order",
      "Dispute Resolved",
      refundAmount > 0
        ? `Your dispute was resolved. Refund of ₦${refundAmount.toLocaleString()} has been issued.`
        : "Your dispute was resolved. Thanks for the report."
    );

    res.json({ message: "Dispute resolved", dispute });
  } catch (err) {
    console.error("[admin/disputes/resolve]", err);
    res.status(500).json({ message: "Failed to resolve dispute" });
  }
});

/**
 * POST /api/admin/disputes/:id/reject
 * Body: { resolution }
 * No refund — settles order normally.
 */
router.post("/disputes/:id/reject", async (req, res) => {
  try {
    const { resolution } = req.body ?? {};
    if (!resolution)
      return res.status(400).json({ message: "resolution is required" });

    const dispute = await Dispute.findById(req.params.id);
    if (!dispute) return res.status(404).json({ message: "Not found" });
    if (dispute.status !== "open")
      return res
        .status(400)
        .json({ message: "Only open disputes can be rejected" });

    dispute.status = "rejected";
    dispute.resolver = new mongoose.Types.ObjectId(req.userId!);
    dispute.resolvedAt = new Date();
    dispute.resolution = resolution;
    await dispute.save();

    await settleOrderEarnings(dispute.order.toString());

    await writeAudit({
      actor: req.userId!,
      action: "dispute.reject",
      targetKind: "Dispute",
      target: dispute._id.toString(),
      after: { resolution },
      reason: resolution,
      ip: req.ip,
    });

    await notifyUser(
      dispute.raisedBy.toString(),
      "order",
      "Dispute Closed",
      "After review, your dispute was closed. Reach out to support if you have questions."
    );

    res.json({ message: "Dispute rejected", dispute });
  } catch (err) {
    res.status(500).json({ message: "Failed to reject dispute" });
  }
});

/* ───────────────────── WITHDRAWALS (admin) ───────────────────── */

/**
 * GET /api/admin/withdrawals?status=pending
 */
router.get("/withdrawals", async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
    const filter: any = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.role) filter.role = req.query.role;

    const [items, total] = await Promise.all([
      Withdrawal.find(filter)
        .populate({ path: "user", select: "displayName email role" })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Withdrawal.countDocuments(filter),
    ]);

    res.json({
      data: items,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load withdrawals" });
  }
});

/* ───────────────────── SYSTEM WALLETS ────────────────────────── */

/**
 * GET /api/admin/wallets/system
 * Snapshot of platform-escrow + platform-revenue wallets for the
 * dashboard. Use the regular /api/wallet/transactions cursor flow to
 * page through individual ledger entries.
 */
router.get("/wallets/system", async (_req, res) => {
  try {
    const Wallet = (await import("../models/Wallet")).default;
    const wallets = await Wallet.find({ ownerKind: "system" }).lean();
    const map: Record<string, { available: number; pending: number }> = {};
    for (const w of wallets) {
      if (w.systemKind) {
        map[w.systemKind] = { available: w.available, pending: w.pending };
      }
    }
    res.json({
      escrow: map["platform-escrow"] ?? { available: 0, pending: 0 },
      revenue: map["platform-revenue"] ?? { available: 0, pending: 0 },
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load system wallets" });
  }
});

/* ───────────────────── USER DETAIL ────────────────────────────── */

/**
 * GET /api/admin/users/:id/detail
 * Full user record + wallet balances + recent withdrawals + dispute count.
 * The dashboard's user-detail page hits this; the legacy /admin/users
 * endpoint stays as the lightweight list for the table view.
 */
router.get("/users/:id/detail", async (req, res) => {
  try {
    const Wallet = (await import("../models/Wallet")).default;
    const user = await User.findById(req.params.id)
      .select("-passwordHash -otpCode -otpExpiresAt -deviceTokens")
      .lean();
    if (!user) return res.status(404).json({ message: "User not found" });

    const [wallet, withdrawalCount, openDisputeCount] = await Promise.all([
      Wallet.findOne({ user: user._id, ownerKind: "user" }).lean(),
      Withdrawal.countDocuments({ user: user._id }),
      Dispute.countDocuments({ raisedBy: user._id, status: "open" }),
    ]);

    let riderProfile: any = null;
    if (user.role === "rider") {
      riderProfile = await RiderProfile.findOne({ user: user._id }).lean();
    }

    res.json({
      user,
      wallet: wallet
        ? { available: wallet.available, pending: wallet.pending }
        : { available: 0, pending: 0 },
      withdrawalCount,
      openDisputeCount,
      riderProfile,
    });
  } catch (err) {
    console.error("[admin/users/detail]", err);
    res.status(500).json({ message: "Failed to load user detail" });
  }
});

/* ─────────────────────── AUDIT LOG ───────────────────────────── */

/**
 * GET /api/admin/audit-log?action=...&targetKind=...
 */
router.get("/audit-log", async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
    const filter: any = {};
    if (req.query.action) filter.action = req.query.action;
    if (req.query.targetKind) filter.targetKind = req.query.targetKind;
    if (req.query.target) filter.target = req.query.target;
    if (req.query.actor) filter.actor = req.query.actor;

    const [items, total] = await Promise.all([
      AuditLog.find(filter)
        .populate({ path: "actor", select: "displayName email" })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AuditLog.countDocuments(filter),
    ]);

    res.json({
      data: items,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load audit log" });
  }
});

export default router;
