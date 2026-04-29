import mongoose from "mongoose";
import Earning from "../models/Earning";
import Order from "../models/Order";
import Dispute from "../models/Dispute";
import { emitToUser } from "../socket";
import {
  getOrCreateUserWallet,
  getOrCreateSystemWallet,
  postTransfer,
  postSingle,
} from "./wallet";
import { getCommissionRate } from "./platformConfig";

/**
 * Earnings + escrow release helpers.
 *
 * Two layers run side-by-side:
 *   1. Legacy `Earning` rows (still consumed by the existing vendor + rider
 *      earnings screens). These are pure UI ledger — net amounts only.
 *   2. The new `Wallet` + `Transaction` ledger (the source of truth for
 *      money). Settlement moves money out of escrow.pending into the
 *      vendor + rider + platform-revenue available buckets, applying
 *      commission as configured by PlatformConfig.
 *
 * Invariant: every settled `Earning` has matching Transaction rows
 * referencing the same order. The two layers must agree on amount.
 */

/**
 * Create a PENDING fuel_sale earning for the vendor when an order is
 * confirmed. The `Earning.amount` is the vendor's NET take after
 * commission. No wallet movement happens yet — the funds are held in
 * escrow.pending. Money flows on `settleOrderEarnings` after delivery.
 */
export async function createVendorPendingEarning(
  vendorId: string,
  orderId: string,
  fuelCost: number
) {
  const rate = await getCommissionRate("vendor", vendorId);
  const netAmount = Math.round(fuelCost * (1 - rate));
  const earning = await Earning.create({
    user: vendorId,
    role: "vendor",
    order: orderId,
    amount: netAmount,
    type: "fuel_sale",
    status: "pending",
  });
  emitToUser(vendorId, "earnings:new", { amount: netAmount, orderId, status: "pending" });
  return earning;
}

/**
 * Create a PENDING delivery_fee earning for the rider when they accept a
 * delivery. `riderEarnings` should ALREADY be net of commission — the
 * caller (dispatchRiders) computed it from `delivery.deliveryFee × (1 - rate)`.
 */
export async function createRiderPendingEarning(
  riderId: string,
  orderId: string,
  deliveryId: string,
  riderEarnings: number
) {
  const earning = await Earning.create({
    user: riderId,
    role: "rider",
    order: orderId,
    delivery: deliveryId,
    amount: riderEarnings,
    type: "delivery_fee",
    status: "pending",
  });
  emitToUser(riderId, "earnings:new", { amount: riderEarnings, orderId, status: "pending" });
  return earning;
}

/**
 * Settle all pending earnings for an order on delivery completion.
 *
 * Sequence:
 *   1. If an open dispute exists for this order, abort — admin must
 *      resolve first (resolution path calls this same function).
 *   2. Flip Earning rows pending → settled (legacy UI).
 *   3. Move escrow.pending → escrow.available for the entire order
 *      total (a "release" bucket-shift, kept as one row pair for audit).
 *   4. Split escrow.available out:
 *        vendor.available           ← fuelCost × (1 - vendorCommission)
 *        rider.available            ← deliveryFee × (1 - riderCommission)
 *        platform-revenue.available ← commission * (fuelCost + deliveryFee)
 *
 * Idempotency: keyed on `order:<id>:settle` so a retry / dual-trigger
 * (rider mark + customer confirm) doesn't double-pay.
 */
