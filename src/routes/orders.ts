import { Router } from "express";
import Order from "../models/Order";
import GasStation from "../models/Station";
import FuelType from "../models/FuelType";
import Rating, { IRating } from "../models/Rating";

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Orders
 *   description: Order management
 */

// ===================== PLACE NEW ORDER =====================
/**
 * @swagger
 * /api/orders:
 *   post:
 *     summary: Place a new fuel order
 *     tags: [Orders]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, fuelId, stationId, quantity, deliveryAddressId]
 *             properties:
 *               userId:
 *                 type: string
 *               fuelId:
 *                 type: string
 *               stationId:
 *                 type: string
 *               quantity:
 *                 type: number
 *               deliveryAddressId:
 *                 type: string
 *     responses:
 *       201:
 *         description: Order placed
 *       404:
 *         description: Fuel or station not found
 *       500:
 *         description: Server error
 */
router.post("/", async (req, res) => {
  try {
    const { userId, fuelId, stationId, quantity, deliveryAddressId } = req.body;

    const fuel = await FuelType.findById(fuelId);
    if (!fuel) return res.status(404).json({ message: "Fuel not found" });

    const station = await GasStation.findById(stationId);
    if (!station) return res.status(404).json({ message: "Station not found" });

    const totalPrice = quantity * fuel.pricePerUnit;

    const order = await Order.create({
      user: userId,
      fuel: fuelId,
      station: stationId,
      quantity,
      unit: fuel.unit,
      totalPrice,
      status: "pending",
      deliveryAddress: deliveryAddressId,
    });

    res.status(201).json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to place order" });
  }
});

// ===================== GET ALL ORDERS FOR A USER =====================
/**
 * @swagger
 * /api/orders/user/{userId}:
 *   get:
 *     summary: Get all orders for a specific user
 *     tags: [Orders]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of user orders
 *       500:
 *         description: Server error
 */
router.get("/user/:userId", async (req, res) => {
  try {
    const orders = await Order.find({ user: req.params.userId })
      .populate("fuel")
      .populate("station")
      .populate("deliveryAddress")
      .sort({ createdAt: -1 });

    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch orders" });
  }
});

// ===================== GET ORDER BY ID =====================
/**
 * @swagger
 * /api/orders/{orderId}:
 *   get:
 *     summary: Get order by ID
 *     tags: [Orders]
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Order details
 *       404:
 *         description: Order not found
 *       500:
 *         description: Server error
 */
router.get("/:orderId", async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId)
      .populate("fuel")
      .populate("station")
      .populate("deliveryAddress");

    if (!order) return res.status(404).json({ message: "Order not found" });

    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch order" });
  }
});

// ===================== UPDATE ORDER STATUS =====================
/**
 * @swagger
 * /api/orders/{orderId}/status:
 *   patch:
 *     summary: Update status of an order
 *     tags: [Orders]
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [pending, in-transit, delivered]
 *     responses:
 *       200:
 *         description: Updated order
 *       400:
 *         description: Invalid status
 *       404:
 *         description: Order not found
 *       500:
 *         description: Server error
 */
router.patch("/:orderId/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!["pending", "in-transit", "delivered"].includes(status))
      return res.status(400).json({ message: "Invalid status" });

    const order = await Order.findByIdAndUpdate(
      req.params.orderId,
      { status },
      { new: true }
    );

    if (!order) return res.status(404).json({ message: "Order not found" });

    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update order status" });
  }
});

// ===================== RATE A STATION =====================
/**
 * @swagger
 * /api/orders/{orderId}/rate:
 *   post:
 *     summary: Rate a station for an order
 *     tags: [Orders]
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, score]
 *             properties:
 *               userId:
 *                 type: string
 *               score:
 *                 type: number
 *                 example: 4
 *               comment:
 *                 type: string
 *                 example: "Good service"
 *     responses:
 *       201:
 *         description: Rating created
 *       400:
 *         description: Cannot rate before delivery
 *       404:
 *         description: Order not found
 *       500:
 *         description: Server error
 */
router.post("/:orderId/rate", async (req, res) => {
  try {
    const { userId, score, comment } = req.body;

    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (order.status !== "delivered")
      return res.status(400).json({ message: "Cannot rate before delivery" });

    const rating = await Rating.create({
      user: userId,
      station: order.station,
      order: order._id,
      score,
      comment,
    });

    const ratings = (await Rating.find({
      station: order.station,
    }).lean()) as IRating[];
    const avgRating =
      ratings.reduce((sum, r) => sum + r.score, 0) / ratings.length;

    await GasStation.findByIdAndUpdate(order.station, { rating: avgRating });

    res.status(201).json(rating);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to rate station" });
  }
});

export default router;
