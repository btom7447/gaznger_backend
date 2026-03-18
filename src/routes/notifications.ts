import { Router } from "express";
import Notification from "../models/Notification";
import { requireAuth } from "../middleware/auth";
import { parsePagination } from "../utils/pagination";

const router = Router();

// GET my notifications (paginated)
router.get("/", requireAuth, async (req, res) => {
  try {
    const { page: pageNum, limit: limitNum, skip } = parsePagination(req.query as Record<string, unknown>);

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

// Mark all notifications as read (must come before /:id routes)
router.patch("/read-all", requireAuth, async (req, res) => {
  try {
    await Notification.updateMany({ user: req.userId, read: false }, { read: true });
    res.json({ message: "All notifications marked as read" });
  } catch (err) {
    res.status(500).json({ message: "Failed to update notifications" });
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


// GET unread notification count
router.get("/unread-count", requireAuth, async (req, res) => {
  try {
    const count = await Notification.countDocuments({ user: req.userId, read: false });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch unread count" });
  }
});

// DELETE a single notification
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const notification = await Notification.findOneAndDelete({
      _id: req.params.id,
      user: req.userId,
    });
    if (!notification)
      return res.status(404).json({ message: "Notification not found" });
    res.json({ message: "Notification deleted" });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete notification" });
  }
});

export default router;
