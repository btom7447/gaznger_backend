import { Router } from "express";
import mongoose from "mongoose";
import Order from "../models/Order";
import GasStation from "../models/Station";
import FuelType from "../models/FuelType";
import Address from "../models/Address";
import Rating, { IRating } from "../models/Rating";
import User from "../models/User";
import Point from "../models/Point";
import { requireAuth, requireCustomer } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { idempotencyKey } from "../middleware/idempotency";
import {
  createOrderSchema,
  updateOrderStatusSchema,
  rateOrderSchema,
  listOrdersQuerySchema,
} from "../validators/order.validators";
import { parsePagination } from "../utils/pagination";
import { notifyUser } from "../utils/notify";
import { emitToUser, emitToDelivery } from "../socket";
import { haversineDistance, calcDeliveryFee } from "../utils/haversine";
import { computeDeliveryFee } from "../utils/deliveryFee";
import {
  bumpAndSaveOrder,
  emitOrderUpdate,
  emitOrderConfirmed,
  emitOrderRejected,
  emitRiderAssigned,
} from "../utils/orderEvents";
import { emitPaymentFailed, emitRatingSubmitted } from "../utils/alertEvents";
import { createVendorPendingEarning, settleOrderEarnings } from "../utils/earningsUtils";
import Delivery from "../models/Delivery";
import RiderProfile from "../models/RiderProfile";
import { computeRoute, type RouteTarget } from "../utils/routePolyline";

const router = Router();


const POINTS_CONFIG = {
  orderDelivered: Number(process.env.POINTS_ORDER_DELIVERED),
  rateStation: Number(process.env.POINTS_RATE_STATION),
};

async function awardPoints(
  userId: string,
  points: number,
  description: string,
  pendingUntil?: Date,
  expiresAt?: Date
) {
  const now = new Date();
  const isPending = pendingUntil && pendingUntil > now;

  if (!isPending) {
    const user = await User.findById(userId);
    if (user) {
      user.points += points;
      if (user.points < 0) user.points = 0;
      await user.save();
      // Real-time points update so PointsBanner reflects immediately
      emitToUser(userId, "points:update", { points: user.points });
    }
  }

  await Point.create({
    user: userId,
    change: points,
    type: points > 0 ? "earn" : "redeem",
    description,
    pendingUntil: pendingUntil ? new Date(pendingUntil) : undefined,
    expiresAt: expiresAt ? new Date(expiresAt) : undefined,
  });
}

