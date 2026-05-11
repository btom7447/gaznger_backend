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

  /**
   * Minimum mobile-app native version still allowed. Compared against
   * the X-App-Version header sent by the mobile (lib/api.ts via
   * expo-application). Below this → 426 + X-Min-Version response
   * header so the mobile force-update screen activates. Empty string
   * means no gate (default — never force-update accidentally).
   */
  minMobileVersion: string;

  /**
   * Server-wide maintenance switch. When true, every API endpoint
   * (except /health) returns 503 with code: "MAINTENANCE" so the
   * mobile routes to the maintenance screen. `expectedBackAt` rides
   * along on the response so the screen can show an ETA.
   */
  maintenanceMode: boolean;
  maintenanceExpectedBackAt?: Date;

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

    minMobileVersion: { type: String, default: "" },
    maintenanceMode: { type: Boolean, default: false },
    maintenanceExpectedBackAt: { type: Date },
  },
  { timestamps: true }
);

export default mongoose.model<IPlatformConfig>(
  "PlatformConfig",
  PlatformConfigSchema
);