export async function settleOrderEarnings(orderId: string) {
  const order = await Order.findById(orderId);
  if (!order) return null;

  // Block settlement if there's an open dispute.
  const openDispute = await Dispute.findOne({ order: orderId, status: "open" });
  if (openDispute) {
    return { blocked: "dispute_open", disputeId: openDispute._id };
  }

  // 1. Flip Earnings.
  await Earning.updateMany(
    { order: orderId, status: "pending" },
    { status: "settled", settledAt: new Date() }
  );

  // 2. Compute commission split from config + order amounts.
  const vendorCommission = await getCommissionRate("vendor");
  const riderCommission = await getCommissionRate("rider");
  const fuelCost = order.fuelCost;
  const deliveryFee = order.deliveryFee;
  const vendorTake = Math.round(fuelCost * (1 - vendorCommission));
  const riderTake = Math.round(deliveryFee * (1 - riderCommission));
  const platformTake = (fuelCost + deliveryFee) - vendorTake - riderTake;

  const escrow = await getOrCreateSystemWallet("platform-escrow");
  const platformRevenue = await getOrCreateSystemWallet("platform-revenue");

  // 3. Release: shift escrow.pending → escrow.available for the full
  //    order total. Two-leg pair under one groupId for audit.
  const groupBase = `order:${orderId}:settle`;
  const total = fuelCost + deliveryFee;

  await postSingle({
    wallet: escrow,
    amount: -total,
    state: "pending",
    kind: "escrow_release_debit",
    opts: {
      idempotencyKey: `${groupBase}:release-out`,
      groupId: groupBase,
      description: `Release escrow for order ${orderId}`,
      order: order._id as any,
    },
  });
  await postSingle({
    wallet: escrow,
    amount: total,
    state: "available",
    kind: "escrow_release_debit",
    opts: {
      idempotencyKey: `${groupBase}:release-in`,
      groupId: groupBase,
      description: `Release escrow for order ${orderId}`,
      order: order._id as any,
    },
  });

  // 4. Split out to vendor + rider + platform-revenue. Each leg is its
  //    own debit/credit pair (so per-recipient idempotency).
  const vendorWallet = order.station
    ? await (async () => {
        // Resolve vendor user from the station ref.
        const stationDoc = await mongoose
          .model("GasStation")
          .findById(order.station)
          .select("vendorId")
          .lean<{ vendorId?: mongoose.Types.ObjectId }>();
        if (!stationDoc?.vendorId) return null;
        return getOrCreateUserWallet(stationDoc.vendorId);
      })()
    : null;

  if (vendorWallet && vendorTake > 0) {
    await postTransfer({
      from: escrow,
      to: vendorWallet,
      amount: vendorTake,
      state: "available",
      kinds: ["escrow_release_debit", "vendor_earning_credit"],
      description: `Order ${orderId} vendor settlement`,
      opts: {
        idempotencyKey: `${groupBase}:vendor`,
        order: order._id as any,
        meta: { fuelCost, vendorCommission },
      },
    });
    emitToUser((vendorWallet.user as mongoose.Types.ObjectId).toString(), "earnings:settled", {
      orderId,
      amount: vendorTake,
      type: "fuel_sale",
    });
    const fresh = await getOrCreateUserWallet(vendorWallet.user as mongoose.Types.ObjectId);
    emitToUser((vendorWallet.user as mongoose.Types.ObjectId).toString(), "wallet:update", {
      available: fresh.available,
      pending: fresh.pending,
    });
  }

  if (order.riderId && riderTake > 0) {
    const riderWallet = await getOrCreateUserWallet(order.riderId);
    await postTransfer({
      from: escrow,
      to: riderWallet,
      amount: riderTake,
      state: "available",
      kinds: ["escrow_release_debit", "rider_earning_credit"],
      description: `Order ${orderId} rider settlement`,
      opts: {
        idempotencyKey: `${groupBase}:rider`,
        order: order._id as any,
        meta: { deliveryFee, riderCommission },
      },
    });
    emitToUser(order.riderId.toString(), "earnings:settled", {
      orderId,
      amount: riderTake,
      type: "delivery_fee",
    });
    const fresh = await getOrCreateUserWallet(order.riderId);
    emitToUser(order.riderId.toString(), "wallet:update", {
      available: fresh.available,
      pending: fresh.pending,
    });
  }

  if (platformTake > 0) {
    await postTransfer({
      from: escrow,
      to: platformRevenue,
      amount: platformTake,
      state: "available",
      kinds: ["escrow_release_debit", "platform_commission_credit"],
      description: `Order ${orderId} platform commission`,
      opts: {
        idempotencyKey: `${groupBase}:platform`,
        order: order._id as any,
        meta: { fuelCost, deliveryFee, vendorCommission, riderCommission },
      },
    });
  }

  return { settled: true, vendorTake, riderTake, platformTake };
}

/**
 * Refund an order's escrow back to the customer (or external card).
 * Currently only escrow → customer wallet. Card-reversal path lives in
 * the admin refund endpoint, which calls Paystack /refund and then
 * marks `Order.paymentStatus = "refunded"`.
 *
 * Fails silently if the order has already been settled — by then the
 * funds are out of escrow and admin must claw back from the recipients
 * (out of scope for v1; flag for ops).
 */
export async function refundOrderToWallet(args: {
  orderId: string;
  amount: number;
  reason?: string;
  adminId?: string;
}) {
  const { orderId, amount, reason, adminId } = args;
  const order = await Order.findById(orderId);
  if (!order) throw new Error("Order not found");

  const escrow = await getOrCreateSystemWallet("platform-escrow");
  const customerWallet = await getOrCreateUserWallet(order.user);

  await postTransfer({
    from: escrow,
    to: customerWallet,
    amount,
    state: "available",
    kinds: ["escrow_release_debit", "refund_credit"],
    description: reason ? `Refund: ${reason}` : "Order refund",
    opts: {
      idempotencyKey: `order:${orderId}:refund-wallet:${amount}`,
      order: order._id as any,
      meta: { adminId },
    },
  });

  const fresh = await getOrCreateUserWallet(order.user);
  emitToUser(order.user.toString(), "wallet:update", {
    available: fresh.available,
    pending: fresh.pending,
  });

  return { refunded: amount };
}