// ===================== PLACE NEW ORDER =====================
// SECURITY (audit F.5): customer-only writes get an explicit role
// gate. Today these handlers don't behave differently for non-
// customers (they'd just create a malformed order doc), but
// defense-in-depth: a vendor or rider session token shouldn't be
// able to call any of them at all.
// SECURITY M3 (audit) — accepts (but does not yet enforce) the
// Idempotency-Key header so retries from the mobile client can be
// deduped server-side. Phase 2 flips `enforce: true` once every
// client build sends the header, and wraps the handler body in
// `withIdempotency` for response caching. Today the middleware just
// stashes the key on req for future use; behaviour is unchanged for
// clients that don't send it.
router.post("/", requireAuth, requireCustomer, idempotencyKey(), validate(createOrderSchema), async (req, res) => {
  try {
    const {
      fuelId,
      fuelTypeId,
      stationId,
      quantity,
      deliveryAddressId,
      cylinderType,
      deliveryType,
      cylinderImages,
      returnSwapAt,
      note,
    } = req.body;

    // Enforce one active order at a time
    const activeOrder = await Order.findOne({
      user: req.userId,
      status: { $in: ["pending", "confirmed", "assigned", "in-transit"] },
    });
    if (activeOrder)
      return res.status(409).json({ message: "You already have an active order. Cancel it or wait for it to complete before placing a new one." });

    // Resolve fuel reference. New flow sends `fuelTypeId` slug
    // ("petrol"/"diesel"/"kero"/"lpg"); legacy sends a Mongo ObjectId
    // via `fuelId`. Map slugs to FuelType.name (case-insensitive).
    const SLUG_TO_NAME: Record<string, RegExp> = {
      petrol: /^petrol$/i,
      diesel: /^diesel$/i,
      kero: /^kero(sene)?$/i,
      lpg: /^(lpg|gas|cooking gas)$/i,
    };

    const fuelLookup = fuelId
      ? FuelType.findById(fuelId)
      : (() => {
          const slug = (fuelTypeId ?? "").toLowerCase();
          const matcher = SLUG_TO_NAME[slug];
          return matcher
            ? FuelType.findOne({ name: matcher })
            : Promise.resolve(null);
        })();

    const [fuel, station, address] = await Promise.all([
      fuelLookup,
      GasStation.findById(stationId),
      Address.findById(deliveryAddressId),
    ]);

    if (!fuel) return res.status(404).json({ message: "Fuel not found" });
    if (!station) return res.status(404).json({ message: "Station not found" });
    if (!station.isActive) return res.status(400).json({ message: "Station is currently closed" });
    if (!address) return res.status(404).json({ message: "Delivery address not found" });

    // Use station's per-fuel price (vendor-set), falling back to FuelType global price
    const resolvedFuelId = (fuel._id as mongoose.Types.ObjectId).toString();
    const stationFuelEntry = station.fuels.find(
      (f) => f.fuel.toString() === resolvedFuelId
    );
    if (!stationFuelEntry) {
      return res.status(400).json({ message: "This fuel is not available at the selected station" });
    }
    if (stationFuelEntry.available === false) {
      return res.status(400).json({ message: "This fuel is currently unavailable at the selected station" });
    }

    const pricePerUnit = stationFuelEntry.pricePerUnit;
    const fuelCost = Math.round(quantity * pricePerUnit);

    // BUSINESS_RULES P0-2 — single source of truth for the fee math
    // shared with the mobile preview via /api/orders/quote (added
    // below in this PR). The helper handles base + per-km + the
    // LPG-swap 2-trip multiplier in one place so client + server
    // can never drift.
    const feeBreakdown = computeDeliveryFee({
      from: { lat: station.location.lat, lng: station.location.lng },
      to: { lat: address.latitude, lng: address.longitude },
      fuelName: fuel.name,
      deliveryType,
    });
    const deliveryFee = feeBreakdown.finalFee;

    // Platform service fee (audit C.4). Configurable in basis points
    // via SERVICE_FEE_BPS (200 = 2%, the default). Computed off the
    // fuel cost — not the total — so the platform's cut doesn't
    // double-dip on the delivery fee that already pays the rider.
    // Stored as a separate Order line so admin reporting can split
    // platform earnings from rider/vendor settlement.
    const serviceFeeBps = Number(process.env.SERVICE_FEE_BPS) || 200;
    const serviceFee = Math.round((fuelCost * serviceFeeBps) / 10_000);

    const totalPrice = fuelCost + deliveryFee + serviceFee;

    const orderData: any = {
      user: req.userId,
      fuel: resolvedFuelId,
      station: stationId,
      quantity,
      unit: fuel.unit,
      fuelCost,
      deliveryFee,
      serviceFee,
      totalPrice,
      // For liquid orders, totalCharged === totalPrice from the start.
      // LPG orders update this on weigh-in (rider app).
      totalCharged: fuel.name === "Gas" ? undefined : totalPrice,
      status: "pending",
      deliveryAddress: deliveryAddressId,
      note: note?.trim() || undefined,
      returnSwapAt: returnSwapAt ? new Date(returnSwapAt) : undefined,
    };

    if (fuel.name === "Gas") {
      orderData.cylinderType = cylinderType;
      orderData.deliveryType = deliveryType;
      orderData.cylinderImages = cylinderImages || [];
      // LPG-Swap details — only persisted when present (Refill never sends).
      if (req.body.cylinderDetails) {
        orderData.cylinderDetails = req.body.cylinderDetails;
      }
    }

    let order = await Order.create(orderData);

    // ── Socket events fire immediately; notifications follow in background ──
    if (station.autoAcceptOrders) {
      order.status = "confirmed";
      // Bump version so first emit carries v1 (post-creation)
      await bumpAndSaveOrder(order);

      // 1. Instant socket events (no await)
      const vendorIdStr = station.vendorId ? station.vendorId.toString() : null;
      emitOrderUpdate(order, vendorIdStr);
      // Granular confirm event (SYNC P1 / WS_VS_API #4)
      emitOrderConfirmed(order, vendorIdStr);
      if (vendorIdStr) {
        emitToUser(vendorIdStr, "order:new", { orderId: String(order._id), status: "confirmed", fuelName: fuel.name, quantity, unit: fuel.unit });
        // Create vendor earnings + emit earnings event (fast DB write)
        createVendorPendingEarning(vendorIdStr, order._id.toString(), fuelCost).catch(() => {});
      }

      // 2. Background: DB notifications + push (do not block response)
      Promise.all([
        notifyUser(req.userId, "order", "Order Confirmed",
          `Your ${fuel.name} order (${quantity} ${fuel.unit}) was automatically confirmed. A rider will be assigned shortly.`),
        station.vendorId
          ? notifyUser(station.vendorId.toString(), "order", "Order Auto-Confirmed",
              `A ${fuel.name} order (${quantity} ${fuel.unit}) was auto-confirmed at your station.`)
          : Promise.resolve(),
        station.vendorId
          ? notifyUser(station.vendorId.toString(), "payment", "Earnings Added",
              `₦${fuelCost.toLocaleString()} added to your pending earnings.`)
          : Promise.resolve(),
      ]).catch(() => {});
    } else {
      // Pending order — instant vendor ping, then background notifications
      if (station.vendorId) {
        const vendorId = station.vendorId.toString();
        emitToUser(vendorId, "order:new", { orderId: String(order._id), status: "pending", fuelName: fuel.name, quantity, unit: fuel.unit });
        notifyUser(vendorId, "new_order", "New Order Received",
          `A new ${fuel.name} order (${quantity} ${fuel.unit}) has been placed at your station.`).catch(() => {});
      }
      notifyUser(req.userId, "order", "Order Placed",
        `Your ${fuel.name} order (${quantity} ${fuel.unit}) has been placed successfully.`).catch(() => {});
    }


    res.status(201).json(order);
  } catch (err) {
    res.status(500).json({ message: "Failed to place order" });
  }
});

