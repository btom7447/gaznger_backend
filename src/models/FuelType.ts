import mongoose, { Schema, Document } from "mongoose";

export interface IFuelType extends Document {
  name: string; // Petrol, Diesel, Gas, Oil
  unit: string; // "L" or "kg"
  icon?: string; // Image URL
}

const FuelTypeSchema: Schema = new Schema(
  {
    name: { type: String, required: true, unique: true },
    unit: { type: String, default: "L" },
    icon: { type: String },
  },
  { timestamps: true }
);

export default mongoose.model<IFuelType>("FuelType", FuelTypeSchema);