import mongoose, { Schema, Document } from "mongoose";

export interface IWithdrawal extends Document {
  user: mongoose.Types.ObjectId;
  role: "vendor" | "rider";
  amount: number;
  status: "pending" | "approved" | "rejected" | "processing" | "failed";
  bankAccount: {
    bankName: string;
    accountNumber: string;
    accountName: string;
    bankCode?: string;
  };
  paystackTransferCode?: string;
  paystackRecipientCode?: string;
  note?: string;
  processedAt?: Date;
  /**
   * SECURITY P0 (audit run 5): stable client-supplied `Idempotency-Key`
   * header value, used by handleWithdrawRequest to short-circuit on
   * retry. Without this, a retried POST /vendor/withdraw with the
   * same UUID created a fresh _id → fresh ledger keys → double-debit
   * + double Paystack transfer. Unique sparse so historic rows
   * without the field don't collide.
   */
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const WithdrawalSchema: Schema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["vendor", "rider"], required: true },
    amount: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "processing", "failed"],
      default: "pending",
    },
    bankAccount: {
      bankName: { type: String, required: true },
      accountNumber: { type: String, required: true },
      accountName: { type: String, required: true },
      bankCode: { type: String },
    },
    paystackTransferCode: { type: String },
    paystackRecipientCode: { type: String },
    note: { type: String },
    processedAt: { type: Date },
    idempotencyKey: { type: String },
  },
  { timestamps: true }
);

WithdrawalSchema.index({ user: 1, status: 1 });
// SECURITY P0 (audit run 5): unique sparse on (user, idempotencyKey)
// so retries of the same logical withdraw request collapse to one
// Withdrawal row. Sparse means historic rows without the field don't
// collide. Per-user scope means two different users can use the same
// client-supplied UUID without colliding (UUIDs are not meant to be
// globally unique across actors in this protocol).
WithdrawalSchema.index(
  { user: 1, idempotencyKey: 1 },
  { unique: true, sparse: true },
);

export default mongoose.model<IWithdrawal>("Withdrawal", WithdrawalSchema);
