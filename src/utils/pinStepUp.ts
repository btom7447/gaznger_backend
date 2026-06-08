import { Request, Response } from "express";
import User from "../models/User";
import { comparePassword } from "./hash";
import {
  assertNotLocked,
  clearPinFailures,
  recordPinFailure,
  PinLockedError,
} from "./pinLockout";

/**
 * SEC-P1 (audit run 5): step-up PIN verification for sensitive
 * money-routing operations.
 *
 * Wraps a handler so the caller MUST send `body.pin` and it must
 * match the user's stored PIN hash. Used by:
 *   - POST /api/vendor/banks/saved (adding a payout destination)
 *   - PATCH /api/vendor/banks/saved/:id (changing primary)
 *   - DELETE /api/vendor/banks/saved/:id (removing — same blast radius)
 *
 * Pre-fix a stolen access token (no PIN needed) could:
 *   1. Add an attacker-owned bank account
 *   2. Mark it primary
 *   3. Next legitimate withdrawal flows to the attacker
 * The PIN step-up forces the attacker to ALSO obtain the user's PIN
 * before they can redirect payouts.
 *
 * Returns null on success (handler should proceed); writes the 4xx
 * response and returns the response object on failure (handler should
 * return immediately). Honors the same pinLockout config used by
 * /auth/login + /auth/forgot-pin/start so brute-force protection is
 * uniform across step-up surfaces.
 *
 * Usage:
 *   const stepUp = await requirePinStepUp(req, res);
 *   if (stepUp) return;  // 401/423 already sent
 *   // ... proceed
 */
export async function requirePinStepUp(
  req: Request,
  res: Response,
): Promise<Response | null> {
  if (!req.userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const pin = (req.body as { pin?: string })?.pin;
  if (!pin || typeof pin !== "string" || pin.length < 4) {
    return res.status(401).json({
      code: "pin_step_up_required",
      message: "PIN required for this action.",
    });
  }

  const user = await User.findById(req.userId).select("pinHash phone");
  if (!user || !user.pinHash) {
    return res.status(401).json({
      code: "pin_step_up_required",
      message: "PIN not set on this account.",
    });
  }

  try {
    await assertNotLocked(user as never);
  } catch (err) {
    if (err instanceof PinLockedError) {
      return res.status(423).json({
        code: "pin_locked",
        message: "Too many failed attempts. Try again later.",
        retryAfterSec: err.retryAfterSec,
      });
    }
    throw err;
  }

  const ok = await comparePassword(pin, user.pinHash);
  if (!ok) {
    await recordPinFailure(user as never);
    return res.status(401).json({
      code: "pin_step_up_failed",
      message: "Incorrect PIN.",
    });
  }
  await clearPinFailures(user as never);
  return null;
}