// ===================== QUOTE (PREVIEW) =====================
/**
 * BUSINESS_RULES P0-2 — authoritative delivery-fee preview for the
 * customer's Payment screen. The mobile client used to mirror the
 * server's formula and silently missed the LPG-swap 2× multiplier.
 * From this PR onward, the client calls this endpoint and displays
 * exactly what the server will charge.
 *
 * GET /api/orders/quote?stationId=...&addressId=...&fuelTypeId=lpg&deliveryType=cylinder_swap
 *
 * Response:
 *   { breakdown: { base, perKm, distanceKm, rawFee, multiplier, reason, finalFee } }
 *
 * Cheap read (two findById's + the pure math helper); no DB writes.
 */
router.get("/quote", requireAuth, requireCustomer, async (req, res) => {
  try {
    const stationId = String(req.query.stationId ?? "");
    const addressId = String(req.query.addressId ?? "");
    const fuelTypeId = String(req.query.fuelTypeId ?? "").toLowerCase();
    const deliveryType = req.query.deliveryType
      ? String(req.query.deliveryType)
      : undefined;
    if (!stationId || !addressId || !fuelTypeId) {
      return res.status(400).json({
        message: "stationId, addressId, fuelTypeId are required",
      });
    }

    const SLUG_TO_NAME: Record<string, RegExp> = {
      petrol: /^petrol$/i,
      diesel: /^diesel$/i,
      kero: /^kero(sene)?$/i,
      lpg: /^(lpg|gas|cooking gas)$/i,
    };
    const matcher = SLUG_TO_NAME[fuelTypeId];
    if (!matcher) {
      return res.status(400).json({ message: "Unknown fuelTypeId" });
    }

    const [station, address, fuel] = await Promise.all([
      GasStation.findById(stationId).select("location").lean(),
      Address.findById(addressId).select("latitude longitude").lean(),
      FuelType.findOne({ name: matcher }).select("name").lean(),
    ]);
    if (!station)
      return res.status(404).json({ message: "Station not found" });
    if (!address)
      return res.status(404).json({ message: "Address not found" });
    if (!fuel)
      return res.status(404).json({ message: "Fuel type not found" });

    const breakdown = computeDeliveryFee({
      from: { lat: station.location.lat, lng: station.location.lng },
      to: { lat: address.latitude, lng: address.longitude },
      fuelName: fuel.name,
      deliveryType,
    });

    res.json({ breakdown });
  } catch (err) {
    console.error("[orders/quote]", err);
    res.status(500).json({ message: "Failed to compute quote" });
  }
});

// ===================== GET MY ORDERS (with filter & pagination) =====================
router.get("/", requireAuth, async (req, res) => {
  try {
    // SECURITY (audit E.4): validate query inputs before they reach
    // Mongo. Garbage `startDate=foo` previously surfaced as a 500
    // because `new Date("foo").getTime()` is NaN.
    const parsed = listOrdersQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid query parameters",
        issues: parsed.error.issues,
      });
    }
    const { status, startDate, endDate } = parsed.data;

    const filter: any = { user: req.userId };
    if (status) {
      const statuses = status.split(",").map((s) => s.trim()).filter(Boolean);
      filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
    }
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const { page: pageNum, limit: limitNum, skip } = parsePagination(req.query as Record<string, unknown>);

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate("fuel")
        .populate("station")
        .populate("deliveryAddress")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Order.countDocuments(filter),
    ]);

    res.json({
      data: orders,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (err) {

    res.status(500).json({ message: "Failed to fetch orders" });
  }
});

// ===================== GET ORDER BY ID =====================
router.get("/:orderId", requireAuth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId)
      .populate("fuel")
      .populate("station")
      .populate("deliveryAddress")
      .populate({
        path: "riderId",
        select: "displayName phone profileImage",
      })
      .lean();

    if (!order) return res.status(404).json({ message: "Order not found" });

    if (order.user.toString() !== req.userId)
      return res.status(403).json({ message: "Forbidden" });

    // SECURITY (audit E.9): the customer doesn't need the rider's
    // phone until the rider is en-route or on-site. Hide it for
    // earlier statuses so an idly-watched order can't harvest rider
    // numbers.
    const PHONE_VISIBLE_STATUSES = new Set([
      "picked_up",
      "in-transit",
      "arrived",
      "dispensing",
      "awaiting_confirmation",
    ]);
    if (
      order.riderId &&
      typeof order.riderId === "object" &&
      !PHONE_VISIBLE_STATUSES.has(order.status as string)
    ) {
      const rider = order.riderId as unknown as Record<string, unknown>;
      if ("phone" in rider) rider.phone = undefined;
    }

    // Side-load the rider profile (vehicle plate + rating) when a
    // rider is assigned. Cheap extra query; keeps the populate chain
    // simple and avoids leaking RiderProfile internals.
    let riderProfile: { plate?: string; rating?: number } | null = null;
    if (order.riderId) {
      const RiderProfile = (await import("../models/RiderProfile")).default;
      const rp = await RiderProfile.findOne({
        user:
          typeof order.riderId === "object" &&
          order.riderId !== null &&
          "_id" in order.riderId
            ? (order.riderId as any)._id
            : order.riderId,
      })
        .select("vehiclePlate rating")
        .lean();
      if (rp) {
        riderProfile = { plate: rp.vehiclePlate, rating: rp.rating };
      }
    }

    res.json({ ...order, riderProfile });
  } catch (err) {
    console.error("[orders/:orderId]", err);
    res.status(500).json({ message: "Failed to fetch order" });
  }
});

