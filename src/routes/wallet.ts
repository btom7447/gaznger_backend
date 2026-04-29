import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth";
import Transaction from "../models/Transaction";
import { getOrCreateUserWallet } from "../utils/wallet";

const router = Router();

/**
 * GET /api/wallet/me
 * Returns the caller's wallet balances (creates the doc if missing).
 */
router.get("/me", requireAuth, async (req, res) => {
  try {
    const wallet = await getOrCreateUserWallet(req.userId!);
    res.json({
      walletId: wallet._id,
      available: wallet.available,
      pending: wallet.pending,
      currency: wallet.currency,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load wallet" });
  }
});

/**
 * GET /api/wallet/transactions
 * Paginated ledger for the caller. Cursor = ISO createdAt of the last row.
 */
router.get("/transactions", requireAuth, async (req, res) => {
  try {
    const wallet = await getOrCreateUserWallet(req.userId!);
    const limit = Math.min(parseInt((req.query.limit as string) ?? "20", 10), 100);
    const cursor = req.query.cursor as string | undefined;

    const filter: any = { wallet: wallet._id };
    if (cursor) {
      const ts = new Date(cursor);
      if (!Number.isNaN(ts.getTime())) {
        filter.createdAt = { $lt: ts };
      }
    }

    const rows = await Transaction.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore
      ? slice[slice.length - 1].createdAt.toISOString()
      : null;

    res.json({
      transactions: slice.map((r) => ({
        id: r._id,
        amount: r.amount,
        state: r.state,
        kind: r.kind,
        description: r.description,
        order: r.order ?? null,
        delivery: r.delivery ?? null,
        withdrawal: r.withdrawal ?? null,
        dispute: r.dispute ?? null,
        createdAt: r.createdAt,
      })),
      nextCursor,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load transactions" });
  }
});

export default router;
