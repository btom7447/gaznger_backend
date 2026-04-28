/**
 * Order Watchdog — cancels "confirmed" orders that have had no rider assigned
 * for more than 5 minutes. Runs every 60 seconds.
 */
import Order from "../models/Order";
import { notifyUser } from "../utils/notify";
import { emitToUser } from "../socket";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;

async function cancelStaleOrders() {
  try {
    const cutoff = new Date(Date.now() - FIVE_MINUTES_MS);

    // Orders that are "confirmed" but never moved to "assigned" — use updatedAt as
    // a proxy for when they were last moved to confirmed status
    const stale = await Order.find({
      status: "confirmed",
      updatedAt: { $lte: cutoff },
    }).lean();

    for (const order of stale) {
      await Order.findByIdAndUpdate(order._id, {
        status: "cancelled",
        cancellationReason: "No rider available nearby. Please try again.",
      });

      const userId = order.user.toString();
      await notifyUser(
        userId,
        "cancelled",
        "Order Cancelled",
        "No rider was available nearby. Your order has been cancelled — please try again."
      );
      emitToUser(userId, "order:update", { orderId: order._id, status: "cancelled" });

      console.log(`[Watchdog] Cancelled stale confirmed order ${order._id}`);
    }
  } catch (err: any) {
    console.error("[Watchdog] Error checking stale orders:", err.message);
  }
}

export function startOrderWatchdog() {
  // Run once immediately on startup (catches orders from a previous server instance)
  cancelStaleOrders();
  setInterval(cancelStaleOrders, CHECK_INTERVAL_MS);
  console.log("[Watchdog] Order watchdog started (5-min no-rider cancellation)");
}