// ===================== ROUTE POLYLINE =====================
/**
 * GET /api/orders/:orderId/route?riderLat=&riderLng=&target=station|destination
 *
 * Returns the rider→target polyline (decoded [lat,lng] tuples) plus
 * distance + duration. Backed by the shared `computeRoute` helper
 * (Directions API + 30s cache + per-order throttle). Both customer
 * and assigned rider are allowed; subsequent updates arrive over the
 * `route:update` socket event broadcast from the rider:location handler.
 */
router.get("/:orderId/route", requireAuth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId)
      .select("user")
      .lean();
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Authorise: order's customer OR the assigned rider. The rider
    // needs the same data to draw their own polyline.
    const isCustomer = order.user.toString() === req.userId;
    let isRider = false;
    if (!isCustomer) {
      const assigned = await Delivery.findOne({
        order: order._id,
        rider: req.userId,
      })
        .select("_id")
        .lean();
      isRider = !!assigned;
    }
    if (!isCustomer && !isRider)
      return res.status(403).json({ message: "Forbidden" });

    let riderLat: number;
    let riderLng: number;

    // SECURITY (audit A.9): the customer is NOT trusted to provide
    // the rider's coords. Without this gate, a customer could poll
    // `/route?riderLat=<random>&riderLng=<random>` to drive Directions
    // API spend + spam route:update broadcasts. For customer callers
    // we resolve from the rider's last-known GPS server-side and
    // ignore body coords entirely. Rider callers (drawing their own
    // map) keep passing live GPS.
    if (isCustomer) {
      const delivery = await Delivery.findOne({
        order: order._id,
        status: { $nin: ["delivered", "dropped", "failed"] },
      })
        .select("rider")
        .lean();
      if (!delivery?.rider) {
        return res
          .status(404)
          .json({ message: "No active rider on this order yet" });
      }
      const profile = await RiderProfile.findOne({ user: delivery.rider })
        .select("currentLocation")
        .lean();
      const lat = profile?.currentLocation?.lat;
      const lng = profile?.currentLocation?.lng;
      if (lat == null || lng == null) {
        return res
          .status(404)
          .json({ message: "Rider has not shared a location yet" });
      }
      riderLat = lat;
      riderLng = lng;
    } else {
      riderLat = Number(req.query.riderLat);
      riderLng = Number(req.query.riderLng);
      if (!Number.isFinite(riderLat) || !Number.isFinite(riderLng))
        return res.status(400).json({ message: "riderLat & riderLng required" });
    }

    const target: RouteTarget =
      req.query.target === "station" ? "station" : "destination";

    const result = await computeRoute(
      String(order._id),
      riderLat,
      riderLng,
      target
    );
    if (!result) {
      return res.status(400).json({
        message:
          target === "station"
            ? "Station missing coordinates"
            : "Delivery address missing coordinates",
      });
    }

    // Broadcast freshly-computed routes to the delivery room so a
    // second device (rider's phone, customer on web) sees the same
    // geometry without polling. Cache hits skip the broadcast — the
    // recipients already have it from the prior fresh call.
    if (!result.cached) {
      try {
        const activeDelivery = await Delivery.findOne({
          order: order._id,
          status: { $nin: ["delivered", "dropped", "failed"] },
        })
          .select("_id")
          .lean();
        if (activeDelivery) {
          emitToDelivery(String(activeDelivery._id), "route:update", {
            orderId: String(order._id),
            polyline: result.polyline,
            distanceM: result.distanceMeters,
            durationS: result.durationSeconds,
            steps: result.steps,
            target,
          });
        }
      } catch {
        // non-fatal — synchronous response covers the requester
      }
    }

    res.json({
      polyline: result.polyline,
      distanceMeters: result.distanceMeters,
      durationSeconds: result.durationSeconds,
      steps: result.steps,
    });
  } catch (err) {
    console.error("[orders/:orderId/route]", err);
    res.status(500).json({ message: "Failed to load route" });
  }
});

// ===================== UPDATE ORDER STATUS =====================
/**
 * Allowed status transitions, scoped by caller role + ownership.
 *
 * S-S-01: Before this matrix, ANY authenticated user could PATCH any
 * order to any status — including a customer marking their own order
 * `delivered` to skip the rider entirely. Each cell below is the
 * narrowest valid transition for that role.
 *
 * Customer-confirm-delivery uses its own dedicated route
 * (`/confirm-delivery`) and is intentionally NOT included here so
 * customers can't accidentally use this generic endpoint to flip
 * `delivered`.
 */
