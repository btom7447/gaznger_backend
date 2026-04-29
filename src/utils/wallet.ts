import mongoose from "mongoose";
import { v4 as uuidv4 } from "uuid";
import Wallet, {
  IWallet,
  WalletSystemKind,
} from "../models/Wallet";
import Transaction, {
  ITransaction,
  TransactionKind,
  TransactionState,
} from "../models/Transaction";
import User from "../models/User";

/**
 * Wallet ledger helpers.
 *
 * Invariants:
 *   1. Every change to Wallet.available / Wallet.pending writes a paired
 *      Transaction row in the same call. Never mutate the wallet directly.
 *   2. Inter-wallet movements (`postTransfer`) are two rows sharing a
 *      `groupId`: one debit, one credit. Same `idempotencyKey` returns
 *      the existing pair instead of double-posting.
 *   3. Money is NGN whole units. Kobo conversion is the Paystack boundary's
 *      job, never the ledger's.
 *
 * Concurrency: we use atomic `$inc` on the wallet so two simultaneous
 * postings can't lose a write. We do NOT enforce non-negative balances
 * via the DB layer — the caller checks `available` first when debiting
 * a user wallet. System wallets (escrow / revenue) can legitimately go
 * negative briefly during reconciliation.
 */

/* ────────────────────────────── Wallet lookups ───────────────────── */

/**
 * Get-or-create the wallet for a real user. Idempotent — concurrent
 * callers race the unique index and the loser falls back to the
 * existing doc.
 */
export async function getOrCreateUserWallet(
  userId: string | mongoose.Types.ObjectId
): Promise<IWallet> {
  const _id = typeof userId === "string"
    ? new mongoose.Types.ObjectId(userId)
    : userId;

  const existing = await Wallet.findOne({ user: _id, ownerKind: "user" });
  if (existing) return existing;

  // Need the user's role for denormalization.
  const user = await User.findById(_id).select("role").lean();
  const role = user?.role ?? "customer";

  try {
    return await Wallet.create({
      user: _id,
      ownerKind: "user",
      role,
      available: 0,
      pending: 0,
    });
  } catch (err: any) {
    // Lost the race — return the doc the winner created.
    if (err?.code === 11000) {
      const w = await Wallet.findOne({ user: _id, ownerKind: "user" });
      if (w) return w;
    }
    throw err;
  }
}

/** Get-or-create one of the system wallets (escrow / revenue). */
export async function getOrCreateSystemWallet(
  systemKind: WalletSystemKind
): Promise<IWallet> {
  const existing = await Wallet.findOne({ ownerKind: "system", systemKind });
  if (existing) return existing;

  try {
    return await Wallet.create({
      user: null,
      ownerKind: "system",
      systemKind,
      available: 0,
      pending: 0,
    });
  } catch (err: any) {
    if (err?.code === 11000) {
      const w = await Wallet.findOne({ ownerKind: "system", systemKind });
      if (w) return w;
    }
    throw err;
  }
}

/* ────────────────────────────── Idempotency ──────────────────────── */

/**
 * Look up a previous Transaction by idempotency key. Returns the matching
 * row or null. Callers use this to short-circuit a retried request.
 */
export async function findByIdempotencyKey(
  key: string
): Promise<ITransaction[]> {
  if (!key) return [];
  // A multi-leg post (e.g. transfer) writes ≥2 rows sharing the key —
  // composite keys on each leg's `groupId-leg` keep them unique while
  // sharing the user-facing idempotency key via `meta`.
  return Transaction.find({ idempotencyKey: key }).sort({ createdAt: 1 });
}

/* ────────────────────────────── Postings ─────────────────────────── */

export interface PostingOpts {
  /** UUID v4 from the Idempotency-Key header. Strongly recommended. */
  idempotencyKey?: string;
  description?: string;
  groupId?: string;
  order?: mongoose.Types.ObjectId;
  delivery?: mongoose.Types.ObjectId;
  withdrawal?: mongoose.Types.ObjectId;
  dispute?: mongoose.Types.ObjectId;
  paystackRef?: string;
  paystackTransferCode?: string;
  paystackEventId?: string;
  meta?: Record<string, unknown>;
  /** When this is a reversal, the original transaction's _id. */
  reverses?: mongoose.Types.ObjectId;
}

/**
 * Single-wallet posting (e.g. customer charge → escrow). Atomically:
 *   1. $inc the wallet's pending or available bucket
 *   2. write the matching Transaction
 *
 * Returns the new Transaction. If `idempotencyKey` matches an existing
 * row, that row is returned instead and no balance change is made.
 *
 * `amount` is signed: positive credits the bucket, negative debits.
 */
