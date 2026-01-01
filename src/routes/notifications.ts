import { Router } from "express";
import Notification from "../models/Notification";
import { sendPushNotification } from "../utils/push";
import User from "../models/User";

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Notifications
 *   description: User notifications management
 */

// GET user notifications
router.get("/:userId", async (req, res) => {
  try {
    const notifications = await Notification.find({
      user: req.params.userId,
    }).sort({ createdAt: -1 });
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch notifications" });
  }
});

// Mark notification as read
router.patch("/:id/read", async (req, res) => {
  try {
    const notification = await Notification.findByIdAndUpdate(
      req.params.id,
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

// Send notification to a user (admin/system)
router.post("/send", async (req, res) => {
  try {
    const { userId, type, title, body, push = false } = req.body;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    // Save notification in DB
    const notification = await Notification.create({
      user: user._id,
      type,
      title,
      body,
    });

    // Optionally send push notification
    if (push && user.deviceTokens.length > 0) {
      await sendPushNotification(user.deviceTokens, title, body);
    }

    res.status(201).json(notification);
  } catch (err) {
    res.status(500).json({ message: "Failed to send notification" });
  }
});

export default router;
