import { Router } from "express";
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
import { haversineDistance, calcDeliveryFee } from "../utils/haversine";

const router = Router();

const POINTS_CONFIG = {
  orderPlaced: Number(process.env.POINTS_ORDER_PLACED) || 100,
  orderDelivered: Number(process.env.POINTS_ORDER_DELIVERED) || 50,
  rateStation: Number(process.env.POINTS_RATE_STATION) || 50,
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
      stationId,
      quantity,
      deliveryAddressId,
      cylinderType,
      deliveryType,
      cylinderImages,
    } = req.body;

    // Enforce one active order at a time
    const activeOrder = await Order.findOne({
      user: req.userId,
      status: { $in: ["pending", "confirmed", "assigned", "in-transit"] },
    });
    if (activeOrder)
      return res.status(409).json({ message: "You already have an active order. Cancel it or wait for it to complete before placing a new one." });

    const [fuel, station, address] = await Promise.all([
      FuelType.findById(fuelId),
      GasStation.findById(stationId),
      Address.findById(deliveryAddressId),
    ]);

    if (!fuel) return res.status(404).json({ message: "Fuel not found" });
    if (!station) return res.status(404).json({ message: "Station not found" });
    if (!station.isActive) return res.status(400).json({ message: "Station is currently closed" });
    if (!address) return res.status(404).json({ message: "Delivery address not found" });

    // Use station's per-fuel price (vendor-set), falling back to FuelType global price
    const stationFuelEntry = station.fuels.find(
      (f) => f.fuel.toString() === fuelId
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

    const totalPrice = fuelCost + deliveryFee;

    const orderData: any = {
      user: req.userId,
      fuel: fuelId,
      station: stationId,
      quantity,
      unit: fuel.unit,
      fuelCost,
      deliveryFee,
      totalPrice,
      status: "pending",
      deliveryAddress: deliveryAddressId,
    };

    if (fuel.name === "Gas") {
      orderData.cylinderType = cylinderType;
      orderData.deliveryType = deliveryType;
      orderData.cylinderImages = cylinderImages || [];
    }

    const order = await Order.create(orderData);

    await awardPoints(req.userId, POINTS_CONFIG.orderPlaced, "Points for placing an order");

    // Notify customer: order placed + points
    await notifyUser(
      req.userId,
      "order",
      "Order Placed",
      `Your ${fuel.name} order (${quantity} ${fuel.unit}) has been placed successfully.`
    );
    await notifyUser(
      req.userId,
      "points",
      "Points Earned!",
      `You earned ${POINTS_CONFIG.orderPlaced} Gaznger Points for placing an order.`
    );

    // Notify vendor: new order at their station
    if (station.vendorId) {
      await notifyUser(
        station.vendorId.toString(),
        "new_order",
        "New Order Received",
        `A new ${fuel.name} order (${quantity} ${fuel.unit}) has been placed at your station.`
      );
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
    if (status) filter.status = status;
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
      .lean();

    if (!order) return res.status(404).json({ message: "Order not found" });

    if (order.user.toString() !== req.userId)
      return res.status(403).json({ message: "Forbidden" });

    res.json(order);
  } catch (err) {

    res.status(500).json({ message: "Failed to fetch order" });
  }
});

// ===================== UPDATE ORDER STATUS =====================
router.patch("/:orderId/status", requireAuth, validate(updateOrderStatusSchema), async (req, res) => {
  try {
    const { status } = req.body;

    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    const prevStatus = order.status;
    order.status = status;
    await order.save();

    // Notify on relevant status transitions
    const userId = order.user.toString();
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
      await notifyUser(userId, "delivered", "Fuel Delivered!", "Your fuel order has been delivered. Enjoy!");
      await notifyUser(userId, "points", "Points Earned!", `You earned ${POINTS_CONFIG.orderDelivered} Gaznger Points for this delivery.`);
    }

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

    // Reverse the points awarded for placing this order
    const reversal = -POINTS_CONFIG.orderPlaced;
    const user = await User.findById(req.userId);
    if (user) {
      user.points = Math.max(0, user.points + reversal);
      await user.save();
    }
    await Point.create({
      user: req.userId,
      change: reversal,
      type: "adjust",
      description: "Points reversed for cancelled order",
      settled: true,
    });

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

// ===================== RATE A STATION =====================
router.post("/:orderId/rate", requireAuth, validate(rateOrderSchema), async (req, res) => {
  try {
    const { score, comment } = req.body;
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
      score,
      comment,
    });

    const ratings = (await Rating.find({ station: order.station }).lean()) as IRating[];
    const avgRating = ratings.reduce((sum, r) => sum + r.score, 0) / ratings.length;
    await GasStation.findByIdAndUpdate(order.station, { rating: avgRating });

    await awardPoints(req.userId, POINTS_CONFIG.rateStation, "Points for rating a station");

    res.status(201).json(rating);
  } catch (err) {

    res.status(500).json({ message: "Failed to rate station" });
  }
});

export default router;
