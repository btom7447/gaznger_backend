import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth, requireVendor } from "../middleware/auth";
import { moneyLimiter } from "../middleware/moneyLimiter";
import { idempotencyKey } from "../middleware/idempotency";
import User from "../models/User";
import Transaction from "../models/Transaction";
import Withdrawal from "../models/Withdrawal";
import BankAccount from "../models/BankAccount";
import GasStation from "../models/Station";
import FuelPlantOrder from "../models/FuelPlantOrder";
import { getOrCreateUserWallet } from "../utils/wallet";
import { resolveBankAccount } from "../utils/paystack";

/**
 * Vendor Phase-6 finance endpoints. The customer/rider wallet routes
 * are already shipped under /api/wallet/*; this file holds the
 * vendor-specific surfaces v6 needs:
 *
 *   GET    /api/vendor/wallet              Balance hero (avail/escrow/pending)
 *   GET    /api/vendor/transactions        Filterable activity log
 *   GET    /api/vendor/transactions/:id    Single tx detail
 *   GET    /api/vendor/earnings/periods    Bar-chart data (today/week/month)
 *   GET    /api/vendor/payouts             Withdrawal history list
 *   GET    /api/vendor/payouts/:id         Single payout detail
 *   GET    /api/vendor/banks/saved         Saved bank accounts
 *   POST   /api/vendor/banks/saved         Add a bank account (with BVN-match)
 *   PATCH  /api/vendor/banks/saved/:id/primary  Mark primary
 *   DELETE /api/vendor/banks/saved/:id     Remove (not if primary + only one)
 */
const router = Router();

// ===================== WALLET (vendor breakdown) =====================
/**
 * GET /api/vendor/wallet
 *
 * Returns:
 *   available — withdrawable balance (Wallet.available)
 *   pending   — held escrow waiting on customer delivery confirm
 *               (Wallet.pending, populated by orders mid-flight)
 *   escrow    — money sent to plants but not yet released
 *               (bulk POs that are paid + step < offloaded)
 *
 * The escrow figure isn't a wallet column today; we derive it from
 * FuelPlantOrders the vendor has paid into but haven't reconciled.
 * Once Phase-4's reconcile fires, money flows back to the plant
 * outside our ledger (we don't custody it), so the figure is
 * "money I've committed but can't yet recall".
 */
router.get("/wallet", requireAuth, requireVendor, async (req, res) => {
  try {
    const wallet = await getOrCreateUserWallet(req.userId!);

    // Sum bulk POs paid but not yet closed.
    const escrowAgg = await FuelPlantOrder.aggregate([
      {
        $match: {
          vendor: new mongoose.Types.ObjectId(req.userId!),
          paymentStatus: "paid",
          status: { $nin: ["delivered", "cancelled"] },
        },
      },
      { $group: { _id: null, total: { $sum: "$totalCost" } } },
    ]);
    const escrow = escrowAgg[0]?.total ?? 0;

    res.json({
      walletId: wallet._id,
      available: wallet.available,
      pending: wallet.pending,
      escrow,
      currency: wallet.currency,
    });
  } catch (err) {
    console.error("[vendor/wallet]", err);
    res.status(500).json({ message: "Failed to load wallet" });
  }
});

// ===================== TRANSACTIONS LIST =====================
/**
 * GET /api/vendor/transactions?filter=all|orders|bulk|payouts|topups
 *
 * Returns preformatted preview rows ready for the TxRow component:
 *   { id, dateIso, kind, type, description, amount, amountFormatted,
 *     signed, status, orderRef?, bulkRef?, withdrawalRef? }
 */
type TxFilter =
  | "all"
  | "orders"
  | "bulk"
  | "payouts"
  | "topups"
  // Design-aligned filters (v7) — sit alongside the legacy keys so the
  // old transactions screen keeps working while the new UI rolls out.
  | "credit"
  | "payout"
  | "hold"
  | "debit";

