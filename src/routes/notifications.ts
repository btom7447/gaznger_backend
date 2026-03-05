import { Router } from "express";
import Notification from "../models/Notification";
import { sendPushNotification } from "../utils/push";
import User from "../models/User";
import { requireAuth } from "../middleware/auth";

const router = Router();

// GET my notifications (paginated)
router.get("/", requireAuth, async (req, res) => {
  try {
    const { page = "1", limit = "20" } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10)));
    const skip = (pageNum - 1) * limitNum;

    const [notifications, total] = await Promise.all([
      Notification.find({ user: req.userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Notification.countDocuments({ user: req.userId }),
    ]);

    res.json({
      data: notifications,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch notifications" });
  }
});

// Mark a single notification as read
router.patch("/:id/read", requireAuth, async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.userId },
      { read: true },
      { new: true }
    );
    if (!notification)
      return res.status(404).json({ message: "Notification not found" });
    res.json(notification);
  } catch (err) {
    res.status(500).json({ message: "Failed to update notification" });
  }
});

// Mark all notifications as read
router.patch("/read-all", requireAuth, async (req, res) => {
  try {
    await Notification.updateMany({ user: req.userId, read: false }, { read: true });
    res.json({ message: "All notifications marked as read" });
  } catch (err) {
    res.status(500).json({ message: "Failed to update notifications" });
  }
});

// Send a notification to a user (requires auth — admin/system use)
router.post("/send", requireAuth, async (req, res) => {
  try {
    const { userId, type, title, body, push = false } = req.body;

    const targetUserId = userId || req.userId;
    const user = await User.findById(targetUserId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const notification = await Notification.create({
      user: user._id,
      type,
      title,
      body,
    });

    if (push && user.deviceTokens.length > 0) {
      await sendPushNotification(user.deviceTokens, title, body);
    }

    res.status(201).json(notification);
  } catch (err) {
    res.status(500).json({ message: "Failed to send notification" });
  }
});

export default router;
