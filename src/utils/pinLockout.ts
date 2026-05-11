/**
 * PIN brute-force protection — per-account counter + lockout.
 *
 * Used by `/auth/login` and `/auth/pin/verify`. Both routes accept a
 * 4-digit PIN; without per-account state we'd be relying on the
 * IP-only `authLimiter` (30/15min) which a determined attacker
 * trivially bypasses by rotating IPs.
 *
 * SECURITY (audit A.4): 4-digit PIN keyspace is 10,000. At
 * `MAX_FAILURES = 5` per `WINDOW_MS = 15min` and `LOCKOUT_MS = 15min`
 * an attacker's worst-case throughput is ~480 guesses/day on a single
 * account — 21 days for full keyspace coverage. Combined with the IP
 * limiter the practical floor is far higher.
 *
 * Behaviour:
 *   - First failure → set `firstFailedAt`, `count = 1`.
 *   - Subsequent failures within the window → increment `count`.
 *   - Failures outside the window → reset (treat as fresh).
 *   - At `count >= MAX_FAILURES` → set `lockedUntil = now + LOCKOUT_MS`.
 *   - `lockedUntil > now` → routes return 423 with a generic message.
 *   - Successful PIN check → clear the subdoc.
 *
 * Exported helpers:
 *   - `assertNotLocked(user)` — throws a 423 sentinel if locked.
 *   - `recordPinFailure(userId)` — atomic increment; returns whether
 *     this attempt triggered a fresh lockout.
 *   - `clearPinFailures(userId)` — clear on success.
 */

import User from "../models/User";

export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_MS = 15 * 60 * 1000;

export class PinLockedError extends Error {
  retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super("PIN attempts exceeded");
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * Throw `PinLockedError` if `user.pinFailures.lockedUntil` is in the
 * future. Caller maps the throw to a 423 response. Read-only — does
 * not mutate the user.
 */
export function assertNotLocked(user: {
  pinFailures?: { lockedUntil?: Date };
}): void {
  const until = user.pinFailures?.lockedUntil;
  if (!until) return;
  const ms = until.getTime() - Date.now();
  if (ms > 0) {
    throw new PinLockedError(Math.ceil(ms / 1000));
  }
}

/**
 * Record a wrong-PIN attempt. Returns true if THIS attempt crossed
 * the lockout threshold (so the caller can include a slightly
 * different message on the response, e.g. "Too many attempts").
 *
 * Concurrency: uses `findOneAndUpdate` so two simultaneous wrong
 * attempts both count, but only one wins the threshold-crossing
 * announcement. The DB is the source of truth.
 */
export async function recordPinFailure(userId: string): Promise<{
  locked: boolean;
}> {
  const now = new Date();
  const user = await User.findById(userId)
    .select("pinFailures")
    .lean();
  const prior = user?.pinFailures;
  const inWindow =
    prior?.firstFailedAt &&
    now.getTime() - prior.firstFailedAt.getTime() < WINDOW_MS;

  // Reset path — outside window OR no prior. Start a fresh count.
  if (!inWindow) {
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          "pinFailures.count": 1,
          "pinFailures.firstFailedAt": now,
        },
        $unset: { "pinFailures.lockedUntil": "" },
      }
    );
    return { locked: false };
  }

  // Increment path — within window. Lock if we cross the threshold.
  const nextCount = (prior?.count ?? 0) + 1;
  if (nextCount >= MAX_FAILURES) {
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          "pinFailures.count": nextCount,
          "pinFailures.lockedUntil": new Date(now.getTime() + LOCKOUT_MS),
        },
      }
    );
    return { locked: true };
  }

  await User.updateOne(
    { _id: userId },
    { $set: { "pinFailures.count": nextCount } }
  );
  return { locked: false };
}

/**
 * Clear the lockout subdoc on a successful PIN check. Idempotent.
 */
export async function clearPinFailures(userId: string): Promise<void> {
  await User.updateOne(
    { _id: userId },
    {
      $unset: {
        "pinFailures.count": "",
        "pinFailures.firstFailedAt": "",
        "pinFailures.lockedUntil": "",
      },
    }
  );
}
