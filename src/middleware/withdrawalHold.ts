import { NextFunction, Request, Response } from "express";
import User from "../models/User";

/**
 * Guard that blocks any "money out" action when the caller has an
 * active withdrawal hold. Mounts on the wallet withdraw route + any
 * future payout-creation endpoint. The 403 body shape is what the
 * mobile lib/api.ts intercept expects so the user lands on
 * /(auth)/states/withdrawal-hold without each surface wiring its own
 * route-out.
 *
 * Requires `requireAuth` to have run first (uses req.userId).
 */
export async function blockOnWithdrawalHold(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.userId) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }
  const user = await User.findById(req.userId).select("withdrawalHold").lean();
  if (user?.withdrawalHold?.active) {
    res.status(403).json({
      code: "WITHDRAWAL_HOLD",
      message: "Withdrawals on hold.",
      reason: user.withdrawalHold.reason,
    });
    return;
  }
  next();
}
