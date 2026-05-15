import mongoose, { Schema, Document } from "mongoose";

/**
 * Approved fuel depot / plant — the upstream source vendors buy bulk
 * fuel from. Admins curate this list; vendors browse + submit purchase
 * orders against it via the Phase-4 bulk purchase flow.
 *
 * Each plant carries per-product prices (vendors pick a product when
 * submitting a bulk PO). `reliabilityScore` is a 0..100 rolling metric
 * computed from past deliveries (timeliness + variance %), surfaced
 * as the "Most reliable" badge in the plant pick list.
 */

export interface IFuelPlantProductPrice {
  /** FuelType _id reference. */
  fuel: mongoose.Types.ObjectId;
  /** Price per unit IN NAIRA WHOLE UNITS (matching Station.fuels). */
  pricePerUnit: number;
  /** Is the product currently in stock at this plant. */
  available: boolean;
}

export interface IFuelPlant extends Document {
  name: string;
  /** Short label for chips (e.g. "Apapa NNPC"). */
  shortName?: string;
  address: string;
  state: string;
  lga?: string;
  location: { lat: number; lng: number };
  /** NMDPRA / DPR licence number — visible on the plant card. */
  licenceNumber?: string;
  /** 0..100 rolling reliability score from past deliveries. */
  reliabilityScore?: number;
  /** Computed from delivered POs: average vendor-side reconcile variance %. */
  avgVariancePct?: number;
  /** Computed from delivered POs: average dispatch → arrival hours. */
  avgTransitHours?: number;
  /** Hero image. */
  image?: string;
  isApproved: boolean;
  isActive: boolean;
  products: IFuelPlantProductPrice[];
  createdAt: Date;
  updatedAt: Date;
}

const FuelPlantSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    shortName: { type: String },
    address: { type: String, required: true },
    state: { type: String, required: true },
    lga: { type: String },
    location: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
    },
    licenceNumber: { type: String },
    reliabilityScore: { type: Number, min: 0, max: 100 },
    avgVariancePct: { type: Number, min: 0 },
    avgTransitHours: { type: Number, min: 0 },
    image: { type: String, default: "" },
    isApproved: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    products: [
      {
        fuel: { type: Schema.Types.ObjectId, ref: "FuelType", required: true },
        pricePerUnit: { type: Number, required: true },
        available: { type: Boolean, default: true },
      },
    ],
  },
  { timestamps: true },
);

FuelPlantSchema.index({ isApproved: 1, isActive: 1 });
FuelPlantSchema.index({ state: 1, lga: 1 });

export default mongoose.model<IFuelPlant>("FuelPlant", FuelPlantSchema);
