"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const Notification_1 = __importDefault(require("../models/Notification"));
const auth_1 = require("../middleware/auth");
const pagination_1 = require("../utils/pagination");
const router = (0, express_1.Router)();
// GET my notifications (paginated)
router.get("/", auth_1.requireAuth, async (req, res) => {
    try {
        const { page: pageNum, limit: limitNum, skip } = (0, pagination_1.parsePagination)(req.query);
        const [notifications, total] = await Promise.all([
            Notification_1.default.find({ user: req.userId })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limitNum)
                .lean(),
            Notification_1.default.countDocuments({ user: req.userId }),
        ]);
        res.json({
            data: notifications,
            total,
            page: pageNum,
            totalPages: Math.ceil(total / limitNum),
        });
    }
    catch (err) {
        res.status(500).json({ message: "Failed to fetch notifications" });
    }
});
// Mark all notifications as read (must come before /:id routes)
router.patch("/read-all", auth_1.requireAuth, async (req, res) => {
    try {
        await Notification_1.default.updateMany({ user: req.userId, read: false }, { read: true });
        res.json({ message: "All notifications marked as read" });
    }
    catch (err) {
        res.status(500).json({ message: "Failed to update notifications" });
    }
});
// Mark a single notification as read
router.patch("/:id/read", auth_1.requireAuth, async (req, res) => {
    try {
        const notification = await Notification_1.default.findOneAndUpdate({ _id: req.params.id, user: req.userId }, { read: true }, { new: true });
        if (!notification)
            return res.status(404).json({ message: "Notification not found" });
        res.json(notification);
    }
    catch (err) {
        res.status(500).json({ message: "Failed to update notification" });
    }
});
// GET unread notification count
router.get("/unread-count", auth_1.requireAuth, async (req, res) => {
    try {
        const count = await Notification_1.default.countDocuments({ user: req.userId, read: false });
        res.json({ count });
    }
    catch (err) {
        res.status(500).json({ message: "Failed to fetch unread count" });
    }
});
// DELETE a single notification
router.delete("/:id", auth_1.requireAuth, async (req, res) => {
    try {
        const notification = await Notification_1.default.findOneAndDelete({
            _id: req.params.id,
            user: req.userId,
        });
        if (!notification)
            return res.status(404).json({ message: "Notification not found" });
        res.json({ message: "Notification deleted" });
    }
    catch (err) {
        res.status(500).json({ message: "Failed to delete notification" });
    }
});
exports.default = router;
//# sourceMappingURL=notifications.js.map