const FILTER_KINDS: Record<TxFilter, string[] | null> = {
  all: null,
  // Legacy
  orders: ["vendor_earning_credit", "order_charge_credit", "refund_credit"],
  bulk: ["escrow_release_debit"],
  payouts: ["withdraw_debit", "withdraw_fee_debit", "withdraw_reversal_credit"],
  topups: ["topup_credit"],
  // v7 design semantics
  credit: [
    "vendor_earning_credit",
    "order_charge_credit",
    "refund_credit",
    "topup_credit",
    "withdraw_reversal_credit",
  ],
  payout: ["withdraw_debit"],
  hold: ["escrow_release_debit"], // escrow holds will share this bucket
  debit: ["withdraw_fee_debit", "admin_adjust"],
};

router.get("/transactions", requireAuth, requireVendor, async (req, res) => {
  try {
    const wallet = await getOrCreateUserWallet(req.userId!);
    const {
      filter = "all",
      page = "1",
      limit = "30",
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const filterKey = (filter as TxFilter) in FILTER_KINDS
      ? (filter as TxFilter)
      : "all";
    const kinds = FILTER_KINDS[filterKey];

    const q: Record<string, unknown> = { wallet: wallet._id };
    if (kinds) q.kind = { $in: kinds };

    const [docs, total] = await Promise.all([
      Transaction.find(q)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Transaction.countDocuments(q),
    ]);

    const rows = docs.map((tx: any) => {
      const amount = Number(tx.amount ?? 0);
      const sign = amount >= 0 ? "+" : "−";
      return {
        id: String(tx._id),
        dateIso: tx.createdAt,
        kind: tx.kind,
        // Human "type" derived from kind for the TxRow secondary text.
        type: humanType(tx.kind),
        description: tx.description || humanType(tx.kind),
        amount,
        amountFormatted: `${sign}₦${Math.abs(amount).toLocaleString("en-NG")}`,
        signed: amount >= 0 ? "credit" : "debit",
        state: tx.state,
        orderRef: tx.order ? String(tx.order) : null,
        withdrawalRef: tx.withdrawal ? String(tx.withdrawal) : null,
        paystackRef: tx.paystackRef ?? null,
      };
    });

    res.json({
      transactions: rows,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    console.error("[vendor/transactions]", err);
    res.status(500).json({ message: "Failed to fetch transactions" });
  }
});

function humanType(kind: string): string {
  switch (kind) {
    case "vendor_earning_credit":
      return "Order earning";
    case "topup_credit":
      return "Top-up";
    case "refund_credit":
      return "Refund";
    case "withdraw_debit":
      return "Withdrawal";
    case "withdraw_fee_debit":
      return "Withdrawal fee";
    case "withdraw_reversal_credit":
      return "Withdrawal reversed";
    case "escrow_release_debit":
      return "Bulk payment";
    case "order_charge_credit":
      return "Order paid";
    case "platform_commission_credit":
      return "Platform commission";
    case "admin_adjust":
      return "Adjustment";
    default:
      return kind.replace(/_/g, " ");
  }
}

// ===================== TRANSACTION DETAIL =====================
router.get("/transactions/:id", requireAuth, requireVendor, async (req, res) => {
  try {
    const idStr = Array.isArray(req.params.id)
      ? req.params.id[0]
      : (req.params.id as string);
    const wallet = await getOrCreateUserWallet(req.userId!);
    const tx = (await Transaction.findOne({
      _id: idStr,
      wallet: wallet._id,
    })
      .populate({
        path: "order",
        select: "totalPrice fuelCost deliveryFee serviceFee status user fuel quantity",
        populate: [
          { path: "fuel", select: "name unit" },
          { path: "user", select: "displayName phone" },
        ],
      })
      .populate({ path: "withdrawal", select: "amount status bankAccount processedAt" })
      .lean()) as any;
    if (!tx) return res.status(404).json({ message: "Transaction not found" });
    res.json(tx);
  } catch (err) {
    console.error("[vendor/transactions/:id]", err);
    res.status(500).json({ message: "Failed to fetch transaction" });
  }
});

// ===================== EARNINGS PERIODS (bar chart) =====================
/**
 * GET /api/vendor/earnings/periods?period=today|week|month
 *
 * Returns:
 *   period:    chosen period
 *   buckets:   { label, value }[]   — N bars (today=hours, week=7 days,
 *               month=4 weeks)
 *   total:     sum of all buckets
 *   periodAvg: total / N
 *   breakdown: per-product split (Petrol/Diesel/Gas/Kero × value)
 *
 * Source: Transaction rows where kind="vendor_earning_credit" within
 * the period window.
 */
type Period = "today" | "week" | "month";

const LAGOS_OFFSET_MIN = -60;

function startOfLagosDay(d: Date): Date {
  const local = new Date(d.getTime() - LAGOS_OFFSET_MIN * 60_000);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) +
      LAGOS_OFFSET_MIN * 60_000,
  );
}

router.get("/earnings/periods", requireAuth, requireVendor, async (req, res) => {
  try {
    const { period = "today" } = req.query as { period?: Period };
    const wallet = await getOrCreateUserWallet(req.userId!);
    const todayStart = startOfLagosDay(new Date());

    let windowStart: Date;
    let bucketCount: number;
    let labelFor: (i: number) => string;
    let bucketBoundaries: (i: number) => { start: Date; end: Date };

    if (period === "today") {
      windowStart = todayStart;
      bucketCount = 6; // 4-hour buckets
      labelFor = (i) =>
        ["12a", "4a", "8a", "12p", "4p", "8p"][i] ?? `${i * 4}h`;
      bucketBoundaries = (i) => ({
        start: new Date(todayStart.getTime() + i * 4 * 60 * 60 * 1000),
        end: new Date(todayStart.getTime() + (i + 1) * 4 * 60 * 60 * 1000),
      });
    } else if (period === "week") {
      windowStart = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);
      bucketCount = 7;
      labelFor = (i) => {
        const d = new Date(windowStart.getTime() + i * 24 * 60 * 60 * 1000);
        return d.toLocaleDateString("en-NG", { weekday: "short" });
      };
      bucketBoundaries = (i) => {
        const s = new Date(windowStart.getTime() + i * 24 * 60 * 60 * 1000);
        const e = new Date(s.getTime() + 24 * 60 * 60 * 1000);
        return { start: s, end: e };
      };
    } else {
      windowStart = new Date(todayStart.getTime() - 28 * 24 * 60 * 60 * 1000);
      bucketCount = 4;
      labelFor = (i) => `W${i + 1}`;
      bucketBoundaries = (i) => {
        const s = new Date(windowStart.getTime() + i * 7 * 24 * 60 * 60 * 1000);
        const e = new Date(s.getTime() + 7 * 24 * 60 * 60 * 1000);
        return { start: s, end: e };
      };
    }

    // Fetch all earning credits in the window once; bucket in JS.
    const docs = await Transaction.find({
      wallet: wallet._id,
      kind: "vendor_earning_credit",
      createdAt: { $gte: windowStart },
    })
      .populate("order", "fuelCost fuel")
      .populate({ path: "order", populate: { path: "fuel", select: "name" } })
      .lean();

    const buckets: { label: string; value: number }[] = Array.from({
      length: bucketCount,
    }).map((_, i) => ({ label: labelFor(i), value: 0 }));

    const breakdown: Record<string, number> = {};

    for (const tx of docs as any[]) {
      const created = new Date(tx.createdAt).getTime();
      for (let i = 0; i < bucketCount; i += 1) {
        const { start, end } = bucketBoundaries(i);
        if (created >= start.getTime() && created < end.getTime()) {
          buckets[i].value += Math.max(0, Number(tx.amount ?? 0));
          break;
        }
      }
      const fuelName = tx.order?.fuel?.name ?? "Other";
      breakdown[fuelName] =
        (breakdown[fuelName] ?? 0) + Math.max(0, Number(tx.amount ?? 0));
    }

    const total = buckets.reduce((acc, b) => acc + b.value, 0);
    const periodAvg = bucketCount > 0 ? Math.round(total / bucketCount) : 0;

    // Previous-period total — same-shape window immediately preceding
    // `windowStart`. Drives the "▲ N% vs last week" delta on the
    // earnings hero.
    const windowSpanMs = (() => {
      const { start: firstStart } = bucketBoundaries(0);
      const { end: lastEnd } = bucketBoundaries(bucketCount - 1);
      return lastEnd.getTime() - firstStart.getTime();
    })();
    const prevStart = new Date(windowStart.getTime() - windowSpanMs);
    const prevAgg = await Transaction.aggregate([
      {
        $match: {
          wallet: wallet._id,
          kind: "vendor_earning_credit",
          createdAt: { $gte: prevStart, $lt: windowStart },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const prevTotal = prevAgg[0]?.total ?? 0;

    res.json({
      period,
      buckets,
      total,
      periodAvg,
      prevTotal,
      breakdown: Object.entries(breakdown).map(([label, value]) => ({
        label,
        value,
      })),
    });
  } catch (err) {
    console.error("[vendor/earnings/periods]", err);
    res.status(500).json({ message: "Failed to fetch earnings" });
  }
});

// ===================== PAYOUTS LIST =====================
/**
 * GET /api/vendor/payouts?status=
 *
 * Vendor's withdrawal history. Status maps directly to Withdrawal
 * enum: pending | approved | rejected | processing | failed.
 * "paid" is a synthetic ui status meaning processed + delivered;
 * we expose it by treating status="processed" as paid.
 */
router.get("/payouts", requireAuth, requireVendor, async (req, res) => {
  try {
    const {
      status,
      page = "1",
      limit = "30",
    } = req.query as Record<string, string>;
    const q: Record<string, unknown> = { user: req.userId, role: "vendor" };
    if (status) q.status = status;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const [docs, total] = await Promise.all([
      Withdrawal.find(q)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Withdrawal.countDocuments(q),
    ]);

    // P1-MF-5 (audit run 4): the schema field is `bankAccount`, not
    // `bankDetails`. Pre-fix every payout row showed bankName: "—",
    // accountNumber: null because the populate path was wrong. The
    // canonical field is `bankAccount` (proven by adminPayments.ts
    // which has used it correctly for months).
    const payouts = docs.map((w: any) => ({
      id: String(w._id),
      amount: w.amount,
      amountFormatted: `₦${Number(w.amount ?? 0).toLocaleString("en-NG")}`,
      status: w.status,
      bankName: w.bankAccount?.bankName ?? "—",
      accountNumber: w.bankAccount?.accountNumber ?? null,
      accountName: w.bankAccount?.accountName ?? null,
      processedAt: w.processedAt ?? null,
      createdAt: w.createdAt,
      note: w.note ?? null,
      paystackTransferCode: w.paystackTransferCode ?? null,
    }));

    res.json({
      payouts,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    console.error("[vendor/payouts]", err);
    res.status(500).json({ message: "Failed to fetch payouts" });
  }
});

// ===================== PAYOUT DETAIL =====================
router.get("/payouts/:id", requireAuth, requireVendor, async (req, res) => {
  try {
    const idStr = Array.isArray(req.params.id)
      ? req.params.id[0]
      : (req.params.id as string);
    const doc = (await Withdrawal.findOne({
      _id: idStr,
      user: req.userId,
      role: "vendor",
    }).lean()) as any;
    if (!doc) return res.status(404).json({ message: "Payout not found" });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch payout" });
  }
});

// ===================== SAVED BANKS LIST =====================
router.get("/banks/saved", requireAuth, requireVendor, async (req, res) => {
  try {
    const { stationId } = req.query as { stationId?: string };
    const q: Record<string, unknown> = { user: req.userId };
    if (stationId) {
      q.station = new mongoose.Types.ObjectId(stationId);
    }
    const accounts = await BankAccount.find(q)
      .sort({ isPrimary: -1, createdAt: -1 })
      .populate("station", "name")
      .lean();
    res.json({ accounts });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch banks" });
  }
});

// ===================== ADD SAVED BANK =====================
/**
 * POST /api/vendor/banks/saved { bankName, bankCode, accountNumber }
 *
 * Verifies via Paystack resolve to confirm the account-name match,
 * stores the result. Marks primary if this is the user's first bank.
 */
router.post("/banks/saved", requireAuth, requireVendor, async (req, res) => {
  try {
    const { bankName, bankCode, accountNumber, stationId } = req.body as {
      bankName?: string;
      bankCode?: string;
      accountNumber?: string;
      stationId?: string;
    };
    if (!bankName || !bankCode || !accountNumber || !stationId) {
      return res.status(400).json({
        message:
          "bankName, bankCode, accountNumber, stationId required",
      });
    }

    // Confirm the station belongs to this vendor.
    const GasStation = (await import("../models/Station")).default;
    const station = await GasStation.findOne({
      _id: stationId,
      vendorId: req.userId,
    }).lean();
    if (!station) {
      return res.status(404).json({
        message: "Station not found or not owned by you",
      });
    }

    // Paystack resolve — confirms the account exists at that bank +
    // returns the registered account holder name.
    let accountName: string;
    try {
      const result = await resolveBankAccount({
        account_number: accountNumber,
        bank_code: bankCode,
      });
      accountName = (result as any).account_name ?? "";
      if (!accountName) {
        return res.status(400).json({
          message: "Couldn't verify account. Check details.",
        });
      }
    } catch {
      return res.status(400).json({
        message: "Couldn't verify account. Check the details and try again.",
      });
    }

    // Dedupe — same bank + account already saved.
    const existing = await BankAccount.findOne({
      user: req.userId,
      bankCode,
      accountNumber,
    });
    if (existing) {
      return res.status(409).json({
        message: "This bank account is already saved.",
      });
    }

    // First saved bank FOR THIS STATION → primary for that station.
    const stationCount = await BankAccount.countDocuments({
      user: req.userId,
      station: stationId,
    });
    const account = await BankAccount.create({
      user: req.userId,
      station: stationId,
      bankName,
      bankCode,
      accountNumber,
      accountName,
      isPrimary: stationCount === 0,
      bvnVerified: false,
    });
    res.status(201).json({ account });
  } catch (err) {
    console.error("[vendor/banks/saved POST]", err);
    res.status(500).json({ message: "Failed to add bank" });
  }
});

// ===================== MARK PRIMARY =====================
router.patch(
  "/banks/saved/:id/primary",
  requireAuth,
  requireVendor,
  async (req, res) => {
    try {
      const idStr = Array.isArray(req.params.id)
        ? req.params.id[0]
        : (req.params.id as string);
      const target = await BankAccount.findOne({
        _id: idStr,
        user: req.userId,
      });
      if (!target) return res.status(404).json({ message: "Bank not found" });
      if (target.isPrimary) {
        return res.json({ account: target });
      }
      // Scope the "only one primary" rule to this bank's station, so
      // setting a primary for Station A doesn't disturb Station B's
      // primary. Legacy rows with no station still demote across all
      // user-owned legacy rows.
      const peerFilter: Record<string, unknown> = { user: req.userId };
      if (target.station) {
        peerFilter.station = target.station;
      } else {
        peerFilter.station = { $exists: false };
      }
      await BankAccount.updateMany(peerFilter, {
        $set: { isPrimary: false },
      });
      target.isPrimary = true;
      await target.save();
      res.json({ account: target });
    } catch (err) {
      res.status(500).json({ message: "Failed to set primary" });
    }
  },
);

// ===================== DELETE SAVED BANK =====================
router.delete("/banks/saved/:id", requireAuth, requireVendor, async (req, res) => {
  try {
    const idStr = Array.isArray(req.params.id)
      ? req.params.id[0]
      : (req.params.id as string);
    const account = await BankAccount.findOne({
      _id: idStr,
      user: req.userId,
    });
    if (!account) return res.status(404).json({ message: "Bank not found" });
    if (account.isPrimary) {
      const count = await BankAccount.countDocuments({ user: req.userId });
      if (count <= 1) {
        return res.status(409).json({
          message: "Can't delete your only bank. Add another first.",
        });
      }
      return res.status(409).json({
        message: "Mark a different bank primary before deleting this one.",
      });
    }
    await account.deleteOne();
    res.json({ message: "Removed" });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete bank" });
  }
});

export default router;
