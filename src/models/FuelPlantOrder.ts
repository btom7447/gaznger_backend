import mongoose, { Schema, Document } from "mongoose";

export type FuelPlantOrderStatus =
  | "pending"
  | "confirmed"
  | "in-transit"
  | "delivered"
  | "cancelled";

export interface IFuelPlantOrder extends Document {
  vendor: mongoose.Types.ObjectId;
  station: mongoose.Types.ObjectId;
  fuelType: mongoose.Types.ObjectId;
  quantity: number;
  unit: string;
  totalCost: number;
  status: FuelPlantOrderStatus;
  paymentStatus: "unpaid" | "paid";
  paymentRef?: string;
  shipmentRef?: string;
  supplierName?: string;
  estimatedDelivery?: Date;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const FuelPlantOrderSchema: Schema = new Schema(
  {
    vendor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    station: { type: Schema.Types.ObjectId, ref: "GasStation", required: true },
    fuelType: { type: Schema.Types.ObjectId, ref: "FuelType", required: true },
    quantity: { type: Number, required: true },
    unit: { type: String, required: true },
    totalCost: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending", "confirmed", "in-transit", "delivered", "cancelled"],
      default: "pending",
    },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "paid"],
      default: "unpaid",
    },
    paymentRef: { type: String },
    shipmentRef: { type: String },
    supplierName: { type: String },
    estimatedDelivery: { type: Date },
    notes: { type: String },
  },
  { timestamps: true }
);

FuelPlantOrderSchema.index({ vendor: 1, status: 1 });
FuelPlantOrderSchema.index({ station: 1 });
FuelPlantOrderSchema.index({ createdAt: -1 });

export default mongoose.model<IFuelPlantOrder>("FuelPlantOrder", FuelPlantOrderSchema);
