import mongoose, { Schema, Document } from "mongoose";

export type DeliveryStatus = "pending" | "accepted" | "picked_up" | "delivered" | "failed";

export interface IDelivery extends Document {
  order: mongoose.Types.ObjectId;
  rider: mongoose.Types.ObjectId;
  station: mongoose.Types.ObjectId;
  status: DeliveryStatus;
  pickupTime?: Date;
  deliveryTime?: Date;
  proofOfDelivery: string[];
  riderEarnings: number;
  platformEarnings: number;
  riderNotes?: string;
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
      enum: ["pending", "accepted", "picked_up", "delivered", "failed"],
      default: "pending",
    },
    pickupTime: { type: Date },
    deliveryTime: { type: Date },
    proofOfDelivery: [{ type: String }],
    riderEarnings: { type: Number, required: true, default: 0 },
    platformEarnings: { type: Number, required: true, default: 0 },
    riderNotes: { type: String },
  },
  { timestamps: true }
);

DeliverySchema.index({ rider: 1, status: 1 });
DeliverySchema.index({ order: 1 });

export default mongoose.model<IDelivery>("Delivery", DeliverySchema);
