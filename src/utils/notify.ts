import Notification, { NotificationType } from "../models/Notification";
import User from "../models/User";
import { sendPushNotification } from "./push";

/**
 * Create an in-app notification and send a push notification.
 * Both are best-effort — failures are swallowed so they never block the main flow.
 */
export async function notifyUser(
  userId: string,
  type: NotificationType,
  title: string,
  body: string
): Promise<void> {
  try {
    await Notification.create({ user: userId, type, title, body });

    const user = await User.findById(userId).select("deviceTokens").lean();
    const tokens: string[] = (user as any)?.deviceTokens ?? [];
    if (tokens.length) {
      await sendPushNotification(tokens, title, body);
    }
  } catch {
    // Notification failure must never break the caller
  }
}
