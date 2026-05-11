import * as admin from "firebase-admin";

/**
 * Lazy Firebase Admin init.
 *
 * `admin.credential.cert({ projectId: undefined, ... })` throws at
 * module-load time when FIREBASE_PROJECT_ID / CLIENT_EMAIL /
 * PRIVATE_KEY are unset. Push notifications are optional during early
 * Railway deploys, so defer the init and short-circuit when creds
 * aren't fully present.
 */
function ensureFirebaseAdmin(): typeof admin | null {
  if (
    !process.env.FIREBASE_PROJECT_ID ||
    !process.env.FIREBASE_CLIENT_EMAIL ||
    !process.env.FIREBASE_PRIVATE_KEY
  ) {
    return null;
  }
  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });
  }
  return admin;
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

  const sdk = ensureFirebaseAdmin();
  if (!sdk) return; // No creds — silently skip; order flow not blocked.

  const message: admin.messaging.MulticastMessage = {
    notification: { title, body },
    tokens: deviceTokens,
  };

  try {
    // ⚡ Type assertion fixes TS error
    const messaging = sdk.messaging() as any;
    await messaging.sendMulticast(message);
  } catch {
    // Push notification failure is non-fatal
  }
};
