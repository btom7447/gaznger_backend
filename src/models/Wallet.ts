import mongoose, { Schema, Document } from "mongoose";

/**
 * Per-user wallet. One doc per user (real users + system pseudo-users
 * "platform-escrow" and "platform-revenue", looked up by `systemKind`).
 *
 * Money is stored in NGN whole units (kobo only crosses the Paystack
 * boundary in utils/paystack.ts). Every change to `available` / `pending`
 * is paired with one or more immutable Transaction rows — never mutate
 * these fields without writing the matching ledger entry. Use
 * `utils/wallet.ts` helpers for that.
 *
 * Split balances:
 *   - `pending`   = funds in flight (held escrow, in-transit deposits)
 *   - `available` = withdrawable / spendable now
 */
export type WalletOwnerKind = "user" | "system";
export type WalletSystemKind = "platform-escrow" | "platform-revenue";

export interface IWallet extends Document {
  /** Owner — a User._id when ownerKind="user", null when ownerKind="system". */
  user: mongoose.Types.ObjectId | null;
  ownerKind: WalletOwnerKind;
  /** When ownerKind="system", which system wallet (escrow vs revenue). */
  systemKind?: WalletSystemKind;
  /** Role of the owning user (denormalized for fast queries). */
  role?: "customer" | "vendor" | "rider" | "admin";

  available: number;
  pending: number;

  currency: "NGN";
  createdAt: Date;
  updatedAt: Date;
}

const WalletSchema: Schema<IWallet> = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
    ownerKind: { type: String, enum: ["user", "system"], required: true },
    systemKind: {
      type: String,
      enum: ["platform-escrow", "platform-revenue"],
    },
    role: {
      type: String,
      enum: ["customer", "vendor", "rider", "admin"],
    },
    available: { type: Number, default: 0 },
    pending: { type: Number, default: 0 },
    currency: { type: String, enum: ["NGN"], default: "NGN" },
  },
  { timestamps: true }
);

// One wallet per user (when ownerKind="user")
WalletSchema.index(
  { user: 1 },
  { unique: true, partialFilterExpression: { ownerKind: "user" } }
);
// One wallet per system kind (when ownerKind="system")
WalletSchema.index(
  { systemKind: 1 },
  { unique: true, partialFilterExpression: { ownerKind: "system" } }
);

export default mongoose.model<IWallet>("Wallet", WalletSchema);