// Status transition matrix lives in the shared module so the rider
// app + server validate against the same rules. See
// `src/_shared/transitions.ts` for the canonical list.
import { isAllowedTransition, type TransitionRole } from "../_shared/transitions";
type Role = TransitionRole;

router.patch("/:orderId/status", requireAuth, validate(updateOrderStatusSchema), async (req, res) => {
  try {
    const { status } = req.body;

    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Resolve caller role + ownership before mutating anything.
    const caller = await User.findById(req.userId).select("role").lean();
    if (!caller) return res.status(401).json({ message: "Unauthorized" });

    const role = caller.role as Role;
    const prevStatus = order.status;

    // Ownership gates per role:
    //   customer → must own the order
    //   vendor   → must own the order's station
    //   rider    → must be the assigned rider on the order
    //   admin    → no ownership check
    if (role === "customer" && order.user.toString() !== req.userId) {
      return res.status(403).json({ message: "Forbidden" });
    }
    if (role === "rider" && order.riderId?.toString() !== req.userId) {
      return res.status(403).json({ message: "Forbidden" });
    }
    if (role === "vendor") {
      const GasStation = (await import("../models/Station")).default;
      const station = await GasStation.findById(order.station)
        .select("vendorId")
        .lean();
      if (!station || (station as any).vendorId?.toString() !== req.userId) {
        return res.status(403).json({ message: "Forbidden" });
      }
    }

    if (!isAllowedTransition(role, prevStatus, status)) {
      return res.status(403).json({
        message: `Transition ${prevStatus} → ${status} not allowed for role ${role}`,
      });
    }

    order.status = status;
    // EDGE P1-6 / WS_VS_API P0 — bump version + save in one go, then
    // emit a full-OrderDetail update to the vendor namespace so the
    // vendor app doesn't have to GET /api/vendor/orders/:id on every
    // event.
    await bumpAndSaveOrder(order);

    const userId = order.user.toString();

    // Resolve vendorId for the dual emit.
    let vendorId: string | null = null;
    {
      const GasStation = (await import("../models/Station")).default;
      const station = await GasStation.findById(order.station)
        .select("vendorId")
        .lean();
      vendorId = (station as any)?.vendorId ? String((station as any).vendorId) : null;
    }
    emitOrderUpdate(order, vendorId);

    // Background notifications (do not block response)
    Promise.resolve().then(async () => {
      if (status === "confirmed" && prevStatus !== "confirmed") {
        await notifyUser(userId, "order", "Order Confirmed", "Your order has been confirmed by the station.");
      }
      if ((status === "in_transit" || status === "in-transit") && prevStatus !== status) {
        await notifyUser(userId, "delivery", "On the Way!", "Your fuel is on its way. Track your rider in real time.");
      }
      // Rider has rolled up to the customer's address — surface the
      // most attention-grabbing notification of the flow. The customer's
      // app simultaneously hard-routes to the Arrival/Handoff screen
      // (driven by the same socket order:update event), so this push
      // primarily lights up the lock screen for users who minimised.
      if (status === "arrived" && prevStatus !== "arrived") {
        await notifyUser(
          userId,
          "delivery",
          "Your rider is here 🚪",
          "They're at your gate. Step out when ready."
        );
      }
      if (status === "delivered" && prevStatus !== "delivered") {
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30);
        await awardPoints(userId, POINTS_CONFIG.orderDelivered, "Points for order delivered", undefined, expiresAt);
        await settleOrderEarnings(order._id.toString());
        await notifyUser(userId, "delivered", "Fuel Delivered!", "Your fuel order has been delivered. Enjoy!");
        await notifyUser(userId, "points", "Points Earned!", `You earned ${POINTS_CONFIG.orderDelivered} Gaznger Points for this delivery.`);
      }
    }).catch(() => {});

    res.json(order);
  } catch (err) {

    res.status(500).json({ message: "Failed to update order status" });
  }
});

// ===================== CANCEL ORDER =====================
router.patch("/:orderId/cancel", requireAuth, async (req, res) => {
  try {
    // Phase 9 — atomic cancel. The status filter `pending` ensures
    // two concurrent cancel requests can't both succeed; the loser
    // gets null back and a 409. Replaces the read-then-write that
    // was a tiny but real race window (customer double-taps the
    // cancel button, both requests in flight before the first save).
    const order = await Order.findOneAndUpdate(
      {
        _id: req.params.orderId,
        user: req.userId,
        status: "pending",
      },
      { status: "cancelled" },
      { new: true }
    );
    if (!order) {
      // Differentiate "not yours" from "wrong status" by re-fetching
      // for accurate error messages. Cheap second query, only on the
      // rare error path.
      const exists = await Order.findById(req.params.orderId)
        .select("user status")
        .lean();
      if (!exists) return res.status(404).json({ message: "Order not found" });
      if (String(exists.user) !== req.userId)
        return res.status(403).json({ message: "Forbidden" });
      return res
        .status(400)
        .json({ message: "Only pending orders can be cancelled" });
    }

    emitToUser(req.userId, "order:update", { orderId: String(order._id), status: "cancelled" });

    await notifyUser(
      req.userId,
      "cancelled",
      "Order Cancelled",
      "Your order has been cancelled and any earned points have been reversed."
    );

    res.json({ message: "Order cancelled", order });
  } catch (err) {
    res.status(500).json({ message: "Failed to cancel order" });
  }
});

