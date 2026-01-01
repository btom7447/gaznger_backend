"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const Notification_1 = __importDefault(require("../models/Notification"));
const push_1 = require("../utils/push");
const User_1 = __importDefault(require("../models/User"));
const router = (0, express_1.Router)();
/**
 * @swagger
 * tags:
 *   name: Notifications
 *   description: User notifications management
 */
// GET user notifications
router.get("/:userId", async (req, res) => {
    try {
        const notifications = await Notification_1.default.find({
            user: req.params.userId,
        }).sort({ createdAt: -1 });
        res.json(notifications);
    }
    catch (err) {
        res.status(500).json({ message: "Failed to fetch notifications" });
    }
});
// Mark notification as read
router.patch("/:id/read", async (req, res) => {
    try {
        const notification = await Notification_1.default.findByIdAndUpdate(req.params.id, { read: true }, { new: true });
        if (!notification)
            return res.status(404).json({ message: "Notification not found" });
        res.json(notification);
    }
    catch (err) {
        res.status(500).json({ message: "Failed to update notification" });
    }
});
// Send notification to a user (admin/system)
router.post("/send", async (req, res) => {
    try {
        const { userId, type, title, body, push = false } = req.body;
        const user = await User_1.default.findById(userId);
        if (!user)
            return res.status(404).json({ message: "User not found" });
        // Save notification in DB
        const notification = await Notification_1.default.create({
            user: user._id,
            type,
            title,
            body,
        });
        // Optionally send push notification
        if (push && user.deviceTokens.length > 0) {
            await (0, push_1.sendPushNotification)(user.deviceTokens, title, body);
        }
        res.status(201).json(notification);
    }
    catch (err) {
        res.status(500).json({ message: "Failed to send notification" });
    }
});
exports.default = router;
