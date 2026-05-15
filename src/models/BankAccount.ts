import mongoose, { Schema, Document } from "mongoose";

/**
 * Saved bank account for payouts. Vendors (and riders eventually) can
 * link multiple accounts and mark one as `primary`. Withdrawals use the
 * primary by default unless the caller passes an explicit `bankAccountId`.
 *
 * BVN match check happens at create time via Paystack resolve. We store
 * only the verified `accountName` returned by the bank lookup — never
 * the BVN itself; that's a regulated identifier we don't keep at rest.
 */
export interface IBankAccount extends Document {
  user: mongoose.Types.ObjectId;
  /** Bank short name (display). */
  bankName: string;
  /** Paystack/CBN bank code (e.g. "058" for GTBank). */
  bankCode: string;
  /** 10-digit NUBAN. */
  accountNumber: string;
  /** Verified holder name from `paystack/bank/resolve`. */
  accountName: string;
  /** Paystack transfer-recipient code (cached after first successful withdraw). */
  paystackRecipientCode?: string;
  /** Whether this account is the default for payouts. */
  isPrimary: boolean;
  /** BVN-match verification result. */
  bvnVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const BankAccountSchema: Schema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    bankName: { type: String, required: true },
    bankCode: { type: String, required: true },
    accountNumber: { type: String, required: true },
    accountName: { type: String, required: true },
    paystackRecipientCode: { type: String },
    isPrimary: { type: Boolean, default: false },
    bvnVerified: { type: Boolean, default: false },
  },
  { timestamps: true },
);

BankAccountSchema.index({ user: 1 });
BankAccountSchema.index(
  { user: 1, isPrimary: 1 },
  { partialFilterExpression: { isPrimary: true } },
);
BankAccountSchema.index(
  { user: 1, bankCode: 1, accountNumber: 1 },
  { unique: true },
);

export default mongoose.model<IBankAccount>("BankAccount", BankAccountSchema);