// ===================== CUSTOMER "I'M HERE" PING =====================
/**
 * POST /api/orders/:orderId/customer-here
 *
 * Surfaced by the v3 Track screen during the `almost-there` phase.
 * Tells the rider that the customer is at the gate so they don't have
 * to call. Idempotent — repeat hits within the same order are no-ops
 * (we just re-emit the socket event so a reconnected rider catches it).
 *
 * Authorization: customer-only, must own the order.
 *
 * Side effects:
 *   - Stamps `order.customerHereAt` if not yet set.
 *   - Emits `order:customer-here` to the rider's socket room with the
 *     order id + timestamp.
 *   - Best-effort push notification to the rider.
 *
 * Returns: { stamped: boolean, customerHereAt: Date }
 */
router.post("/:orderId/customer-here", requireAuth, requireCustomer, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (order.user.toString() !== req.userId)
      return res.status(403).json({ message: "Forbidden" });

    // Only meaningful while a rider is en route. Block on terminal
    // statuses so a stale tap doesn't ping a long-finished order.
    const eligibleStatuses = [
      "assigned",
      "picked_up",
      "at_plant",
      "refilling",
      "returning",
      "arrived",
    ];
    if (!eligibleStatuses.includes(order.status)) {
      return res.status(400).json({
        message: "Rider isn't en route to your address right now.",
      });
    }

    let stamped = false;
    if (!order.customerHereAt) {
      order.customerHereAt = new Date();
      await order.save();
      stamped = true;
    }
    const customerHereAt = order.customerHereAt;

    // Emit to the rider so their app surfaces a "Customer at gate" pill.
    if (order.riderId) {
      emitToUser(order.riderId.toString(), "order:customer-here", {
        orderId: order._id.toString(),
        customerHereAt,
      });
      // Push to the rider device — non-fatal if it fails.
      notifyUser(
        order.riderId.toString(),
        "delivery",
        "Customer at the gate",
        "Heads up — they're outside waiting."
      ).catch(() => {});
    }

    res.json({ stamped, customerHereAt });
  } catch (err) {
    console.error("[orders/:orderId/customer-here]", err);
    res.status(500).json({ message: "Failed to send arrival ping" });
  }
});

// ===================== CUSTOMER CONFIRMS DELIVERY RECEIPT =====================
router.patch("/:orderId/confirm-delivery", requireAuth, requireCustomer, async (req, res) => {
  try {
    // Phase 9 — atomic confirm. We fetch first to read the existing
    // totalCharged + totalPrice (needed to compute the LPG fallback),
    // but the actual flip uses findOneAndUpdate with the status guard
    // so two concurrent confirms can't both succeed. The loser gets
    // null back and a 409.
    const existing = await Order.findById(req.params.orderId)
      .select("user status totalCharged totalPrice")
      .lean();
    if (!existing) return res.status(404).json({ message: "Order not found" });
    if (String(existing.user) !== req.userId)
      return res.status(403).json({ message: "Forbidden" });
    if (existing.status !== "awaiting_confirmation")
      return res.status(400).json({ message: "Order is not awaiting confirmation" });

    const fallbackTotalCharged =
      existing.totalCharged ?? existing.totalPrice;

    const order = await Order.findOneAndUpdate(
      {
        _id: req.params.orderId,
        user: req.userId,
        status: "awaiting_confirmation",
      },
      {
        status: "delivered",
        deliveredAt: new Date(),
        totalCharged: fallbackTotalCharged,
        pointsEarned: POINTS_CONFIG.orderDelivered,
      },
      { new: true }
    );
    if (!order) {
      // Lost the race to a concurrent confirm — already delivered.
      return res
        .status(409)
        .json({ message: "Order already confirmed" });
    }

    const userId = order.user.toString();

    // Settle earnings for vendor + rider
    await settleOrderEarnings(order._id.toString());

    // Mark delivery record as delivered + set customerConfirmedAt
    const completedDelivery = await Delivery.findOneAndUpdate(
      { order: order._id, status: "awaiting_confirmation" },
      { status: "delivered", customerConfirmedAt: new Date() },
      { new: true }
    );

    // Tear down the per-delivery socket room. Both rider and customer
    // sockets leave; further events for this order go through user:
    // rooms only (the customer might still be on the Delivered screen
    // listening to order:update via the user room, which is fine).
    if (completedDelivery) {
      const { leaveDeliveryRoom } = await import("../socket");
      leaveDeliveryRoom(String(completedDelivery._id));
    }

    // Increment rider's totalDeliveries
    if (order.riderId) {
      const RiderProfile = (await import("../models/RiderProfile")).default;
      await RiderProfile.findOneAndUpdate(
        { user: order.riderId },
        { $inc: { totalDeliveries: 1 } }
      );
    }

    // Award customer points — only on successful delivery (not on placement)
    await awardPoints(userId, POINTS_CONFIG.orderDelivered, "Points for completed delivery");

    // Notify all parties — payload now carries the data Delivered/Complete
    // need so they can render real totals + timestamp + points without
    // a follow-up fetch.
    emitToUser(userId, "order:update", {
      orderId: String(order._id),
      status: "delivered",
      deliveredAt: order.deliveredAt,
      totalCharged: order.totalCharged,
      pointsEarned: order.pointsEarned,
    });
    if (order.riderId) {
      emitToUser(order.riderId.toString(), "order:update", { orderId: String(order._id), status: "delivered" });
    }

    Promise.all([
      notifyUser(userId, "delivered", "Fuel Delivered!", "Your fuel order has been confirmed as delivered. Enjoy!"),
      notifyUser(userId, "points", "Points Earned!", `You earned ${POINTS_CONFIG.orderDelivered} Gaznger Points for completing your delivery!`),
      order.riderId
        ? notifyUser(order.riderId.toString(), "payment", "Earnings Settled!", "Your delivery earnings have been settled.")
        : Promise.resolve(),
    ]).catch(() => {});

    res.json({ message: "Delivery confirmed", order });
  } catch (err) {
    res.status(500).json({ message: "Failed to confirm delivery" });
  }
});

