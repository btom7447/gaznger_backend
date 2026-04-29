import mongoose, { Schema, Document } from "mongoose";

export interface IGasStation extends Document {
  name: string;
  address: string;
  state: string;
  lga: string;
  location: { lat: number; lng: number };
  fuels: {
    fuel: Schema.Types.ObjectId;
    pricePerUnit: number;
    available: boolean;
    scheduledPrice?: { price: number; effectiveAt: Date };
  }[];
  rating: number;
  image: string;
  images: string[];
  verified: boolean;
  vendorId?: mongoose.Types.ObjectId;
  isActive: boolean;
  autoAcceptOrders: boolean;
  operatingHours?: { open: string; close: string };
}

const GasStationSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    address: { type: String, required: true },
    state: { type: String, required: true },
    lga: { type: String, required: true },
    location: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
    },
    fuels: [
      {
        fuel: { type: Schema.Types.ObjectId, ref: "FuelType", required: true },
        pricePerUnit: { type: Number, required: true },
        available: { type: Boolean, default: true },
        scheduledPrice: {
          price: { type: Number },
          effectiveAt: { type: Date },
        },
      },
    ],
    rating: { type: Number, default: 0 },
    image: { type: String, default: "" },
    images: [{ type: String }],
    verified: { type: Boolean, default: false },
    vendorId: { type: Schema.Types.ObjectId, ref: "User" },
    isActive: { type: Boolean, default: true },
    autoAcceptOrders: { type: Boolean, default: false },
    operatingHours: {
      open: { type: String },
      close: { type: String },
    },
  },
  { timestamps: true }
);

GasStationSchema.index({ state: 1, lga: 1 });
GasStationSchema.index({ name: "text", address: "text" });

export default mongoose.model<IGasStation>("GasStation", GasStationSchema);
