import mongoose, { Schema, Document } from "mongoose";

/**
 * Bulk fuel purchase — vendor → fuel plant.
 *
 * v6 introduces an 11-step pipeline (timeline tracker) that supersedes
 * the legacy 5-status flow. Both shapes are kept on the document so old
 * rows and tooling keep working while the v6 UI reads `step` + `timeline`.
 *
 * `step` (1..11):
 *   1.  requested        — vendor submits the PO (default at create)
 *   2.  acknowledged     — plant acks
 *   3.  paid             — vendor pays escrow / deposit
 *   4.  allocated        — plant reserves the volume
 *   5.  truck_scheduled  — truck assigned to the load
 *   6.  driver_verified  — driver at the gate, ID checked
 *   7.  loading          — pump in progress at the depot
 *   8.  dispatched       — left the plant
 *   9.  in_transit       — on the road (truck:location pings)
 *   10. at_station       — arrived at vendor's station
 *   11. offloaded        — vendor confirmed receipt + offloaded volume
 *
 * After step 11 the vendor reconciles loaded-vs-offloaded volumes:
 *   - within tolerance (≤0.5%) → close out (status = "delivered")
 *   - over tolerance              → open dispute OR accept variance
 *
 * `timeline[]` captures every step transition with timestamp + optional
 * note + actor, so the mobile timeline view can render the full history
 * without computing it on the fly.
 */

export type FuelPlantOrderLegacyStatus =
  | "pending"
  | "confirmed"
  | "in-transit"
  | "delivered"
  | "cancelled";

export type FuelPlantOrderStep =
  | "requested"
  | "acknowledged"
  | "paid"
  | "allocated"
  | "truck_scheduled"
  | "driver_verified"
  | "loading"
  | "dispatched"
  | "in_transit"
  | "at_station"
  | "offloaded";

export const STEP_ORDER: FuelPlantOrderStep[] = [
  "requested",
  "acknowledged",
  "paid",
  "allocated",
  "truck_scheduled",
  "driver_verified",
  "loading",
  "dispatched",
  "in_transit",
  "at_station",
  "offloaded",
];

export interface IFuelPlantOrderTimelineEntry {
  step: FuelPlantOrderStep;
  at: Date;
  /** Who advanced it: 'plant' | 'vendor' | 'driver' | 'system'. */
  by: "plant" | "vendor" | "driver" | "system";
  /** Optional free-form note (e.g. dispatch dispatcher notes). */
  note?: string;
}

export interface IFuelPlantOrder extends Document {
  vendor: mongoose.Types.ObjectId;
  station: mongoose.Types.ObjectId;
  /** New: which depot the PO is against. Optional for legacy rows. */
  plant?: mongoose.Types.ObjectId;
  fuelType: mongoose.Types.ObjectId;
  quantity: number;
  unit: string;
  /** Rate per unit IN NAIRA WHOLE UNITS (matches plant.products[].pricePerUnit). */
  pricePerUnit?: number;
  /** Logistics fee charged by plant — separate line on the receipt. */
  logisticsFee?: number;
  /** Gaznger platform fee — mirrors order serviceFee (audit C.4). */
  serviceFee?: number;
  totalCost: number;
  /** Coarse legacy status — kept for tooling that hasn't migrated. */
  status: FuelPlantOrderLegacyStatus;
  /** Current step in the 11-step pipeline. v6 UI reads this. */
  step?: FuelPlantOrderStep;
  /** Full transition log — drives the timeline tracker. */
  timeline?: IFuelPlantOrderTimelineEntry[];

  paymentStatus: "unpaid" | "paid";
  paymentRef?: string;
  shipmentRef?: string;
  supplierName?: string;

  /** Truck plate + driver — surfaces from step 5 onward. */
  truckPlate?: string;
  driverName?: string;
  driverPhone?: string;
  driverId?: string;

  /** Window the vendor picked: "today" | "tomorrow" | ISO date string. */
  deliveryWindow?: string;
  estimatedDelivery?: Date;

  /** Notes the vendor typed on the spec step. */
  notes?: string;

  /** Volume the plant says it loaded (set on step 8 dispatched). */
  loadedQty?: number;
  /** Volume vendor measured on offload (set on step 11 offloaded). */
  offloadedQty?: number;
  /** Computed % variance: (loaded - offloaded) / loaded * 100. */
  variancePct?: number;

  /** Vendor decision after offload. */
  reconcileOutcome?: "ok" | "dispute" | "accept_variance";

  /** Cancellation reason (when status = cancelled). */
  cancellationReason?: string;
  /** Set when reconcileOutcome = "ok" or "accept_variance" — closes the PO. */
  closedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const FuelPlantOrderTimelineSchema = new Schema<IFuelPlantOrderTimelineEntry>(
  {
    step: {
      type: String,
      enum: STEP_ORDER,
      required: true,
    },
    at: { type: Date, required: true, default: Date.now },
    by: {
      type: String,
      enum: ["plant", "vendor", "driver", "system"],
      required: true,
    },
    note: { type: String },
  },
  { _id: false },
);

const FuelPlantOrderSchema: Schema = new Schema(
  {
    vendor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    station: { type: Schema.Types.ObjectId, ref: "GasStation", required: true },
    plant: { type: Schema.Types.ObjectId, ref: "FuelPlant" },
    fuelType: { type: Schema.Types.ObjectId, ref: "FuelType", required: true },
    quantity: { type: Number, required: true },
    unit: { type: String, required: true },
    pricePerUnit: { type: Number },
    logisticsFee: { type: Number, default: 0 },
    serviceFee: { type: Number, default: 0 },
    totalCost: { type: Number, required: true },

    status: {
      type: String,
      enum: ["pending", "confirmed", "in-transit", "delivered", "cancelled"],
      default: "pending",
    },
    step: {
      type: String,
      enum: STEP_ORDER,
      default: "requested",
    },
    timeline: { type: [FuelPlantOrderTimelineSchema], default: [] },

    paymentStatus: {
      type: String,
      enum: ["unpaid", "paid"],
      default: "unpaid",
    },
    paymentRef: { type: String },
    shipmentRef: { type: String },
    supplierName: { type: String },

    truckPlate: { type: String },
    driverName: { type: String },
    driverPhone: { type: String },
    driverId: { type: String },

    deliveryWindow: { type: String },
    estimatedDelivery: { type: Date },
    notes: { type: String },

    loadedQty: { type: Number },
    offloadedQty: { type: Number },
    variancePct: { type: Number },

    reconcileOutcome: {
      type: String,
      enum: ["ok", "dispute", "accept_variance"],
    },
    cancellationReason: { type: String },
    closedAt: { type: Date },
  },
  { timestamps: true },
);

FuelPlantOrderSchema.index({ vendor: 1, status: 1 });
FuelPlantOrderSchema.index({ vendor: 1, step: 1 });
FuelPlantOrderSchema.index({ station: 1 });
FuelPlantOrderSchema.index({ createdAt: -1 });

export default mongoose.model<IFuelPlantOrder>(
  "FuelPlantOrder",
  FuelPlantOrderSchema,
);
