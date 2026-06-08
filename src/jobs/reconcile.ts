import Wallet from "../models/Wallet";
import Notification from "../models/Notification";
import User from "../models/User";
import { fetchBalance } from "../utils/paystack";
import { emitToUser, emitToAdmins } from "../socket";

/**
 * Nightly reconciliation: compare Paystack's NGN balance against the
 * sum of all wallet balances we hold. Drift = something we charged or
 * paid out that didn't make it to / from Paystack as expected.
 *
 * Tolerance: ₦100 — covers rounding from Paystack's kobo precision and
 * occasional in-flight transfers that haven't ack'd yet. Anything bigger
 * gets a NotifyAllAdmins push so ops can investigate before sunrise.
 *
 * Reconciliation does NOT auto-correct. It surfaces the drift, then a
 * human goes to the admin dashboard and resolves it (manual adjustment
 * Transaction with kind="admin_adjust" + AuditLog entry).
 */
const DRIFT_TOLERANCE_NGN = 100;

export async function reconcileWallets(): Promise<{
  paystackBalanceNgn: number;
  walletSumNgn: number;
  driftNgn: number;
  withinTolerance: boolean;
}> {
  // 1. Sum every wallet's available + pending. System wallets count too —
  //    platform-escrow holds in-flight money, platform-revenue holds
  //    commission earned (less anything paid out).
  const sumAgg = await Wallet.aggregate([
    {
      $group: {
        _id: null,
        available: { $sum: "$available" },
        pending: { $sum: "$pending" },
      },
    },
  ]);
  const walletSumNgn =
    (sumAgg[0]?.available ?? 0) + (sumAgg[0]?.pending ?? 0);

  // 2. Paystack balance — array per currency. We only do NGN.
  let paystackBalanceNgn = 0;
  try {
    const balances = await fetchBalance();
    const ngn = balances.find((b) => b.currency === "NGN");
    paystackBalanceNgn = (ngn?.balance ?? 0) / 100; // kobo → ngn
  } catch (err) {
    console.error("[reconcile] failed to fetch Paystack balance:", err);
  }

  const driftNgn = paystackBalanceNgn - walletSumNgn;
  const withinTolerance = Math.abs(driftNgn) <= DRIFT_TOLERANCE_NGN;

  if (!withinTolerance) {
    const direction = driftNgn > 0 ? "OVER" : "UNDER";
    const msg = `${direction} by ₦${Math.abs(driftNgn).toLocaleString()}: Paystack ₦${paystackBalanceNgn.toLocaleString()} vs wallets ₦${walletSumNgn.toLocaleString()}`;
    console.warn(`[reconcile] DRIFT — ${msg}`);

    // Notify every admin user in-app + via socket. Email/Slack alerting
    // can plug into this same hook once configured.
    const admins = await User.find({ role: "admin" }).select("_id").lean();
    for (const a of admins) {
      try {
        await Notification.create({
          user: a._id,
          type: "system",
          title: "Wallet reconciliation drift",
          body: msg,
        });
      } catch {
        // best-effort
      }
    }
    // P1-3: single fan-out to the admin broadcast room replaces the
    // per-admin loop. Notification rows still go per-user above so
    // the inbox surfaces it; the live banner uses the room emit.
    emitToAdmins("reconcile:drift", {
      paystackBalanceNgn,
      walletSumNgn,
      driftNgn,
      detectedAt: new Date().toISOString(),
    });
  } else {
    console.log(
      `[reconcile] OK — Paystack ₦${paystackBalanceNgn.toLocaleString()} vs wallets ₦${walletSumNgn.toLocaleString()} (drift ₦${driftNgn})`
    );
  }

  return { paystackBalanceNgn, walletSumNgn, driftNgn, withinTolerance };
}
