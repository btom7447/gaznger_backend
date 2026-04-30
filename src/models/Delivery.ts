import mongoose, { Schema, Document } from "mongoose";

/**
 * Delivery status mirrors the rider's view of the order. Spans
 * legacy values (`accepted` / `picked_up`) and the v3 granular
 * pipeline (`at_plant` / `refilling` / `returning` / `arrived` /
 * `dispensing`). Both coexist so the legacy rider app keeps working
 * during the granular rollout — old clients drive the legacy path
 * via /pickup + /complete, new clients drive the granular path via
 * the new endpoints.
 */
export type DeliveryStatus =
  | "pending"
  | "accepted"
  | "picked_up"
  | "at_plant"
  | "refilling"
  | "returning"
  | "arrived"
  | "dispensing"
  | "awaiting_confirmation"
  | "delivered"
  | "dropped"
  | "failed";

export interface IDelivery extends Document {
  order: mongoose.Types.ObjectId;
  rider: mongoose.Types.ObjectId;
  station: mongoose.Types.ObjectId;
  status: DeliveryStatus;
  pickupTime?: Date;
  deliveryTime?: Date;
  customerConfirmedAt?: Date;
  proofOfDelivery: string[];
  riderEarnings: number;
  platformEarnings: number;
  riderNotes?: string;
  dropReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const DeliverySchema: Schema = new Schema(
  {
    order: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    rider: { type: Schema.Types.ObjectId, ref: "User", required: true },
    station: { type: Schema.Types.ObjectId, ref: "GasStation", required: true },
    status: {
      type: String,
      enum: [
        "pending",
        "accepted",
        "picked_up",
        "at_plant",
        "refilling",
        "returning",
        "arrived",
        "dispensing",
        "awaiting_confirmation",
        "delivered",
        "dropped",
        "failed",
      ],
      default: "pending",
    },
    pickupTime: { type: Date },
    deliveryTime: { type: Date },
    customerConfirmedAt: { type: Date },
    proofOfDelivery: [{ type: String }],
    riderEarnings: { type: Number, required: true, default: 0 },
    platformEarnings: { type: Number, required: true, default: 0 },
    riderNotes: { type: String },
    dropReason: { type: String },
  },
  { timestamps: true }
);

DeliverySchema.index({ rider: 1, status: 1 });
DeliverySchema.index({ order: 1 });

export default mongoose.model<IDelivery>("Delivery", DeliverySchema);
