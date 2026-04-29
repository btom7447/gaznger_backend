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
  },
  { timestamps: true }
);

WithdrawalSchema.index({ user: 1, status: 1 });

export default mongoose.model<IWithdrawal>("Withdrawal", WithdrawalSchema);
