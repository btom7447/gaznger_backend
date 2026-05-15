import mongoose, { Schema, Document } from "mongoose";

/**
 * Variance dispute thread on a FuelPlantOrder where the vendor's
 * offloaded volume materially differs from the plant's loaded volume.
 *
 * A dispute holds an ordered list of messages (vendor / plant /
 * system) and a coarse status:
 *   - "open"     : actively in discussion
 *   - "resolved" : both parties agreed on a settlement
 *   - "escalated": admin / Gaznger ops took over
 *
 * The PO snapshot (loaded, offloaded, variancePct) is denormalised
 * onto the dispute at create time so the chat header doesn't have to
 * re-fetch the PO on every render.
 */

export type BulkDisputeStatus = "open" | "resolved" | "escalated";
export type BulkDisputeRole = "vendor" | "plant" | "system";

export interface IBulkDisputeMessage {
  role: BulkDisputeRole;
  /** User._id reference for vendor/plant rows. Empty for system. */
  by?: mongoose.Types.ObjectId;
  body: string;
  /** Optional attachment URLs (pump photos, manifest scans). */
  attachments?: string[];
  at: Date;
}

export interface IBulkDispute extends Document {
  bulkOrder: mongoose.Types.ObjectId;
  vendor: mongoose.Types.ObjectId;
  plant?: mongoose.Types.ObjectId;
  status: BulkDisputeStatus;
  /** Snapshot at create — drives the chat header. */
  snapshot: {
    loadedQty: number;
    offloadedQty: number;
    variancePct: number;
  };
  messages: IBulkDisputeMessage[];
  resolvedAt?: Date;
  resolutionNote?: string;
  createdAt: Date;
  updatedAt: Date;
}

const BulkDisputeMessageSchema = new Schema<IBulkDisputeMessage>(
  {
    role: {
      type: String,
      enum: ["vendor", "plant", "system"],
      required: true,
    },
    by: { type: Schema.Types.ObjectId, ref: "User" },
    body: { type: String, required: true },
    attachments: [{ type: String }],
    at: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const BulkDisputeSchema: Schema = new Schema(
  {
    bulkOrder: {
      type: Schema.Types.ObjectId,
      ref: "FuelPlantOrder",
      required: true,
      unique: true,
    },
    vendor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    plant: { type: Schema.Types.ObjectId, ref: "FuelPlant" },
    status: {
      type: String,
      enum: ["open", "resolved", "escalated"],
      default: "open",
    },
    snapshot: {
      loadedQty: { type: Number, required: true },
      offloadedQty: { type: Number, required: true },
      variancePct: { type: Number, required: true },
    },
    messages: { type: [BulkDisputeMessageSchema], default: [] },
    resolvedAt: { type: Date },
    resolutionNote: { type: String },
  },
  { timestamps: true },
);

BulkDisputeSchema.index({ vendor: 1, status: 1 });

export default mongoose.model<IBulkDispute>("BulkDispute", BulkDisputeSchema);
