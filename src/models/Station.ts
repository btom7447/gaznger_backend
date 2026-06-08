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
  /**
   * Avg minutes from order accept → rider arrives at station. Drives
   * the "Service time" amenity chip. Optional — surfaces only when set.
   */
  serviceTime?: string;
  /**
   * Payment options accepted at the station (excluding cash on delivery,
   * which Gaznger does not support). Examples: "Card & POS", "Bank
   * transfer", "USSD". Surfaced as amenity chips.
   */
  paymentOptions?: string[];
  /**
   * Timestamp of the last successful Gaznger dispense at this station.
   * Surfaced as "Last Gaznger dispense X ago" in the station detail
   * sheet. Server updates this on each delivery-confirm.
   */
  lastDispenseAt?: Date;
  /**
   * Rolling on-time delivery rate (0–100). Computed by aggregating the
   * last N orders' eta-vs-actual. Optional — first-time stations have
   * no data so the stat tile shows a blank state instead of a fake "—".
   */
  onTimeRate?: number;
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
    serviceTime: { type: String },
    paymentOptions: [{ type: String }],
    lastDispenseAt: { type: Date },
    onTimeRate: { type: Number, min: 0, max: 100 },
  },
  { timestamps: true }
);

GasStationSchema.index({ state: 1, lga: 1 });
GasStationSchema.index({ name: "text", address: "text" });
// PERF P0 (audit run 6): every vendor dashboard render queries
// {vendorId} without this index → full-collection scan that scales
// with total stations across all vendors, not the vendor's own slice.
// /vendor/today fans out to ~50 unindexed scans per dashboard load.
GasStationSchema.index({ vendorId: 1 });
GasStationSchema.index({ vendorId: 1, verified: 1 });

export default mongoose.model<IGasStation>("GasStation", GasStationSchema);
