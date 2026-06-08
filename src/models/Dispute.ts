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
  /** Destination of the refund leg ("wallet" = instant, "card" = async via Paystack). */
  refundDestination?: "wallet" | "card";
  /**
   * Lifecycle of the refund leg specifically (separate from the dispute
   * `status`). Wallet refunds flip straight to "succeeded"; card refunds
   * sit at "pending" until the Paystack `refund.processed` (or `.failed`)
   * webhook arrives. Surfaces a Retry button in the admin UI when the
   * webhook never lands.
   */
  refundStatus?: "pending" | "succeeded" | "failed";
  /** When the refund leg was initiated (drives a "stuck X minutes" badge). */
  refundInitiatedAt?: Date;
  /** Failure reason from Paystack when refundStatus = "failed". */
  refundFailReason?: string;

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
    refundDestination: { type: String, enum: ["wallet", "card"] },
    refundStatus: {
      type: String,
      enum: ["pending", "succeeded", "failed"],
    },
    refundInitiatedAt: { type: Date },
    refundFailReason: { type: String },
  },
  { timestamps: true }
);

DisputeSchema.index({ order: 1 }, { unique: true });
DisputeSchema.index({ status: 1, createdAt: -1 });
DisputeSchema.index({ raisedBy: 1, createdAt: -1 });

export default mongoose.model<IDispute>("Dispute", DisputeSchema);
