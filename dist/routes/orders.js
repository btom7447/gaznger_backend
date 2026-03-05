"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const Order_1 = __importDefault(require("../models/Order"));
const Station_1 = __importDefault(require("../models/Station"));
const FuelType_1 = __importDefault(require("../models/FuelType"));
const Rating_1 = __importDefault(require("../models/Rating"));
const User_1 = __importDefault(require("../models/User"));
const Point_1 = __importDefault(require("../models/Point"));
const auth_1 = require("../middleware/auth");
const validate_1 = require("../middleware/validate");
const order_validators_1 = require("../validators/order.validators");
const pagination_1 = require("../utils/pagination");
const router = (0, express_1.Router)();
const POINTS_CONFIG = {
    orderPlaced: Number(process.env.POINTS_ORDER_PLACED) || 100,
    orderDelivered: Number(process.env.POINTS_ORDER_DELIVERED) || 50,
    rateStation: Number(process.env.POINTS_RATE_STATION) || 50,
};
async function awardPoints(userId, points, description, pendingUntil, expiresAt) {
    const now = new Date();
    const isPending = pendingUntil && pendingUntil > now;
    if (!isPending) {
        const user = await User_1.default.findById(userId);
        if (user) {
            user.points += points;
            if (user.points < 0)
                user.points = 0;
            await user.save();
        }
    }
    await Point_1.default.create({
        user: userId,
        change: points,
        type: points > 0 ? "earn" : "redeem",
        description,
        pendingUntil: pendingUntil ? new Date(pendingUntil) : undefined,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    });
}
// ===================== PLACE NEW ORDER =====================
router.post("/", auth_1.requireAuth, (0, validate_1.validate)(order_validators_1.createOrderSchema), async (req, res) => {
    try {
        const { fuelId, stationId, quantity, deliveryAddressId, cylinderType, deliveryType, cylinderImages, } = req.body;
        const fuel = await FuelType_1.default.findById(fuelId);
        if (!fuel)
            return res.status(404).json({ message: "Fuel not found" });
        const station = await Station_1.default.findById(stationId);
        if (!station)
            return res.status(404).json({ message: "Station not found" });
        const totalPrice = quantity * fuel.pricePerUnit;
        const orderData = {
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
        const order = await Order_1.default.create(orderData);
        await awardPoints(req.userId, POINTS_CONFIG.orderPlaced, "Points for placing an order");
        res.status(201).json(order);
    }
    catch (err) {
        res.status(500).json({ message: "Failed to place order" });
    }
});
// ===================== GET MY ORDERS (with filter & pagination) =====================
router.get("/", auth_1.requireAuth, async (req, res) => {
    try {
        const { status, startDate, endDate } = req.query;
        const filter = { user: req.userId };
        if (status)
            filter.status = status;
        if (startDate || endDate) {
            filter.createdAt = {};
            if (startDate)
                filter.createdAt.$gte = new Date(startDate);
            if (endDate)
                filter.createdAt.$lte = new Date(endDate);
        }
        const { page: pageNum, limit: limitNum, skip } = (0, pagination_1.parsePagination)(req.query);
        const [orders, total] = await Promise.all([
            Order_1.default.find(filter)
                .populate("fuel")
                .populate("station")
                .populate("deliveryAddress")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limitNum)
                .lean(),
            Order_1.default.countDocuments(filter),
        ]);
        res.json({
            data: orders,
            total,
            page: pageNum,
            totalPages: Math.ceil(total / limitNum),
        });
    }
    catch (err) {
        res.status(500).json({ message: "Failed to fetch orders" });
    }
});
// ===================== GET ORDER BY ID =====================
router.get("/:orderId", auth_1.requireAuth, async (req, res) => {
    try {
        const order = await Order_1.default.findById(req.params.orderId)
            .populate("fuel")
            .populate("station")
            .populate("deliveryAddress")
            .lean();
        if (!order)
            return res.status(404).json({ message: "Order not found" });
        if (order.user.toString() !== req.userId)
            return res.status(403).json({ message: "Forbidden" });
        res.json(order);
    }
    catch (err) {
        res.status(500).json({ message: "Failed to fetch order" });
    }
});
// ===================== UPDATE ORDER STATUS =====================
router.patch("/:orderId/status", auth_1.requireAuth, async (req, res) => {
    try {
        const { status } = req.body;
        const validStatuses = ["pending", "confirmed", "in-transit", "delivered", "cancelled"];
        if (!validStatuses.includes(status))
            return res.status(400).json({ message: "Invalid status" });
        const order = await Order_1.default.findById(req.params.orderId);
        if (!order)
            return res.status(404).json({ message: "Order not found" });
        const prevStatus = order.status;
        order.status = status;
        await order.save();
        if (status === "delivered" && prevStatus !== "delivered") {
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + 30);
            await awardPoints(order.user.toString(), POINTS_CONFIG.orderDelivered, "Points for order delivered", undefined, expiresAt);
        }
        res.json(order);
    }
    catch (err) {
        res.status(500).json({ message: "Failed to update order status" });
    }
});
// ===================== CANCEL ORDER =====================
router.patch("/:orderId/cancel", auth_1.requireAuth, async (req, res) => {
    try {
        const order = await Order_1.default.findById(req.params.orderId);
        if (!order)
            return res.status(404).json({ message: "Order not found" });
        if (order.user.toString() !== req.userId)
            return res.status(403).json({ message: "Forbidden" });
        if (order.status !== "pending")
            return res.status(400).json({ message: "Only pending orders can be cancelled" });
        order.status = "cancelled";
        await order.save();
        // Reverse the points awarded for placing this order
        const reversal = -POINTS_CONFIG.orderPlaced;
        const user = await User_1.default.findById(req.userId);
        if (user) {
            user.points = Math.max(0, user.points + reversal);
            await user.save();
        }
        await Point_1.default.create({
            user: req.userId,
            change: reversal,
            type: "adjust",
            description: "Points reversed for cancelled order",
            settled: true,
        });
        res.json({ message: "Order cancelled", order });
    }
    catch (err) {
        res.status(500).json({ message: "Failed to cancel order" });
    }
});
// ===================== RATE A STATION =====================
router.post("/:orderId/rate", auth_1.requireAuth, async (req, res) => {
    try {
        const { score, comment } = req.body;
        const order = await Order_1.default.findById(req.params.orderId);
        if (!order)
            return res.status(404).json({ message: "Order not found" });
        if (order.user.toString() !== req.userId)
            return res.status(403).json({ message: "Forbidden" });
        if (order.status !== "delivered")
            return res.status(400).json({ message: "Cannot rate before delivery" });
        const rating = await Rating_1.default.create({
            user: req.userId,
            station: order.station,
            order: order._id,
            score,
            comment,
        });
        const ratings = (await Rating_1.default.find({ station: order.station }).lean());
        const avgRating = ratings.reduce((sum, r) => sum + r.score, 0) / ratings.length;
        await Station_1.default.findByIdAndUpdate(order.station, { rating: avgRating });
        await awardPoints(req.userId, POINTS_CONFIG.rateStation, "Points for rating a station");
        res.status(201).json(rating);
    }
    catch (err) {
        res.status(500).json({ message: "Failed to rate station" });
    }
});
exports.default = router;
//# sourceMappingURL=orders.js.map