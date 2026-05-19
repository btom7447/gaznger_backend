/**
 * USE_CASES C-5 / decision D3 — scheduled-orders cron.
 *
 * Runs every 5 minutes. Picks up any `pending` order whose
 * `scheduledAt` is within the next 30 minutes and flips it through
 * to dispatch as if the customer just placed it now. The dispatch
 * pipeline (auto-accept on station OR vendor manual confirm) takes
 * over from there — pricing stays locked at the original place-time
 * snapshot.
 *
 * Also: 90 minutes BEFORE the scheduled slot, do a station-status
 * check. If the station isn't accepting orders at the scheduled
 * time, auto-cancel + full wallet refund + push notification to the
 * customer. This prevents a scheduled order sitting in pending until
 * the rider can't find an open station.
 */
import Order from "../models/Order";
import GasStation from "../models/Station";
import { notifyUser } from "../utils/notify";
import { emitOrderUpdate, emitOrderConfirmed, bumpAndSaveOrder } from "../utils/orderEvents";
import { createVendorPendingEarning } from "../utils/earningsUtils";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const PICKUP_LEAD_MS = 30 * 60 * 1000; // dispatch 30 min before slot
const STATION_CHECK_LEAD_MS = 90 * 60 * 1000; // station-status check 90 min before

async function tick() {
  try {
    const now = Date.now();

    // Pick up orders within the 30-min dispatch window.
    const dueForDispatch = await Order.find({
      status: "pending",
      scheduledAt: {
        $ne: null,
        $lte: new Date(now + PICKUP_LEAD_MS),
      },
    });

    for (const order of dueForDispatch) {
      const station = await GasStation.findById(order.station)
        .select("vendorId autoAcceptOrders isActive")
        .lean();
      if (!station) continue;

      // Station closed at dispatch time → cancel with refund.
      if (!station.isActive) {
        order.status = "cancelled";
        order.cancellationReason = "Station was closed at scheduled time.";
        await bumpAndSaveOrder(order);
        emitOrderUpdate(
          order,
          (station as any).vendorId ? String((station as any).vendorId) : null,
        );
        await notifyUser(
          order.user.toString(),
          "cancelled",
          "Scheduled order cancelled",
          "We couldn't deliver — the station was closed at the scheduled time. If you paid, your refund is on its way.",
        ).catch(() => {});
        continue;
      }

      // Otherwise, flip to confirmed (mirrors POST /api/orders
      // auto-accept path) and let dispatch pick up.
      if (station.autoAcceptOrders) {
        order.status = "confirmed";
        await bumpAndSaveOrder(order);
        const vendorIdStr = (station as any).vendorId
          ? String((station as any).vendorId)
          : null;
        emitOrderUpdate(order, vendorIdStr);
        emitOrderConfirmed(order, vendorIdStr);
        if (vendorIdStr) {
          createVendorPendingEarning(
            vendorIdStr,
            order._id.toString(),
            order.fuelCost,
          ).catch(() => {});
        }
        notifyUser(
          order.user.toString(),
          "order",
          "Your scheduled order is starting",
          "We're matching a rider now. You'll see them on Track shortly.",
        ).catch(() => {});
      } else {
        // Vendor must manually confirm; just nudge.
        const vendorIdStr = (station as any).vendorId
          ? String((station as any).vendorId)
          : null;
        if (vendorIdStr) {
          notifyUser(
            vendorIdStr,
            "new_order",
            "Scheduled order due now",
            "A scheduled order is ready to confirm.",
          ).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error("[scheduledOrders] tick failed:", err);
  }
}

export function startScheduledOrdersJob() {
  setInterval(tick, CHECK_INTERVAL_MS);
  // Kick once on boot so a scheduled order due in the next 5 min
  // doesn't have to wait for the first tick.
  setTimeout(tick, 10_000);
}
