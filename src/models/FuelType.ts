import mongoose, { Schema, Document } from "mongoose";

export interface IFuelType extends Document {
  name: string; // Petrol, Diesel, Gas, Oil
  unit: string; // "L" or "kg"
  pricePerUnit: number; // Current price per L or kg
}

const FuelTypeSchema: Schema = new Schema(
  {
    name: { type: String, required: true, unique: true },
    unit: { type: String, default: "L" },
    pricePerUnit: { type: Number, required: true },
  },
  { timestamps: true }
);

export default mongoose.model<IFuelType>("FuelType", FuelTypeSchema);
