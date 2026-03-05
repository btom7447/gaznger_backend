import mongoose, { Schema, Document } from "mongoose";

export interface IGasStation extends Document {
  name: string;
  address: string;
  state: string;
  lga: string;
  location: { lat: number; lng: number };
  fuels: { fuel: Schema.Types.ObjectId; pricePerUnit: number }[];
  rating: number;
  image: string;
  verified: boolean;
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
      },
    ],
    rating: { type: Number, default: 0 },
    image: { type: String, required: true },
    verified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

GasStationSchema.index({ state: 1, lga: 1 });
GasStationSchema.index({ name: "text", address: "text" });

export default mongoose.model<IGasStation>("GasStation", GasStationSchema);
