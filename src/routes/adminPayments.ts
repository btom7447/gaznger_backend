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
import {
  refundTransaction,
  createTransferRecipient,
  initiateTransfer,
} from "../utils/paystack";
import {
  getOrCreateUserWallet,
  getOrCreateSystemWallet,
  postTransfer,
} from "../utils/wallet";
import { notifyUser } from "../utils/notify";
import { emitToUser, emitToAdmins } from "../socket";
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
      "orderPlacementEnabled",
      "dispatchEnabled",
      "signupsEnabled",
      "minMobileVersion",
      "maintenanceMode",
      "maintenanceExpectedBackAt",
      "maintenanceReason",
      "support",
    ] as const;

    const updates: Record<string, unknown> = {};
    for (const key of editable) {
      if (key in req.body) updates[key] = req.body[key];
    }
    if (Object.keys(updates).length === 0)
      return res.status(400).json({ message: "No editable fields supplied" });

    // Concurrent-edit detection. Client passes `expectedUpdatedAt` from
    // the last GET; if the server's `updatedAt` is newer, another admin
    // has saved in between. Returning 409 instead of silently
    // overwriting prevents the lost-write scenario from the audit.
    const expected = req.body?.expectedUpdatedAt as string | undefined;
    if (expected) {
      const current = await PlatformConfig.findOne({ key: "main" })
        .select("updatedAt")
        .lean();
      if (
        current?.updatedAt &&
        new Date(current.updatedAt).getTime() !== new Date(expected).getTime()
      ) {
        return res.status(409).json({
          message:
            "Another admin saved changes since you loaded this page. Reload to see the latest values, then re-apply your edits.",
          currentUpdatedAt: current.updatedAt,
        });
      }
    }

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
 *
 * SEC-P2 (audit run 6): idempotencyKey() for parity with sibling
 * /disputes/:id/{resolve,reject} and the refund/retry routes below.
 * Without it, a double-clicked Activate writes two AuditLog rows + two
 * "Account Activated" pushes (status flip itself is idempotent in
 * effect since the second write sets the same value).
 */
