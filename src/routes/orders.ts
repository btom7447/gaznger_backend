import { Router } from "express";
import Order from "../models/Order";
import GasStation from "../models/Station";
import FuelType from "../models/FuelType";
import Rating, { IRating } from "../models/Rating";
import User from "../models/User";
import Point from "../models/Point";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { createOrderSchema } from "../validators/order.validators";

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

    const fuel = await FuelType.findById(fuelId);
    if (!fuel) return res.status(404).json({ message: "Fuel not found" });

    const station = await GasStation.findById(stationId);
    if (!station) return res.status(404).json({ message: "Station not found" });

    const totalPrice = quantity * fuel.pricePerUnit;

    const orderData: any = {
      user: req.userId,
      fuel: fuelId,
      station: stationId,
      quantity,
      unit: fuel.unit,
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

    res.status(201).json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to place order" });
  }
});

// ===================== GET MY ORDERS (with filter & pagination) =====================
router.get("/", requireAuth, async (req, res) => {
  try {
    const { status, startDate, endDate, page = "1", limit = "20" } = req.query;

    const filter: any = { user: req.userId };
    if (status) filter.status = status;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate as string);
      if (endDate) filter.createdAt.$lte = new Date(endDate as string);
    }

    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10)));
    const skip = (pageNum - 1) * limitNum;

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
    console.error(err);
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
    console.error(err);
    res.status(500).json({ message: "Failed to fetch order" });
  }
});

// ===================== UPDATE ORDER STATUS =====================
router.patch("/:orderId/status", requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ["pending", "confirmed", "in-transit", "delivered", "cancelled"];
    if (!validStatuses.includes(status))
      return res.status(400).json({ message: "Invalid status" });

    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    const prevStatus = order.status;
    order.status = status;
    await order.save();

    if (status === "delivered" && prevStatus !== "delivered") {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);
      await awardPoints(
        order.user.toString(),
        POINTS_CONFIG.orderDelivered,
        "Points for order delivered",
        undefined,
        expiresAt
      );
    }

    res.json(order);
  } catch (err) {
    console.error(err);
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

    res.json({ message: "Order cancelled", order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to cancel order" });
  }
});

// ===================== RATE A STATION =====================
router.post("/:orderId/rate", requireAuth, async (req, res) => {
  try {
    const { score, comment } = req.body;
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (order.user.toString() !== req.userId)
      return res.status(403).json({ message: "Forbidden" });

    if (order.status !== "delivered")
      return res.status(400).json({ message: "Cannot rate before delivery" });

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
    console.error(err);
    res.status(500).json({ message: "Failed to rate station" });
  }
});

export default router;
