import * as admin from "firebase-admin";

// Initialize Firebase Admin once
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

/**
 * Send push notification to one or more device tokens
 */
export const sendPushNotification = async (
  deviceTokens: string[],
  title: string,
  body: string
) => {
  if (!deviceTokens || deviceTokens.length === 0) return;

  const message: admin.messaging.MulticastMessage = {
    notification: { title, body },
    tokens: deviceTokens,
  };

  try {
    // ⚡ Type assertion fixes TS error
  const messaging = admin.messaging() as any;
  const response = await messaging.sendMulticast(message);

  } catch {
    // Push notification failure is non-fatal
  }
};
