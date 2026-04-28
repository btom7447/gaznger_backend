import Notification, { NotificationType } from "../models/Notification";
import User from "../models/User";
import { sendPushNotification } from "./push";
import { emitToUser } from "../socket";

/**
 * Create an in-app notification, send a push notification, and emit a
 * real-time socket event to the user.
 * All delivery methods are best-effort — failures never block the caller.
 */
export async function notifyUser(
  userId: string,
  type: NotificationType,
  title: string,
  body: string
): Promise<void> {
  try {
    const notification = await Notification.create({ user: userId, type, title, body });

    // Real-time delivery
    emitToUser(userId, "notification:new", {
      _id: notification._id,
      type,
      title,
      body,
      read: false,
      createdAt: notification.createdAt,
    });

    const user = await User.findById(userId).select("deviceTokens").lean();
    const tokens: string[] = (user as any)?.deviceTokens ?? [];
    if (tokens.length) {
      await sendPushNotification(tokens, title, body);
    }
  } catch {
    // Notification failure must never break the caller
  }
}
