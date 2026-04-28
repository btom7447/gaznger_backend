import Earning from "../models/Earning";
import { emitToUser } from "../socket";

const PLATFORM_FUEL_COMM = () => Number(process.env.PLATFORM_FUEL_COMMISSION) || 10;

/**
 * Create a PENDING fuel_sale earning for the vendor when an order is confirmed.
 * Platform commission is deducted up-front so the vendor always sees their net amount.
 * Earning is settled (→ "settled") only after delivery is completed.
 */
export async function createVendorPendingEarning(
  vendorId: string,
  orderId: string,
  fuelCost: number
) {
  const netAmount = Math.round(fuelCost * (1 - PLATFORM_FUEL_COMM() / 100));
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
 * Create a PENDING delivery_fee earning for the rider when they accept a delivery.
 * Amount = delivery.riderEarnings (already net of platform commission from dispatchRiders.ts).
 * Settled only after delivery is completed.
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
 * Both vendor (fuel_sale) and rider (delivery_fee) earnings move to "settled".
 */
export async function settleOrderEarnings(orderId: string) {
  const updated = await Earning.updateMany(
    { order: orderId, status: "pending" },
    { status: "settled", settledAt: new Date() }
  );

  // Notify each affected user via socket
  const settled = await Earning.find({ order: orderId, status: "settled" }).lean();
  for (const e of settled) {
    emitToUser(e.user.toString(), "earnings:settled", {
      orderId,
      amount: e.amount,
      type: e.type,
    });
  }

  return updated;
}
