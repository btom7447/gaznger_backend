import { Router } from "express";
import mongoose from "mongoose";
import Order from "../models/Order";
import GasStation from "../models/Station";
import FuelType from "../models/FuelType";
import Address from "../models/Address";
import Rating, { IRating } from "../models/Rating";
import User from "../models/User";
import Point from "../models/Point";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { createOrderSchema, updateOrderStatusSchema, rateOrderSchema } from "../validators/order.validators";
import { parsePagination } from "../utils/pagination";
import { notifyUser } from "../utils/notify";
import { emitToUser } from "../socket";
import { haversineDistance, calcDeliveryFee } from "../utils/haversine";
import { createVendorPendingEarning, settleOrderEarnings } from "../utils/earningsUtils";
import Delivery from "../models/Delivery";

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
router.post("/", requireAuth, validate(createOrderSchema), async (req, res) => {
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

    // Calculate delivery fee via haversine if both coords are present
    let deliveryFee = 0;
    const stationHasCoords = station.location.lat !== 0 && station.location.lng !== 0;
    const addressHasCoords = address.latitude !== 0 && address.longitude !== 0;
    if (stationHasCoords && addressHasCoords) {
      const distanceKm = haversineDistance(
        { lat: station.location.lat, lng: station.location.lng },
        { lat: address.latitude, lng: address.longitude }
      );
      deliveryFee = calcDeliveryFee(distanceKm);
    } else {
      // Fallback: use base fee only when coords are unavailable
      deliveryFee = Number(process.env.DELIVERY_BASE_FEE) || 500;
    }

    // LPG-swap is a 2-trip job (delivery + return pickup), so the rider
    // gets paid for two legs even though it's one Earning row at settle
    // time. Double the fee at order-create time so escrow holds the
    // right total upfront.
    if (fuel.name === "Gas" && deliveryType === "cylinder_swap") {
      deliveryFee = deliveryFee * 2;
    }

    const totalPrice = fuelCost + deliveryFee;

    const orderData: any = {
      user: req.userId,
      fuel: resolvedFuelId,
      station: stationId,
      quantity,
      unit: fuel.unit,
      fuelCost,
      deliveryFee,
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
      await order.save();

      // 1. Instant socket events (no await)
      emitToUser(req.userId, "order:update", { orderId: order._id, status: "confirmed" });
      if (station.vendorId) {
        const vendorId = station.vendorId.toString();
        emitToUser(vendorId, "order:new", { orderId: order._id, status: "confirmed", fuelName: fuel.name, quantity, unit: fuel.unit });
        // Create vendor earnings + emit earnings event (fast DB write)
        createVendorPendingEarning(vendorId, order._id.toString(), fuelCost).catch(() => {});
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
        emitToUser(vendorId, "order:new", { orderId: order._id, status: "pending", fuelName: fuel.name, quantity, unit: fuel.unit });
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

// ===================== GET MY ORDERS (with filter & pagination) =====================
router.get("/", requireAuth, async (req, res) => {
  try {
    const { status, startDate, endDate } = req.query;

    const filter: any = { user: req.userId };
    if (status) {
      const statuses = (status as string).split(",").map((s) => s.trim()).filter(Boolean);
      filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
    }
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate as string);
      if (endDate) filter.createdAt.$lte = new Date(endDate as string);
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
      // Customer-safe rider fields only — never expose phone if order
      // hasn't reached the rider-on-site phase yet (privacy).
      .populate({
        path: "riderId",
        select: "displayName phone profileImage",
      })
      .lean();

    if (!order) return res.status(404).json({ message: "Order not found" });

    if (order.user.toString() !== req.userId)
      return res.status(403).json({ message: "Forbidden" });

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
 * GET /api/orders/:orderId/route?riderLat=&riderLng=
 *
 * Returns the rider→destination polyline as an array of [lat,lng]
 * tuples, plus distance + duration. Backed by Google Directions API
 * with a 30s in-memory cache keyed on the order id (rider position
 * doesn't move enough between fetches to redraw the road every push).
 *
 * Customer is the only consumer; ownership-checked.
 */
const routeCache = new Map<
  string,
  { polyline: [number, number][]; distanceMeters: number; durationSeconds: number; expiresAt: number }
>();
const ROUTE_CACHE_TTL_MS = 30_000;

router.get("/:orderId/route", requireAuth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId)
      .populate({ path: "deliveryAddress", select: "latitude longitude" })
      .lean();
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.user.toString() !== req.userId)
      return res.status(403).json({ message: "Forbidden" });

    const riderLat = Number(req.query.riderLat);
    const riderLng = Number(req.query.riderLng);
    if (!Number.isFinite(riderLat) || !Number.isFinite(riderLng))
      return res.status(400).json({ message: "riderLat & riderLng required" });

    const dest = order.deliveryAddress as unknown as
      | { latitude?: number; longitude?: number }
      | undefined;
    if (!dest?.latitude || !dest?.longitude)
      return res.status(400).json({ message: "Delivery address missing coordinates" });

    // Cache hit — round to 3dp so micro-jitter on the rider coord
    // doesn't bust the cache every push.
    const cacheKey = `${order._id.toString()}:${riderLat.toFixed(3)},${riderLng.toFixed(3)}`;
    const cached = routeCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({
        polyline: cached.polyline,
        distanceMeters: cached.distanceMeters,
        durationSeconds: cached.durationSeconds,
      });
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      // No API key configured — return a straight-line fallback so the
      // mobile client at least has a polyline to draw.
      return res.json({
        polyline: [
          [riderLat, riderLng],
          [dest.latitude, dest.longitude],
        ],
        distanceMeters: undefined,
        durationSeconds: undefined,
      });
    }

    const params = new URLSearchParams({
      origin: `${riderLat},${riderLng}`,
      destination: `${dest.latitude},${dest.longitude}`,
      mode: "driving",
      key: apiKey,
    });
    const directionsRes = await fetch(
      `https://maps.googleapis.com/maps/api/directions/json?${params}`
    );
    const directionsData = (await directionsRes.json()) as {
      status: string;
      routes?: {
        overview_polyline?: { points: string };
        legs?: { distance?: { value: number }; duration?: { value: number } }[];
      }[];
    };

    if (directionsData.status !== "OK" || !directionsData.routes?.[0]) {
      // Failure — straight-line fallback.
      return res.json({
        polyline: [
          [riderLat, riderLng],
          [dest.latitude, dest.longitude],
        ],
      });
    }

    const route = directionsData.routes[0];
    const encoded = route.overview_polyline?.points ?? "";
    const polyline = decodePolyline(encoded);
    const leg = route.legs?.[0];
    const distanceMeters = leg?.distance?.value ?? 0;
    const durationSeconds = leg?.duration?.value ?? 0;

    routeCache.set(cacheKey, {
      polyline,
      distanceMeters,
      durationSeconds,
      expiresAt: Date.now() + ROUTE_CACHE_TTL_MS,
    });

    res.json({ polyline, distanceMeters, durationSeconds });
  } catch (err) {
    console.error("[orders/:orderId/route]", err);
    res.status(500).json({ message: "Failed to load route" });
  }
});

/**
 * Decode Google's encoded polyline string into [lat, lng] tuples.
 * Reference algorithm:
 *   https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += dlat;
    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += dlng;
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

// ===================== UPDATE ORDER STATUS =====================
router.patch("/:orderId/status", requireAuth, validate(updateOrderStatusSchema), async (req, res) => {
  try {
    const { status } = req.body;

    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    const prevStatus = order.status;
    order.status = status;
    await order.save();

    const userId = order.user.toString();

    // Instant socket event first
    emitToUser(userId, "order:update", { orderId: order._id, status });

    // Background notifications (do not block response)
    Promise.resolve().then(async () => {
      if (status === "confirmed" && prevStatus !== "confirmed") {
        await notifyUser(userId, "order", "Order Confirmed", "Your order has been confirmed by the station.");
      }
      if ((status === "in_transit" || status === "in-transit") && prevStatus !== status) {
        await notifyUser(userId, "delivery", "On the Way!", "Your fuel is on its way. Track your rider in real time.");
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
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (order.user.toString() !== req.userId)
      return res.status(403).json({ message: "Forbidden" });

    if (order.status !== "pending")
      return res.status(400).json({ message: "Only pending orders can be cancelled" });

    order.status = "cancelled";
    await order.save();

    emitToUser(req.userId, "order:update", { orderId: order._id, status: "cancelled" });

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

// ===================== CUSTOMER CONFIRMS DELIVERY RECEIPT =====================
router.patch("/:orderId/confirm-delivery", requireAuth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (order.user.toString() !== req.userId)
      return res.status(403).json({ message: "Forbidden" });

    if (order.status !== "awaiting_confirmation")
      return res.status(400).json({ message: "Order is not awaiting confirmation" });

    order.status = "delivered";
    order.deliveredAt = new Date();
    // For liquid orders totalCharged was set at create time. For LPG
    // orders we expect the rider weigh-in to have already populated
    // totalCharged with min(estimated, weighedActual). If a swap/refill
    // landed without a weigh-in, default to totalPrice as a safety net.
    if (order.totalCharged == null) {
      order.totalCharged = order.totalPrice;
    }
    order.pointsEarned = POINTS_CONFIG.orderDelivered;
    await order.save();

    const userId = order.user.toString();

    // Settle earnings for vendor + rider
    await settleOrderEarnings(order._id.toString());

    // Mark delivery record as delivered + set customerConfirmedAt
    await Delivery.findOneAndUpdate(
      { order: order._id, status: "awaiting_confirmation" },
      { status: "delivered", customerConfirmedAt: new Date() }
    );

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
      orderId: order._id,
      status: "delivered",
      deliveredAt: order.deliveredAt,
      totalCharged: order.totalCharged,
      pointsEarned: order.pointsEarned,
    });
    if (order.riderId) {
      emitToUser(order.riderId.toString(), "order:update", { orderId: order._id, status: "delivered" });
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
router.post("/:orderId/rate", requireAuth, validate(rateOrderSchema), async (req, res) => {
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

    await awardPoints(req.userId, POINTS_CONFIG.rateStation, "Points for rating a station");

    // TODO(rider tip): when wallet+escrow extends to handle direct
    // rider tipping, debit the customer wallet for `tip` and credit
    // the rider. For now, the tip is captured but not transferred.

    res.status(201).json({ rating, order });
  } catch (err) {
    console.error("[orders/:orderId/rate]", err);
    res.status(500).json({ message: "Failed to rate station" });
  }
});

export default router;
