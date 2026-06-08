import Order from "../models/Order";
import Delivery from "../models/Delivery";
import RiderProfile from "../models/RiderProfile";
import User from "../models/User";
import { haversineDistance, calcDeliveryFee } from "../utils/haversine";
import { notifyUser } from "../utils/notify";
import { sendPushNotification } from "../utils/push";
import { emitToUser } from "../socket";

const RIDERS_PER_BROADCAST = 3;

/**
 * Broadcast-accept rider dispatch.
 *
 * Runs every minute via cron. For each confirmed order without an assigned rider:
 *  1. If a previous dispatch window has timed out:
 *     - If max rounds reached → cancel the order.
 *     - Otherwise → delete stale pending Delivery records and queue a fresh broadcast.
 *  2. Find nearest available riders within radius → create Delivery records → set expiry.
 */
export async function dispatchRiders(): Promise<void> {
  // P1-MF-7 (audit run 4): respect the dispatchEnabled kill switch.
  // Pre-fix this flag was admin-toggleable but the cron ignored it —
  // admin could intend "pause new dispatch while we investigate"
  // and orders would keep getting broadcast. Confirmed orders stay
  // confirmed; the next tick after the flag flips back to true
  // resumes normally.
  const { getCommissionRate, getPlatformConfig } = await import(
    "../utils/platformConfig"
  );
  const cfg = await getPlatformConfig();
  if ((cfg as any).dispatchEnabled === false) {
    return;
  }

  const maxRounds = Number(process.env.RIDER_DISPATCH_MAX_ROUNDS) || 3;
  const radiusKm = Number(process.env.RIDER_DISPATCH_RADIUS_KM) || 10;
  const timeoutSec = Number(process.env.RIDER_DISPATCH_TIMEOUT_SECONDS) || 180;
  // Rider commission now sourced from PlatformConfig — env stays as a
  // pure fallback for first boot before the singleton exists.
  const platformDeliveryRate = await getCommissionRate("rider"); // 0.05 default
  const platformDeliveryComm = platformDeliveryRate * 100;

  const now = new Date();

  // ── Step 1: Handle timed-out dispatches ──────────────────────────────────
  const timedOutOrders = await Order.find({
    status: "confirmed",
    riderId: null,
    dispatchExpiresAt: { $lte: now },
  }).lean();

  for (const order of timedOutOrders) {
    if (order.dispatchAttempt >= maxRounds) {
      // No rider found after all rounds — cancel the order
      await Order.findByIdAndUpdate(order._id, {
        status: "cancelled",
        cancellationReason:
          "No rider available. Please try placing your order again.",
      });
      await Delivery.deleteMany({ order: order._id, status: "pending" });
      const customerId = order.user.toString();
      emitToUser(customerId, "order:update", {
        orderId: String(order._id),
        status: "cancelled",
      });
      notifyUser(
        customerId,
        "cancelled",
        "Order Cancelled",
        "We couldn't find a rider nearby. Your order has been cancelled — please try again.",
      ).catch(() => {});
    } else {
      // Clear stale pending Delivery records so this order gets re-dispatched below
      await Delivery.deleteMany({ order: order._id, status: "pending" });
      await Order.findByIdAndUpdate(order._id, { dispatchExpiresAt: null });
    }
  }

  // ── Step 2: Dispatch confirmed orders that don't yet have an expiry set ──
  // `deliveryAddress` is populated so the v7 RiderDispatchModal can show
  // the customer's city (e.g. "Ikate · Lekki") instead of the "Nearby
  // area" fallback (brief §4.1 — `customerArea` field).
  const ordersToDispatch = await Order.find({
    status: "confirmed",
    riderId: null,
    dispatchExpiresAt: null,
    dispatchAttempt: { $lt: maxRounds },
  })
    .populate("station")
    .populate({ path: "deliveryAddress", select: "city state street" })
    .populate({ path: "fuel", select: "name unit" })
    .lean();

  for (const order of ordersToDispatch) {
    const station = order.station as any;
    const stationCoords = station?.location;

    if (!stationCoords?.lat || !stationCoords?.lng) continue;

    // Find all available + verified riders that have reported a
    // location. Unverified riders are excluded from broadcast — the
    // brief's hard rule "verification gates every CTA" means an
    // unverified rider can't be matched to a delivery even if their
    // local availability flag is on (server is the source of truth).
    const availableRiders = await RiderProfile.find({
      isAvailable: true,
      $or: [
        { verificationStatus: "verified" },
        { isVerified: true },
      ],
    }).lean();

    const ridersWithLocation = availableRiders.filter(
      (r) => r.currentLocation?.lat && r.currentLocation?.lng,
    );

    let candidates;

    if (ridersWithLocation.length > 0) {
      candidates = ridersWithLocation
        .map((r) => ({
          ...r,
          distanceKm: haversineDistance(
            { lat: stationCoords.lat, lng: stationCoords.lng },
            { lat: r.currentLocation!.lat, lng: r.currentLocation!.lng },
          ),
        }))
        .filter((r) => r.distanceKm <= radiusKm)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, RIDERS_PER_BROADCAST);
    } else {
      // No riders have reported location yet — dispatch to all available riders
      // (handles dev/testing scenarios and first-time rider logins)
      candidates = availableRiders
        .slice(0, RIDERS_PER_BROADCAST)
        .map((r) => ({ ...r, distanceKm: 0 }));
    }

    const expiry = new Date(now.getTime() + timeoutSec * 1000);

    if (candidates.length === 0) {
      // No riders in range — still consume one attempt and wait for the next window
      await Order.findByIdAndUpdate(order._id, {
        $inc: { dispatchAttempt: 1 },
        dispatchExpiresAt: expiry,
      });
      continue;
    }

    // Pre-compute earnings split
    const riderEarnings = Math.round(
      order.deliveryFee * (1 - platformDeliveryComm / 100),
    );
    const platformEarnings = order.deliveryFee - riderEarnings;

    let dispatchedCount = 0;
    for (const candidate of candidates) {
      // Skip riders already handling another delivery
      const hasActive = await Delivery.findOne({
        rider: candidate.user,
        status: { $in: ["pending", "accepted", "picked_up"] },
      }).lean();
      if (hasActive) continue;

      const delivery = await Delivery.create({
        order: order._id,
        rider: candidate.user,
        station: order.station,
        status: "pending",
        riderEarnings,
        platformEarnings,
      });

      // Instant socket ping first, then background push notification.
      //
      // Broadcast offers fire `dispatch:offer` exclusively — the v7
      // RiderDispatchModal listens for this name and the payload
      // carries `dispatchExpiresAt` so the rider client can drive the
      // 15s countdown ring without a follow-up GET.
      //
      // Manual vendor assigns (vendor.ts /assign and /reassign) emit
      // `delivery:dispatch` directly to the rider — they don't go
      // through this job. The v7 Queue disambiguates the two events:
      // `dispatch:offer` opens the modal; `delivery:dispatch` opens
      // the active-delivery card with an "Assigned by vendor" pill
      // (brief §5B).
      const riderId = candidate.user.toString();
      const deliveryAddress = (order as any).deliveryAddress;
      const customerArea = deliveryAddress
        ? [deliveryAddress.city, deliveryAddress.state]
            .filter(Boolean)
            .join(" · ")
        : null;
      const fuel = (order as any).fuel;
      const offerPayload = {
        deliveryId: delivery._id,
        orderId: order._id,
        stationId: order.station,
        stationName: station?.name,
        stationAddress: station?.address,
        fuelName: fuel?.name,
        quantity: order.quantity,
        unit: fuel?.unit,
        riderEarnings,
        dispatchExpiresAt: expiry,
        customerArea,
      };
      emitToUser(riderId, "dispatch:offer", offerPayload);
      // P2 (audit run 4): a dispatch offer is ephemeral — it lives for
      // ~15s and then either gets accepted, expires, or another rider
      // takes it. Persisting a Notification row meant the rider inbox
      // filled with stale "A new delivery near you is available" lines
      // long after the offer was gone. Notification has no expiresAt
      // field to TTL them out, so drop the persistent write entirely.
      // Keep the socket emit (above) for the in-app modal and a
      // best-effort push so the rider can act when the app is closed.
      (async () => {
        try {
          const u = await User.findById(riderId).select("deviceTokens").lean();
          const tokens: string[] = (u as any)?.deviceTokens ?? [];
          if (tokens.length) {
            await sendPushNotification(
              tokens,
              "New Delivery Request",
              "A new delivery near you is available. Open the app to accept.",
            );
          }
        } catch {
          // Push failure must never break dispatch
        }
      })();

      dispatchedCount++;
    }

    await Order.findByIdAndUpdate(order._id, {
      $inc: { dispatchAttempt: 1 },
      dispatchExpiresAt: expiry,
    });
  }
}