export async function postSingle(args: {
  wallet: IWallet;
  amount: number;
  state: TransactionState;
  kind: TransactionKind;
  opts?: PostingOpts;
}): Promise<ITransaction> {
  const { wallet, amount, state, kind, opts = {} } = args;

  if (opts.idempotencyKey) {
    const prior = await findByIdempotencyKey(opts.idempotencyKey);
    const match = prior.find((p) => p.wallet.toString() === (wallet._id as any).toString());
    if (match) return match;
  }

  const groupId = opts.groupId ?? uuidv4();
  const bucket = state === "pending" ? "pending" : "available";

  // Atomic balance bump.
  await Wallet.updateOne(
    { _id: wallet._id },
    { $inc: { [bucket]: amount } }
  );

  const tx = await Transaction.create({
    wallet: wallet._id,
    user: wallet.user,
    amount,
    state,
    kind,
    description: opts.description ?? "",
    groupId,
    idempotencyKey: opts.idempotencyKey,
    reverses: opts.reverses,
    order: opts.order,
    delivery: opts.delivery,
    withdrawal: opts.withdrawal,
    dispute: opts.dispute,
    paystackRef: opts.paystackRef,
    paystackTransferCode: opts.paystackTransferCode,
    paystackEventId: opts.paystackEventId,
    meta: opts.meta,
  });

  return tx;
}

/**
 * Move money between two wallets. Writes a debit on `from` and a credit
 * on `to`, sharing a `groupId`. Both legs land in the same `state`
 * (typically "available" — escrow holds use a separate `postSingle`
 * pattern: charge→escrow.pending, then escrow.pending→escrow.available
 * on release before splitting).
 *
 * Idempotency: if `idempotencyKey` matches a prior pair, the existing
 * pair is returned and no balance change is made.
 */
export async function postTransfer(args: {
  from: IWallet;
  to: IWallet;
  amount: number; // positive
  state: TransactionState;
  /** Two-element tuple: [debit kind, credit kind]. */
  kinds: [TransactionKind, TransactionKind];
  description?: string;
  opts?: PostingOpts;
}): Promise<{ debit: ITransaction; credit: ITransaction }> {
  const { from, to, amount, state, kinds, description, opts = {} } = args;
  if (amount <= 0) throw new Error("postTransfer: amount must be positive");

  if (opts.idempotencyKey) {
    const prior = await findByIdempotencyKey(opts.idempotencyKey);
    if (prior.length >= 2) {
      const debit = prior.find((p) => p.amount < 0);
      const credit = prior.find((p) => p.amount > 0);
      if (debit && credit) return { debit, credit };
    }
  }

  const groupId = opts.groupId ?? uuidv4();

  const debit = await postSingle({
    wallet: from,
    amount: -amount,
    state,
    kind: kinds[0],
    opts: { ...opts, groupId, description: description ?? opts.description },
  });
  const credit = await postSingle({
    wallet: to,
    amount: amount,
    state,
    kind: kinds[1],
    opts: {
      ...opts,
      groupId,
      description: description ?? opts.description,
      // Idempotency key was claimed by the debit leg; use composite for credit.
      idempotencyKey: opts.idempotencyKey
        ? `${opts.idempotencyKey}:credit`
        : undefined,
    },
  });

  return { debit, credit };
}

/**
 * Move money from one bucket to another on the SAME wallet (e.g. release
 * escrow.pending → escrow.available). Two ledger rows: debit pending,
 * credit available, sharing a groupId. Net zero balance change.
 */
export async function postBucketShift(args: {
  wallet: IWallet;
  amount: number; // positive
  fromState: TransactionState;
  toState: TransactionState;
  kind: TransactionKind;
  description?: string;
  opts?: PostingOpts;
}): Promise<{ outRow: ITransaction; inRow: ITransaction }> {
  const { wallet, amount, fromState, toState, kind, description, opts = {} } = args;
  if (amount <= 0) throw new Error("postBucketShift: amount must be positive");
  if (fromState === toState) throw new Error("postBucketShift: states must differ");

  const groupId = opts.groupId ?? uuidv4();

  const outRow = await postSingle({
    wallet,
    amount: -amount,
    state: fromState,
    kind,
    opts: { ...opts, groupId, description },
  });
  const inRow = await postSingle({
    wallet,
    amount: amount,
    state: toState,
    kind,
    opts: {
      ...opts,
      groupId,
      description,
      idempotencyKey: opts.idempotencyKey
        ? `${opts.idempotencyKey}:in`
        : undefined,
    },
  });

  return { outRow, inRow };
}
