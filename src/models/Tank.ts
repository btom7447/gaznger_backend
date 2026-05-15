import mongoose, { Schema, Document } from "mongoose";

/**
 * Storage tank at a fuel station. One tank per fuel-type-at-station;
 * vendor manually updates the current level (and capacity once at
 * setup time). Sensor integration will replace the manual entry in
 * v6.5+ but the schema is forward-compatible (just adds `sensorId`
 * + a "last sync" timestamp).
 *
 * Units match the FuelType:
 *   - Petrol/Diesel/Kero → litres
 *   - LPG/Gas            → kg
 *
 * `lowThresholdPct` drives the "restock soon" alert on Today.
 * Default 25%, vendor-configurable.
 */

export interface ITank extends Document {
  station: mongoose.Types.ObjectId;
  vendor: mongoose.Types.ObjectId;
  fuelType: mongoose.Types.ObjectId;
  unit: string;
  /** Maximum tank capacity in `unit`. */
  capacity: number;
  /** Current level in `unit`. Manual entry today. */
  currentLevel: number;
  /** When the level was last updated. */
  lastUpdatedAt: Date;
  /** Optional friendly label (e.g. "Tank A — 30,000 L"). */
  label?: string;
  /** Alert threshold (% of capacity). Default 25. */
  lowThresholdPct: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const TankSchema: Schema = new Schema(
  {
    station: { type: Schema.Types.ObjectId, ref: "GasStation", required: true },
    vendor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    fuelType: { type: Schema.Types.ObjectId, ref: "FuelType", required: true },
    unit: { type: String, required: true },
    capacity: { type: Number, required: true, min: 0 },
    currentLevel: { type: Number, required: true, min: 0, default: 0 },
    lastUpdatedAt: { type: Date, default: Date.now },
    label: { type: String, trim: true },
    lowThresholdPct: { type: Number, default: 25, min: 0, max: 100 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

TankSchema.index({ station: 1, fuelType: 1 });
TankSchema.index({ vendor: 1 });

export default mongoose.model<ITank>("Tank", TankSchema);
