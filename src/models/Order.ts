import mongoose, { Schema, Document } from "mongoose";

export interface IOrder extends Document {
  user: mongoose.Types.ObjectId;
  fuel: mongoose.Types.ObjectId;
  station: mongoose.Types.ObjectId;
  quantity: number;
  unit: string; // "L" or "kg"
  totalPrice: number;
  status: "pending" | "in-transit" | "delivered";
  deliveryAddress: mongoose.Types.ObjectId;
}

const OrderSchema: Schema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    fuel: { type: Schema.Types.ObjectId, ref: "FuelType", required: true },
    station: { type: Schema.Types.ObjectId, ref: "GasStation", required: true },
    quantity: { type: Number, required: true },
    unit: { type: String, required: true },
    totalPrice: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending", "in-transit", "delivered"],
      default: "pending",
    },
    deliveryAddress: {
      type: Schema.Types.ObjectId,
      ref: "Address",
      required: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model<IOrder>("Order", OrderSchema);