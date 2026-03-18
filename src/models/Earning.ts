import mongoose, { Schema, Document } from "mongoose";

export type EarningRole = "vendor" | "rider";
export type EarningType = "fuel_sale" | "delivery_fee";
export type EarningStatus = "pending" | "settled";

export interface IEarning extends Document {
  user: mongoose.Types.ObjectId;
  role: EarningRole;
  order: mongoose.Types.ObjectId;
  delivery?: mongoose.Types.ObjectId;
  amount: number;
  type: EarningType;
  status: EarningStatus;
  settledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const EarningSchema: Schema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["vendor", "rider"], required: true },
    order: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    delivery: { type: Schema.Types.ObjectId, ref: "Delivery" },
    amount: { type: Number, required: true },
    type: { type: String, enum: ["fuel_sale", "delivery_fee"], required: true },
    status: { type: String, enum: ["pending", "settled"], default: "pending" },
    settledAt: { type: Date },
  },
  { timestamps: true }
);

EarningSchema.index({ user: 1, status: 1 });
EarningSchema.index({ order: 1 });
EarningSchema.index({ createdAt: -1 });

export default mongoose.model<IEarning>("Earning", EarningSchema);
