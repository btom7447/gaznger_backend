import mongoose, { Schema, Document } from "mongoose";

export interface IOrder extends Document {
  user: mongoose.Types.ObjectId;
  fuel: mongoose.Types.ObjectId;
  station: mongoose.Types.ObjectId;
  quantity: number;
  unit: string;
  fuelCost: number;
  deliveryFee: number;
  totalPrice: number;
  status: "pending" | "confirmed" | "assigned" | "in-transit" | "awaiting_confirmation" | "delivered" | "cancelled";
  deliveryAddress: mongoose.Types.ObjectId;
  paymentStatus: "unpaid" | "paid" | "refunded";
  paymentRef?: string;
  cancellationReason?: string;
  riderId?: mongoose.Types.ObjectId;
  riderAssignedAt?: Date;
  dispatchAttempt: number;
  dispatchExpiresAt?: Date;

  /** Free-form rider note. Captured on Delivery + LPG-Swap Schedule. */
  note?: string;

  /**
   * LPG-Swap only — when the rider should COME BACK for the empty cylinder.
   * Null = same-trip (rider takes the empty in the same delivery visit).
   */
  returnSwapAt?: Date | null;

  /** Customer-paid delivery timestamp (set on customer-confirm-delivered). */
  deliveredAt?: Date;

  /**
   * Final amount actually charged. Equals `totalPrice` for liquid; for LPG
   * it's the smaller of estimated vs weighed-actual (the legacy at-station
   * weigh-in adjustment per spec). Delivered + Complete read this.
   */
  totalCharged?: number;

  /**
   * LPG-Swap weigh-in capture, populated by the rider app once weighed at
   * the station. Used by the Handoff screen weight verification card.
   */
  weighIn?: {
    emptyKg: number;
    fullKg: number;
    netKg: number;
    weighedAt: Date;
  };

  /** Awarded at delivery confirm. Surfaced on Delivered. */
  pointsEarned?: number;

  /** Rating + tip, set on /api/orders/:id/rate. */
  rating?: {
    stars: number;
    tags: string[];
    tip: number;
    note?: string;
    ratedAt: Date;
  };

  // Gas-specific fields
  cylinderType?: string;
  deliveryType?: "cylinder_swap" | "home_refill";
  cylinderImages?: string[];
  /**
   * LPG-Swap cylinder details. Customer-supplied on the Cylinder
   * screen; vendor/rider verifies on arrival.
   */
  cylinderDetails?: {
    brand?: string;
    valve?: string;
    age?: string;
    test?: string;
  };
}

const OrderSchema: Schema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    fuel: { type: Schema.Types.ObjectId, ref: "FuelType", required: true },
    station: { type: Schema.Types.ObjectId, ref: "GasStation", required: true },
    quantity: { type: Number, required: true },
    unit: { type: String, required: true },
    fuelCost: { type: Number, required: true },
    deliveryFee: { type: Number, required: true, default: 0 },
    totalPrice: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending", "confirmed", "assigned", "in-transit", "awaiting_confirmation", "delivered", "cancelled"],
      default: "pending",
    },
    deliveryAddress: {
      type: Schema.Types.ObjectId,
      ref: "Address",
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "paid", "refunded"],
      default: "unpaid",
    },
    paymentRef: { type: String },
    riderId: { type: Schema.Types.ObjectId, ref: "User" },
    riderAssignedAt: { type: Date },
    dispatchAttempt: { type: Number, default: 0 },
    dispatchExpiresAt: { type: Date },

    note: { type: String, maxlength: 500 },
    returnSwapAt: { type: Date, default: null },
    deliveredAt: { type: Date },
    totalCharged: { type: Number },
    weighIn: {
      emptyKg: { type: Number },
      fullKg: { type: Number },
      netKg: { type: Number },
      weighedAt: { type: Date },
    },
    pointsEarned: { type: Number },
    rating: {
      stars: { type: Number, min: 1, max: 5 },
      tags: [{ type: String }],
      tip: { type: Number, default: 0 },
      note: { type: String, maxlength: 500 },
      ratedAt: { type: Date },
    },

    // Gas-specific
    cylinderType: { type: String },
    deliveryType: { type: String, enum: ["cylinder_swap", "home_refill"] },
    cylinderImages: [{ type: String }],
    cylinderDetails: {
      brand: { type: String },
      valve: { type: String },
      age: { type: String },
      test: { type: String },
    },
  },
  { timestamps: true }
);

OrderSchema.index({ user: 1, status: 1 });
OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ paymentRef: 1 });

export default mongoose.model<IOrder>("Order", OrderSchema);
