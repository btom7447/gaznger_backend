import mongoose, { Schema, Document } from "mongoose";

/**
 * Immutable money-movement ledger. Every credit/debit on a Wallet writes
 * exactly one Transaction row. Reversals are NEW rows that reference the
 * original via `reverses` — never edit/delete an existing Transaction.
 *
 * Each Transaction is a single-leg entry (one wallet, one signed amount).
 * Money moves between wallets are written as TWO Transaction rows sharing
 * a `groupId`: a debit on the source wallet and a credit on the dest. Use
 * `utils/wallet.ts` `postTransfer` to keep the pair atomic.
 *
 * Money is stored in NGN whole units (matches Order.totalPrice convention).
 * Idempotency: callers pass `idempotencyKey` (header-sourced UUID) — server
 * dedupes within 24h via the unique index on (idempotencyKey).
 */
export type TransactionKind =
  // Customer-side
  | "topup_credit"          // wallet ← Paystack (top up)
  | "order_charge_credit"   // escrow ← Paystack (order paid via card/transfer)
  | "order_wallet_debit"    // wallet → escrow (order paid via wallet credit)
  | "points_redeem"         // virtual: marks a points-funded discount on an order
  | "refund_credit"         // wallet ← escrow on refund
  // Settle-side
  | "escrow_release_debit"  // escrow → vendor + rider + platform-revenue
  | "vendor_earning_credit" // vendor wallet ←
  | "rider_earning_credit"  // rider wallet ←
  | "platform_commission_credit" // platform-revenue ←
  // Withdraw-side
  | "withdraw_debit"        // wallet → Paystack (transfer initiated)
  | "withdraw_fee_debit"    // wallet → platform-revenue (Paystack fee passed on)
  | "withdraw_reversal_credit" // wallet ← (transfer failed, restore funds)
  // Adjust
  | "admin_adjust";

export type TransactionState =
  /** Posted to `pending`. Used for held escrow funds before delivery confirm. */
  | "pending"
  /** Posted to `available`. Withdrawable / spendable. */
  | "available";

export interface ITransaction extends Document {
  /** Affected wallet. */
  wallet: mongoose.Types.ObjectId;
  /** Owning user (or null for system wallets). Denormalized for queries. */
  user: mongoose.Types.ObjectId | null;
  /** Signed amount in NGN. Positive = credit. Negative = debit. */
  amount: number;
  /** Bucket the amount lands in / leaves from on the wallet. */
  state: TransactionState;
  kind: TransactionKind;
  description: string;

  /** Pairs the two legs of an inter-wallet transfer. */
  groupId: string;
  /** Caller-supplied idempotency key (UUID v4). Same key → same Transaction. */
  idempotencyKey?: string;
  /** When this row reverses an earlier row, the original's _id. */
  reverses?: mongoose.Types.ObjectId;

  // Optional refs for audit / UI
  order?: mongoose.Types.ObjectId;
  delivery?: mongoose.Types.ObjectId;
  withdrawal?: mongoose.Types.ObjectId;
  dispute?: mongoose.Types.ObjectId;

  // Paystack envelope (raw refs, for reconciliation)
  paystackRef?: string;        // e.g. transaction reference
  paystackTransferCode?: string;
  paystackEventId?: string;    // webhook event id

  /** Free-form metadata (commission rate snapshot, splits, etc.). */
  meta?: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
}

const TransactionSchema: Schema<ITransaction> = new Schema(
  {
    wallet: { type: Schema.Types.ObjectId, ref: "Wallet", required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
    amount: { type: Number, required: true },
    state: { type: String, enum: ["pending", "available"], required: true },
    kind: {
      type: String,
      enum: [
        "topup_credit",
        "order_charge_credit",
        "order_wallet_debit",
        "points_redeem",
        "refund_credit",
        "escrow_release_debit",
        "vendor_earning_credit",
        "rider_earning_credit",
        "platform_commission_credit",
        "withdraw_debit",
        "withdraw_fee_debit",
        "withdraw_reversal_credit",
        "admin_adjust",
      ],
      required: true,
    },
    description: { type: String, default: "" },

    groupId: { type: String, required: true },
    idempotencyKey: { type: String },
    reverses: { type: Schema.Types.ObjectId, ref: "Transaction" },

    order: { type: Schema.Types.ObjectId, ref: "Order" },
    delivery: { type: Schema.Types.ObjectId, ref: "Delivery" },
    withdrawal: { type: Schema.Types.ObjectId, ref: "Withdrawal" },
    dispute: { type: Schema.Types.ObjectId, ref: "Dispute" },

    paystackRef: { type: String },
    paystackTransferCode: { type: String },
    paystackEventId: { type: String },

    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

// Idempotency: a key can appear at most once across the ledger.
TransactionSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $exists: true } } }
);

TransactionSchema.index({ wallet: 1, createdAt: -1 });
TransactionSchema.index({ user: 1, createdAt: -1 });
TransactionSchema.index({ groupId: 1 });
TransactionSchema.index({ order: 1 });
TransactionSchema.index({ paystackRef: 1 });

export default mongoose.model<ITransaction>("Transaction", TransactionSchema);
