import mongoose, { Schema, Document } from "mongoose";

export interface IGasStation extends Document {
  name: string;
  address: string;
  state: string; // new for filtering
  lga: string; // new for filtering
  location: { lat: number; lng: number };
  fuels: { fuel: Schema.Types.ObjectId; pricePerUnit: number }[];
  rating: number;
  verified: boolean;
}

const GasStationSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    address: { type: String, required: true },
    state: { type: String, required: true }, // new
    lga: { type: String, required: true }, // new
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
    verified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default mongoose.model<IGasStation>("GasStation", GasStationSchema);
