import User from "../models/User";
import { invalidateTokenVersionCache } from "../middleware/auth";

/**
 * SEC-P1 (audit run 5): bump a user's tokenVersion so every in-flight
 * access JWT immediately fails the cached-version check in
 * requireAuth.
 *
 * Call after any event that should invalidate live sessions:
 *   - logout (single-device or all-devices)
 *   - refresh-token reuse detection (suspected token theft)
 *   - account suspension by admin
 *   - account deletion / soft-delete
 *   - role change (defence-in-depth — the role-change path also
 *     refuses admin promotion via the generic endpoint, but bumping
 *     the version forces a re-login so the client picks up the new
 *     role + UI immediately)
 *
 * Best-effort — failure to bump shouldn't block the caller's main
 * action (the next refresh window catches it).
 */
export async function bumpTokenVersion(userId: string): Promise<void> {
  try {
    await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
    invalidateTokenVersionCache(userId);
  } catch (err) {
    // Best-effort — log but don't throw.
    console.error("[tokenVersion] bump failed for", userId, err);
  }
}
