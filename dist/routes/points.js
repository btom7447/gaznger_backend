"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const User_1 = __importDefault(require("../models/User"));
const Point_1 = __importDefault(require("../models/Point"));
const Order_1 = __importDefault(require("../models/Order"));
const auth_1 = require("../middleware/auth");
const pagination_1 = require("../utils/pagination");
const router = (0, express_1.Router)();
// ===================== GET MY POINTS =====================
router.get("/", auth_1.requireAuth, async (req, res) => {
    try {
        const user = await User_1.default.findById(req.userId).select("points").lean();
        if (!user)
            return res.status(404).json({ message: "User not found" });
        res.json({ userId: req.userId, points: user.points || 0 });
    }
    catch (err) {
        res.status(500).json({ message: "Failed to fetch points" });
    }
});
// ===================== GET MY POINT HISTORY (paginated) =====================
router.get("/history", auth_1.requireAuth, async (req, res) => {
    try {
        const now = new Date();
        const { page: pageNum, limit: limitNum, skip } = (0, pagination_1.parsePagination)(req.query);
        const [pointsHistory, total] = await Promise.all([
            Point_1.default.find({ user: req.userId })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limitNum)
                .lean(),
            Point_1.default.countDocuments({ user: req.userId }),
        ]);
        const enrichedHistory = pointsHistory.map((p) => {
            let status = "available";
            if (p.pendingUntil && new Date(p.pendingUntil) > now) {
                status = "pending";
            }
            else if (p.expiresAt && new Date(p.expiresAt) < now) {
                status = "expired";
            }
            else if (p.settled === false) {
                status = "pending";
            }
            return { ...p, status };
        });
        res.json({
            data: enrichedHistory,
            total,
            page: pageNum,
            totalPages: Math.ceil(total / limitNum),
        });
    }
    catch (err) {
        res.status(500).json({ message: "Failed to fetch point history" });
    }
});
// ===================== REDEEM POINTS =====================
router.post("/redeem", auth_1.requireAuth, async (req, res) => {
    try {
        const { orderId, pointsToRedeem } = req.body;
        if (!orderId || typeof pointsToRedeem !== "number" || pointsToRedeem <= 0)
            return res.status(400).json({ message: "orderId and a positive pointsToRedeem are required" });
        const user = await User_1.default.findById(req.userId);
        if (!user)
            return res.status(404).json({ message: "User not found" });
        if (user.points < pointsToRedeem)
            return res.status(400).json({ message: "Insufficient points balance" });
        const order = await Order_1.default.findById(orderId);
        if (!order)
            return res.status(404).json({ message: "Order not found" });
        if (order.user.toString() !== req.userId)
            return res.status(403).json({ message: "Forbidden" });
        if (order.status !== "pending")
            return res.status(400).json({ message: "Points can only be redeemed on pending orders" });
        // Prevent double-redeem: check if points were already applied to this order
        const alreadyRedeemed = await Point_1.default.findOne({
            user: req.userId,
            type: "redeem",
            description: { $regex: order._id.toString() },
        });
        if (alreadyRedeemed)
            return res.status(409).json({ message: "Points have already been redeemed on this order" });
        // Each point is worth ₦1 in discount (customize as needed)
        const discountAmount = pointsToRedeem;
        order.totalPrice = Math.max(0, order.totalPrice - discountAmount);
        await order.save();
        user.points -= pointsToRedeem;
        await user.save();
        await Point_1.default.create({
            user: req.userId,
            change: -pointsToRedeem,
            type: "redeem",
            description: `Redeemed ${pointsToRedeem} points on order #${order._id.toString().slice(-6).toUpperCase()}`,
            settled: true,
        });
        res.json({
            message: `${pointsToRedeem} points redeemed. Order discount: ₦${discountAmount}`,
            newPointsBalance: user.points,
            updatedOrderTotal: order.totalPrice,
        });
    }
    catch (err) {
        res.status(500).json({ message: "Failed to redeem points" });
    }
});
exports.default = router;
//# sourceMappingURL=points.js.map