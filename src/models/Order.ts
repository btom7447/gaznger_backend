import mongoose, { Schema, Document } from "mongoose";

export interface IOrder extends Document {
  user: mongoose.Types.ObjectId;
  fuel: mongoose.Types.ObjectId;
  station: mongoose.Types.ObjectId;
  quantity: number;
  unit: string;
  fuelCost: number;
  deliveryFee: number;
  totalPrice: number;
  status: "pending" | "confirmed" | "assigned" | "in-transit" | "delivered" | "cancelled";
  deliveryAddress: mongoose.Types.ObjectId;
  paymentStatus: "unpaid" | "paid" | "refunded";
  paymentRef?: string;
  cancellationReason?: string;
  riderId?: mongoose.Types.ObjectId;
  riderAssignedAt?: Date;
  dispatchAttempt: number;
  dispatchExpiresAt?: Date;

  // Gas-specific fields
  cylinderType?: string;
  deliveryType?: "cylinder_swap" | "home_refill";
  cylinderImages?: string[];
}

const OrderSchema: Schema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    fuel: { type: Schema.Types.ObjectId, ref: "FuelType", required: true },
    station: { type: Schema.Types.ObjectId, ref: "GasStation", required: true },
    quantity: { type: Number, required: true },
    unit: { type: String, required: true },
    fuelCost: { type: Number, required: true },
    deliveryFee: { type: Number, required: true, default: 0 },
    totalPrice: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending", "confirmed", "assigned", "in-transit", "delivered", "cancelled"],
      default: "pending",
    },
    deliveryAddress: {
      type: Schema.Types.ObjectId,
      ref: "Address",
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "paid", "refunded"],
      default: "unpaid",
    },
    paymentRef: { type: String },
    riderId: { type: Schema.Types.ObjectId, ref: "User" },
    riderAssignedAt: { type: Date },
    dispatchAttempt: { type: Number, default: 0 },
    dispatchExpiresAt: { type: Date },

    // Gas-specific
    cylinderType: { type: String },
    deliveryType: { type: String, enum: ["cylinder_swap", "home_refill"] },
    cylinderImages: [{ type: String }],
  },
  { timestamps: true }
);

OrderSchema.index({ user: 1, status: 1 });
OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ paymentRef: 1 });

export default mongoose.model<IOrder>("Order", OrderSchema);