// ===================== RATE A STATION =====================
router.post("/:orderId/rate", requireAuth, requireCustomer, validate(rateOrderSchema), async (req, res) => {
  try {
    const { score, stars, comment, note, tags, tip } = req.body;
    const finalStars = stars ?? score;
    const finalNote = note ?? comment;

    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (order.user.toString() !== req.userId)
      return res.status(403).json({ message: "Forbidden" });

    if (order.status !== "delivered")
      return res.status(400).json({ message: "Cannot rate before delivery" });

    const existingRating = await Rating.findOne({ order: order._id });
    if (existingRating)
      return res.status(409).json({ message: "You have already rated this order" });

    const rating = await Rating.create({
      user: req.userId,
      station: order.station,
      order: order._id,
      score: finalStars,
      comment: finalNote,
    });

    // Mirror the new fields onto the order doc so Complete + history
    // can display the actual submitted rating without re-fetching the
    // separate Rating doc.
    order.rating = {
      stars: finalStars,
      tags: Array.isArray(tags) ? tags : [],
      tip: typeof tip === "number" ? tip : 0,
      note: finalNote,
      ratedAt: new Date(),
    };
    await order.save();

    const ratings = (await Rating.find({ station: order.station }).lean()) as IRating[];
    const avgRating = ratings.reduce((sum, r) => sum + r.score, 0) / ratings.length;
    await GasStation.findByIdAndUpdate(order.station, { rating: avgRating });

    // SYNC P0 — emit rating:submitted to the vendor so the dashboard
    // average + count refresh instantly. Without this the vendor only
    // saw a new rating on next manual refresh.
    const station = await GasStation.findById(order.station)
      .select("vendorId")
      .lean();
    const vendorIdStr = (station as any)?.vendorId
      ? String((station as any).vendorId)
      : null;
    if (vendorIdStr) {
      emitRatingSubmitted(vendorIdStr, {
        orderId: String(order._id),
        stationId: String(order.station),
        stars: finalStars,
        newAverage: Math.round(avgRating * 10) / 10,
        totalRatings: ratings.length,
      });
    }

    await awardPoints(req.userId, POINTS_CONFIG.rateStation, "Points for rating a station");

    /* ───────────────── Rider tip transfer ─────────────────
     * The tip is net-new money on top of the order total. Debit the
     * customer's wallet directly into the rider's wallet — no escrow
     * hop, no commission cut, 100% lands with the rider per the Rate
     * screen copy ("100% GOES TO {rider}"). If the customer's wallet
     * doesn't cover the tip, the rate still goes through but the tip
     * is dropped with a non-blocking warning surfaced in the response.
     *
     * Uses postTransfer for atomic ledger pairing (debit on customer,
     * credit on rider). Idempotency keyed on the order id so a retry
     * of the rate-submit doesn't double-credit.
     */
    let tipTransferred = false;
    let tipWarning: string | undefined;
    const tipAmount = typeof tip === "number" ? Math.max(0, Math.round(tip)) : 0;
    if (tipAmount > 0 && order.riderId) {
      try {
        const { getOrCreateUserWallet, postTransfer } = await import(
          "../utils/wallet"
        );
        const customerWallet = await getOrCreateUserWallet(req.userId!);
        if (customerWallet.available >= tipAmount) {
          const riderWallet = await getOrCreateUserWallet(order.riderId);
          await postTransfer({
            from: customerWallet,
            to: riderWallet,
            amount: tipAmount,
            state: "available",
            kinds: ["order_wallet_debit", "rider_earning_credit"],
            description: `Tip on order ${order._id.toString().slice(-6).toUpperCase()}`,
            opts: {
              idempotencyKey: `order:${order._id}:rate-tip`,
              order: order._id as any,
              meta: { kind: "tip" },
            },
          });
          tipTransferred = true;

          // Real-time wallet update on both ends.
          const fresh = await getOrCreateUserWallet(req.userId!);
          emitToUser(req.userId!, "wallet:update", {
            available: fresh.available,
            pending: fresh.pending,
          });
          const freshRider = await getOrCreateUserWallet(order.riderId);
          emitToUser(order.riderId.toString(), "wallet:update", {
            available: freshRider.available,
            pending: freshRider.pending,
          });
          await notifyUser(
            order.riderId.toString(),
            "payment",
            "Tip received",
            `Customer tipped you ₦${tipAmount.toLocaleString()} for order #${order._id
              .toString()
              .slice(-6)
              .toUpperCase()}.`
          );
        } else {
          tipWarning = `Tip not transferred — your wallet balance (₦${customerWallet.available.toLocaleString()}) is below the tip amount.`;
        }
      } catch (err) {
        console.error("[orders/:orderId/rate] tip transfer failed", err);
        tipWarning = "Tip not transferred. The rating itself was saved.";
      }
    }

    res.status(201).json({ rating, order, tipTransferred, tipWarning });
  } catch (err) {
    console.error("[orders/:orderId/rate]", err);
    res.status(500).json({ message: "Failed to rate station" });
  }
});