router.post("/users/:id/activate", idempotencyKey(), async (req, res) => {
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
 *
 * SEC-P2 (audit run 6): idempotencyKey() parity — see /activate above.
 */
router.post("/users/:id/suspend", idempotencyKey(), async (req, res) => {
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
 *
 * SEC-P2 (audit run 6): idempotencyKey() parity — see /activate above.
 */
router.post("/users/:id/verify", idempotencyKey(), async (req, res) => {
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
      // CRITICAL: also set the unified User.verificationStatus field
      // that `postAuthPathFor` reads. Without this, the vendor's
      // RiderProfile/vendorVerification flips but the mobile auth
      // router still treats them as unverified and sends them back to
      // the verification screen after login.
      user.verificationStatus = "approved";
      user.verificationReason = note;
      user.verificationReviewedAt = new Date();
      user.verificationReviewedBy = req.userId as never;
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
      // Same fix as the vendor branch — propagate to the unified User
      // field so the mobile auth router sends the rider to /(rider)/(queue)
      // instead of /(auth)/verification/pending on next login.
      user.verificationStatus = "approved";
      user.verificationReason = note;
      user.verificationReviewedAt = new Date();
      user.verificationReviewedBy = req.userId as never;
      await user.save();
      after = { status: profile.verificationStatus };
    }

    // Push the status change to the user's socket room so the mobile
    // pending-lobby flips in real-time if they're sitting on it.
    emitToUser(String(user._id), "verification:status", {
      status: "approved",
      reason: note,
    });

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
 *
 * SEC-P2 (audit run 6): idempotencyKey() parity — see /activate above.
 */
router.post("/users/:id/reject", idempotencyKey(), async (req, res) => {
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
      // Mirror the rejection onto User.verificationStatus so the
      // mobile auth router treats them as rejected (routes to the
      // verification screen with the reason visible).
      user.verificationStatus = "rejected";
      user.verificationReason = reason;
      user.verificationReviewedAt = new Date();
      user.verificationReviewedBy = req.userId as never;
      await user.save();
    } else {
      const profile = await RiderProfile.findOne({ user: user._id });
      if (!profile)
        return res.status(404).json({ message: "Rider profile not found" });
      profile.verificationStatus = "rejected";
      profile.isVerified = false;
      profile.verificationNote = reason;
      await profile.save();
      // Same mirror on the rider branch.
      user.verificationStatus = "rejected";
      user.verificationReason = reason;
      user.verificationReviewedAt = new Date();
      user.verificationReviewedBy = req.userId as never;
      await user.save();
    }

    emitToUser(String(user._id), "verification:status", {
      status: "rejected",
      reason,
    });

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
 *
 * SEC-P2 (audit run 6): idempotencyKey() parity — see /activate above.
 */
router.post("/users/:id/withdrawal-hold", idempotencyKey(), async (req, res) => {
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
 *
 * SEC-P2 (audit run 6): idempotencyKey() parity — see /activate above.
 * Especially important here since the only effect IS a notification +
 * audit row; a retried request without dedupe spams the user.
 */
router.post("/users/:id/message", idempotencyKey(), async (req, res) => {
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
      // SECURITY P0 (audit run 5): Number("abc") → NaN; both
      // amount <= 0 and amount > total comparisons against NaN return
      // false, so the guard passes. NaN then flows into
      // refundOrderToWallet and Math.round(amount*100) for Paystack,
      // corrupting the wallet ledger with NaN balances or generating
      // invalid Paystack requests. isFinite filters NaN + Infinity.
      if (!Number.isFinite(amount) || amount <= 0 || amount > order.totalPrice)
        return res
          .status(400)
          .json({ message: "amount must be a finite number > 0 and ≤ order total" });

      if (destination === "wallet") {
        await refundOrderToWallet({
          orderId: order._id.toString(),
          amount,
          reason,
          adminId: req.userId,
        });
        // Wallet refunds settle instantly — no Paystack webhook to wait on.
        order.refundStatus = "succeeded";
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
        // Stays "pending" until refund.processed / refund.failed webhook
        // flips it. Admin sees a Retry button when this sits > 10 min.
        order.refundStatus = "pending";
      }

      order.paymentStatus = "refunded";
      order.cancellationReason = `Refund: ${reason}`;
      order.status = "cancelled";
      order.refundAmount = amount;
      order.refundDestination = destination;
      order.refundInitiatedAt = new Date();
      order.refundFailReason = undefined;
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

    let disputeRefundStatus: "pending" | "succeeded" | undefined;
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
        disputeRefundStatus = "succeeded";
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
        disputeRefundStatus = "pending";
      }
    }

    dispute.status = "resolved";
    dispute.resolver = new mongoose.Types.ObjectId(req.userId!);
    dispute.resolvedAt = new Date();
    dispute.resolution = resolution;
    dispute.refundAmount = refundAmount;
    if (refundAmount > 0) {
      dispute.refundDestination = refundDestination;
      dispute.refundStatus = disputeRefundStatus;
      dispute.refundInitiatedAt = new Date();
      dispute.refundFailReason = undefined;
    }
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
// SEC-P2 (audit run 5): sibling /resolve has idempotencyKey() — reject
// pre-fix didn't, so a double-click wrote two AuditLog rows + two
// notifications. Adds parity.
router.post("/disputes/:id/reject", idempotencyKey(), async (req, res) => {
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

/* ──────────────────── REFUND RETRY (orders + disputes) ──────────────────── */

/**
 * POST /api/admin/orders/:id/refund-retry
 *
 * Re-fires a stuck card refund. The original refund left the Order in
 * `refundStatus="pending"` (or "failed") if the Paystack webhook never
 * landed. This endpoint re-calls Paystack with the original amount +
 * destination and resets `refundInitiatedAt` so the "stuck N minutes"
 * badge restarts. Audit-logged.
 */
router.post(
  "/orders/:id/refund-retry",
  idempotencyKey({ enforce: true }),
  async (req, res) => {
    try {
      const order = await Order.findById(req.params.id);
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.refundStatus === "succeeded")
        return res.status(409).json({ message: "Refund already succeeded" });
      if (!order.refundDestination || order.refundDestination === "wallet")
        return res
          .status(400)
          .json({ message: "Only card refunds can be retried" });
      if (!order.paymentRef)
        return res
          .status(400)
          .json({ message: "Order has no payment reference" });
      const amount = Number(order.refundAmount ?? order.totalPrice);
      if (!amount || amount <= 0)
        return res.status(400).json({ message: "No refund amount on order" });

      await refundTransaction({
        transaction: order.paymentRef,
        amount: Math.round(amount * 100),
        customer_note: `Retry: ${order.cancellationReason ?? "refund"}`,
        merchant_note: `Refund retry by admin ${req.userId}`,
      });

      order.refundStatus = "pending";
      order.refundInitiatedAt = new Date();
      order.refundFailReason = undefined;
      await order.save();

      await writeAudit({
        actor: req.userId!,
        action: "order.refund-retry",
        targetKind: "Order",
        target: order._id.toString(),
        after: { amount, destination: order.refundDestination },
        ip: req.ip,
      });

      res.json({ message: "Refund retried", order });
    } catch (err) {
      console.error("[admin/orders/refund-retry]", err);
      res.status(500).json({ message: "Failed to retry refund" });
    }
  }
);

/**
 * POST /api/admin/disputes/:id/refund-retry
 *
 * Mirror of /orders/:id/refund-retry for disputes — re-fires a stuck
 * dispute-resolution refund.
 */
router.post(
  "/disputes/:id/refund-retry",
  idempotencyKey({ enforce: true }),
  async (req, res) => {
    try {
      const dispute = await Dispute.findById(req.params.id);
      if (!dispute) return res.status(404).json({ message: "Not found" });
      if (dispute.refundStatus === "succeeded")
        return res.status(409).json({ message: "Refund already succeeded" });
      if (!dispute.refundDestination || dispute.refundDestination === "wallet")
        return res
          .status(400)
          .json({ message: "Only card refunds can be retried" });
      const amount = Number(dispute.refundAmount ?? 0);
      if (!amount || amount <= 0)
        return res
          .status(400)
          .json({ message: "No refund amount on dispute" });

      const order = await Order.findById(dispute.order);
      if (!order?.paymentRef)
        return res
          .status(400)
          .json({ message: "Underlying order has no Paystack ref" });

      await refundTransaction({
        transaction: order.paymentRef,
        amount: Math.round(amount * 100),
        customer_note: `Retry dispute ${dispute._id}`,
        merchant_note: `Dispute refund retry by admin ${req.userId}`,
      });

      dispute.refundStatus = "pending";
      dispute.refundInitiatedAt = new Date();
      dispute.refundFailReason = undefined;
      await dispute.save();

      await writeAudit({
        actor: req.userId!,
        action: "dispute.refund-retry",
        targetKind: "Dispute",
        target: dispute._id.toString(),
        after: { amount },
        ip: req.ip,
      });

      res.json({ message: "Refund retried", dispute });
    } catch (err) {
      console.error("[admin/disputes/refund-retry]", err);
      res.status(500).json({ message: "Failed to retry refund" });
    }
  }
);

/* ──────────────────── WITHDRAWAL ADMIN ACTIONS ──────────────────── */

/**
 * GET /api/admin/withdrawals/:id
 * Detail view: withdrawal + populated user + the ledger Transactions
 * that share this withdrawal's _id (debit, fee, optional reversal).
 */
router.get("/withdrawals/:id", async (req, res) => {
  try {
    const Transaction = (await import("../models/Transaction")).default;
    const withdrawal = await Withdrawal.findById(req.params.id)
      .populate({ path: "user", select: "displayName email phone role" })
      .lean();
    if (!withdrawal)
      return res.status(404).json({ message: "Withdrawal not found" });
    const transactions = await Transaction.find({ withdrawal: withdrawal._id })
      .sort({ createdAt: 1 })
      .lean();
    res.json({ withdrawal, transactions });
  } catch (err) {
    console.error("[admin/withdrawals/detail]", err);
    res.status(500).json({ message: "Failed to load withdrawal detail" });
  }
});

/**
 * POST /api/admin/withdrawals/:id/approve
 *
 * Bypass the withdrawal-hold timer + initiate Paystack transfer
 * immediately. Only valid for `pending` rows whose initial Paystack
 * call was skipped (no bankCode) or held. The user's wallet was already
 * debited at request time, so this is purely the Paystack push.
 */
router.post(
  "/withdrawals/:id/approve",
  idempotencyKey({ enforce: true }),
  async (req, res) => {
    try {
      const withdrawal = await Withdrawal.findById(req.params.id);
      if (!withdrawal)
        return res.status(404).json({ message: "Withdrawal not found" });
      if (withdrawal.status !== "pending")
        return res
          .status(409)
          .json({ message: `Only pending withdrawals can be approved (status=${withdrawal.status})` });

      const bank = withdrawal.bankAccount;
      if (!bank?.bankCode)
        return res
          .status(400)
          .json({ message: "Withdrawal bank account has no bankCode" });

      const recipient = await createTransferRecipient({
        name: bank.accountName,
        account_number: bank.accountNumber,
        bank_code: bank.bankCode,
      });
      const transfer = await initiateTransfer({
        amount: withdrawal.amount * 100,
        recipient: recipient.recipient_code,
        reason: `Gaznger ${withdrawal.role} payout (admin-approved)`,
        reference: `${withdrawal.role}-${withdrawal._id.toString().slice(-12)}-${Date.now().toString(36)}`,
      });

      withdrawal.status = "processing";
      withdrawal.paystackTransferCode = transfer.transfer_code;
      withdrawal.paystackRecipientCode = recipient.recipient_code;
      await withdrawal.save();

      await writeAudit({
        actor: req.userId!,
        action: "withdrawal.approve" as any,
        targetKind: "Withdrawal",
        target: withdrawal._id.toString(),
        after: {
          status: "processing",
          paystackTransferCode: transfer.transfer_code,
        },
        ip: req.ip,
      });

      await notifyUser(
        withdrawal.user.toString(),
        "payment",
        "Payout approved",
        `Your ₦${withdrawal.amount.toLocaleString("en-NG")} withdrawal is on the way.`
      );
      emitToUser(withdrawal.user.toString(), "withdrawal:status", {
        withdrawalId: withdrawal._id,
        status: "processing",
      });
      // P1-3: keep ops dashboards in sync with money state changes.
      emitToAdmins("withdrawal:status", {
        withdrawalId: String(withdrawal._id),
        status: "processing",
        userId: String(withdrawal.user),
      });

      res.json({ message: "Withdrawal approved", withdrawal });
    } catch (err) {
      console.error("[admin/withdrawals/approve]", err);
      res.status(502).json({
        message: "Paystack rejected the transfer. Try again or reject + re-issue.",
      });
    }
  }
);

/**
 * POST /api/admin/withdrawals/:id/reject
 * Body: { reason }
 *
 * Cancel a pending withdrawal. Reverses the wallet debit + fee debit
 * that were posted at request time. Sets status="rejected". User is
 * notified.
 */
router.post(
  "/withdrawals/:id/reject",
  idempotencyKey({ enforce: true }),
  async (req, res) => {
    try {
      const { reason } = req.body ?? {};
      if (!reason)
        return res.status(400).json({ message: "reason is required" });
      const withdrawal = await Withdrawal.findById(req.params.id);
      if (!withdrawal)
        return res.status(404).json({ message: "Withdrawal not found" });
      if (withdrawal.status !== "pending")
        return res
          .status(409)
          .json({ message: `Only pending withdrawals can be rejected (status=${withdrawal.status})` });

      const userWallet = await getOrCreateUserWallet(withdrawal.user.toString());
      const platformRevenue = await getOrCreateSystemWallet("platform-revenue");
      const cfg = await getPlatformConfig();
      const fee = cfg.withdrawalFeeNgn;

      // Reverse the payout debit.
      await postTransfer({
        from: platformRevenue,
        to: userWallet,
        amount: withdrawal.amount,
        state: "available",
        kinds: ["platform_commission_credit", "withdraw_reversal_credit"],
        description: `Reverse rejected withdrawal ${withdrawal._id}`,
        opts: {
          idempotencyKey: `withdrawal:${withdrawal._id}:reject-reverse`,
          withdrawal: withdrawal._id as any,
        },
      });
      if (fee > 0) {
        await postTransfer({
          from: platformRevenue,
          to: userWallet,
          amount: fee,
          state: "available",
          kinds: ["platform_commission_credit", "withdraw_reversal_credit"],
          description: `Reverse fee for rejected withdrawal ${withdrawal._id}`,
          opts: {
            idempotencyKey: `withdrawal:${withdrawal._id}:reject-reverse-fee`,
            withdrawal: withdrawal._id as any,
          },
        });
      }

      withdrawal.status = "rejected";
      withdrawal.note = reason;
      await withdrawal.save();

      await writeAudit({
        actor: req.userId!,
        action: "withdrawal.reject" as any,
        targetKind: "Withdrawal",
        target: withdrawal._id.toString(),
        after: { status: "rejected" },
        reason,
        ip: req.ip,
      });

      const fresh = await getOrCreateUserWallet(withdrawal.user.toString());
      emitToUser(withdrawal.user.toString(), "wallet:update", {
        available: fresh.available,
        pending: fresh.pending,
      });
      emitToUser(withdrawal.user.toString(), "withdrawal:status", {
        withdrawalId: withdrawal._id,
        status: "rejected",
      });
      emitToAdmins("withdrawal:status", {
        withdrawalId: String(withdrawal._id),
        status: "rejected",
        userId: String(withdrawal.user),
      });
      await notifyUser(
        withdrawal.user.toString(),
        "payment",
        "Payout rejected",
        `Your ₦${withdrawal.amount.toLocaleString("en-NG")} payout was reversed: ${reason}`
      );

      res.json({ message: "Withdrawal rejected", withdrawal });
    } catch (err) {
      console.error("[admin/withdrawals/reject]", err);
      res.status(500).json({ message: "Failed to reject withdrawal" });
    }
  }
);

/**
 * POST /api/admin/withdrawals/:id/retry
 *
 * Re-fire Paystack transfer on a `failed` Withdrawal. The original
 * failure path in `handleWithdrawRequest` already reversed the wallet
 * debits — admin needs to re-debit then re-initiate. We use a fresh
 * idempotency-key suffix so the original failure leg doesn't dedupe.
 */
router.post(
  "/withdrawals/:id/retry",
  idempotencyKey({ enforce: true }),
  async (req, res) => {
    try {
      const withdrawal = await Withdrawal.findById(req.params.id);
      if (!withdrawal)
        return res.status(404).json({ message: "Withdrawal not found" });
      if (withdrawal.status !== "failed")
        return res
          .status(409)
          .json({ message: `Only failed withdrawals can be retried (status=${withdrawal.status})` });

      const bank = withdrawal.bankAccount;
      if (!bank?.bankCode)
        return res
          .status(400)
          .json({ message: "Withdrawal bank account has no bankCode" });

      const userWallet = await getOrCreateUserWallet(withdrawal.user.toString());
      const cfg = await getPlatformConfig();
      const fee = cfg.withdrawalFeeNgn;
      const totalDebit = withdrawal.amount + fee;
      if (userWallet.available < totalDebit) {
        return res.status(409).json({
          message: `Insufficient wallet balance (₦${userWallet.available.toLocaleString("en-NG")}) to re-debit ₦${totalDebit.toLocaleString("en-NG")}`,
        });
      }

      const platformRevenue = await getOrCreateSystemWallet("platform-revenue");
      const retrySuffix = Date.now().toString(36);
      if (fee > 0) {
        await postTransfer({
          from: userWallet,
          to: platformRevenue,
          amount: fee,
          state: "available",
          kinds: ["withdraw_fee_debit", "platform_commission_credit"],
          description: `Retry fee for ${withdrawal._id}`,
          opts: {
            idempotencyKey: `withdrawal:${withdrawal._id}:retry-fee:${retrySuffix}`,
            withdrawal: withdrawal._id as any,
          },
        });
      }
      await postTransfer({
        from: userWallet,
        to: platformRevenue,
        amount: withdrawal.amount,
        state: "available",
        kinds: ["withdraw_debit", "platform_commission_credit"],
        description: `Retry payout to ${bank.accountNumber}`,
        opts: {
          idempotencyKey: `withdrawal:${withdrawal._id}:retry-payout:${retrySuffix}`,
          withdrawal: withdrawal._id as any,
        },
      });

      const recipient = await createTransferRecipient({
        name: bank.accountName,
        account_number: bank.accountNumber,
        bank_code: bank.bankCode,
      });
      const transfer = await initiateTransfer({
        amount: withdrawal.amount * 100,
        recipient: recipient.recipient_code,
        reason: `Gaznger ${withdrawal.role} payout (retry)`,
        reference: `${withdrawal.role}-${withdrawal._id.toString().slice(-12)}-${retrySuffix}`,
      });

      withdrawal.status = "processing";
      withdrawal.paystackTransferCode = transfer.transfer_code;
      withdrawal.paystackRecipientCode = recipient.recipient_code;
      withdrawal.note = undefined;
      await withdrawal.save();

      await writeAudit({
        actor: req.userId!,
        action: "withdrawal.retry",
        targetKind: "Withdrawal",
        target: withdrawal._id.toString(),
        after: { status: "processing" },
        ip: req.ip,
      });

      const fresh = await getOrCreateUserWallet(withdrawal.user.toString());
      emitToUser(withdrawal.user.toString(), "wallet:update", {
        available: fresh.available,
        pending: fresh.pending,
      });
      emitToUser(withdrawal.user.toString(), "withdrawal:status", {
        withdrawalId: withdrawal._id,
        status: "processing",
      });
      emitToAdmins("withdrawal:status", {
        withdrawalId: String(withdrawal._id),
        status: "processing",
        userId: String(withdrawal.user),
      });
      // SEC-P1 (audit run 5): withdrawal retry was the only flow that
      // didn't notifyUser. Pair it now.
      await notifyUser(
        withdrawal.user.toString(),
        "payment",
        "Payout retried",
        `Your ₦${withdrawal.amount.toLocaleString("en-NG")} payout has been re-attempted.`,
      ).catch(() => {});

      res.json({ message: "Withdrawal retried", withdrawal });
    } catch (err) {
      console.error("[admin/withdrawals/retry]", err);
      res.status(502).json({
        message:
          "Paystack rejected the transfer again. Reverse and re-issue manually.",
      });
    }
  }
);

export default router;
