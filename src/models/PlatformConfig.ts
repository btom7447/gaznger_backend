import mongoose, { Schema, Document } from "mongoose";

/**
 * Singleton config doc. Always loaded via `getPlatformConfig()` in
 * `utils/platformConfig.ts` (60s in-memory cache). Mutated only by admin
 * endpoints, which also write an AuditLog entry.
 *
 * Per-vendor / per-rider commission overrides are not yet modeled — when
 * needed, add a `commissionOverrides` collection keyed on user, and
 * extend `getCommission(userId, kind)` to consult it before falling back
 * to the singleton.
 */
export interface IPlatformConfig extends Document {
  /** Marker so we can find the singleton. Always "main". */
  key: "main";

  /** Fraction of fuelCost taken from vendor on each order. e.g. 0.05 = 5%. */
  vendorCommission: number;
  /** Fraction of deliveryFee taken from rider on each delivery. */
  riderCommission: number;

  /** Hours after delivery confirm when escrow auto-releases (dispute window). */
  disputeWindowHours: number;
  /** Hours admin has to review withdrawals before transfer fires. */
  withdrawalHoldHours: number;

  /** Min top-up / charge amount in NGN. Paystack minimum is ₦100. */
  minChargeNgn: number;

  /** Withdrawal fee passed to user (NGN). Net from amount. */
  withdrawalFeeNgn: number;

  /** Toggle: any in-app payments enabled. Lets ops kill switch instantly. */
  paymentsEnabled: boolean;
  /** Toggle: any in-app withdrawals enabled. */
  withdrawalsEnabled: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const PlatformConfigSchema: Schema<IPlatformConfig> = new Schema(
  {
    key: { type: String, enum: ["main"], unique: true, default: "main" },

    vendorCommission: { type: Number, default: 0.05 },
    riderCommission: { type: Number, default: 0.05 },

    disputeWindowHours: { type: Number, default: 48 },
    withdrawalHoldHours: { type: Number, default: 24 },

    minChargeNgn: { type: Number, default: 100 },
    withdrawalFeeNgn: { type: Number, default: 50 },

    paymentsEnabled: { type: Boolean, default: true },
    withdrawalsEnabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model<IPlatformConfig>(
  "PlatformConfig",
  PlatformConfigSchema
);