// ===================== RECEIPT PDF =====================
/**
 * GET /api/orders/:orderId/receipt.pdf
 *
 * Streams a generated PDF receipt for the customer's order. Requires
 * the caller own the order (or be admin). Streamed inline — no S3
 * persistence; the PDF is regenerated on each request from the
 * authoritative order doc.
 */
router.get("/:orderId/receipt.pdf", requireAuth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId)
      .populate("fuel", "name unit")
      .populate("station", "name")
      .populate("deliveryAddress", "street city state")
      .lean();
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Customer-only — admin uses the dashboard (separate flow).
    if ((order as any).user.toString() !== req.userId) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const customer = await User.findById(req.userId)
      .select("displayName email")
      .lean();

    const fuel = (order as any).fuel as { name: string; unit: string } | null;
    const station = (order as any).station as { name: string } | null;
    const addr = (order as any).deliveryAddress as
      | { street?: string; city?: string; state?: string }
      | null;

    const orderShortId = (order._id as any).toString().slice(-6).toUpperCase();
    const fuelLine = `${(order as any).quantity} ${(order as any).unit ?? fuel?.unit ?? "L"} ${
      fuel?.name ?? ""
    }`.trim();

    // paymentMethodLabel mirrors the mobile helper so the receipt
    // says the same thing the in-app receipt did.
    const paymentMethodLabel = labelForPaymentMethod(
      (order as any).paymentMethodId,
      (customer as any)?.lastPaystackAuth
    );

    const totalCharged =
      (order as any).totalCharged ?? (order as any).totalPrice ?? 0;

    const { streamReceiptPdf } = await import("../utils/receiptPdf");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="gaznger-receipt-${orderShortId}.pdf"`
    );

    await streamReceiptPdf(
      {
        orderId: (order._id as any).toString(),
        orderShortId,
        fuelLine,
        stationName: station?.name ?? "—",
        deliveryAddressLine: [addr?.street, addr?.city, addr?.state]
          .filter(Boolean)
          .join(", "),
        paymentMethodLabel,
        totalCharged,
        fuelCost: (order as any).fuelCost ?? 0,
        deliveryFee: (order as any).deliveryFee ?? 0,
        pointsEarned: (order as any).pointsEarned ?? 0,
        ratedAt: (order as any).rating?.ratedAt ?? null,
        deliveredAt: (order as any).deliveredAt ?? null,
        customerName: customer?.displayName ?? "Customer",
        customerEmail: customer?.email ?? "",
        weighIn: (order as any).weighIn ?? null,
      },
      res
    );
  } catch (err) {
    console.error("[orders/:orderId/receipt.pdf]", err);
    if (!res.headersSent) res.status(500).json({ message: "Failed to generate receipt" });
  }
});

/** Mirror of mobile's lib/paymentLabel.ts so the PDF reads the same. */
function labelForPaymentMethod(
  paymentMethodId: string | undefined,
  lastPaystackAuth: { last4?: string; brand?: string } | undefined
): string {
  if (!paymentMethodId) return "Card";
  if (paymentMethodId === "card-saved") {
    const last4 = lastPaystackAuth?.last4;
    const brand = lastPaystackAuth?.brand;
    if (last4) {
      const tag = brand
        ? brand.toLowerCase().includes("visa")
          ? "VISA"
          : brand.toLowerCase().includes("master")
          ? "MASTERCARD"
          : brand.toLowerCase().includes("verve")
          ? "VERVE"
          : brand.toUpperCase()
        : "CARD";
      return `${tag} •••• ${last4}`;
    }
    return "Saved card";
  }
  if (paymentMethodId === "card-new") return "Card";
  if (paymentMethodId === "wallet") return "Gaznger wallet";
  if (paymentMethodId === "transfer") return "Bank transfer";
  return "Card";
}

export default router;
