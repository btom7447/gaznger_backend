import mongoose, { Schema, Document } from "mongoose";

/**
 * Customer-raised problem report on an order. Opening a dispute freezes
 * the order's escrow release until admin resolves it (resolve = release
 * with optional refund split, reject = release as normal).
 */
export type DisputeReason =
  | "not_delivered"
  | "wrong_item"
  | "short_quantity"
  | "damaged"
  | "rider_issue"
  | "other";

export type DisputeStatus = "open" | "resolved" | "rejected";

export interface IDispute extends Document {
  order: mongoose.Types.ObjectId;
  raisedBy: mongoose.Types.ObjectId;
  reason: DisputeReason;
  description: string;
  evidence: string[]; // Cloudinary URLs

  status: DisputeStatus;
  /** Admin who resolved/rejected. */
  resolver?: mongoose.Types.ObjectId;
  resolvedAt?: Date;
  resolution?: string;

  /** When status="resolved", how much was refunded to the customer (NGN). */
  refundAmount?: number;

  createdAt: Date;
  updatedAt: Date;
}

const DisputeSchema: Schema<IDispute> = new Schema(
  {
    order: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    raisedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reason: {
      type: String,
      enum: [
        "not_delivered",
        "wrong_item",
        "short_quantity",
        "damaged",
        "rider_issue",
        "other",
      ],
      required: true,
    },
    description: { type: String, default: "" },
    evidence: [{ type: String }],

    status: {
      type: String,
      enum: ["open", "resolved", "rejected"],
      default: "open",
    },
    resolver: { type: Schema.Types.ObjectId, ref: "User" },
    resolvedAt: { type: Date },
    resolution: { type: String },
    refundAmount: { type: Number },
  },
  { timestamps: true }
);

DisputeSchema.index({ order: 1 }, { unique: true });
DisputeSchema.index({ status: 1, createdAt: -1 });
DisputeSchema.index({ raisedBy: 1, createdAt: -1 });

export default mongoose.model<IDispute>("Dispute", DisputeSchema);
