import mongoose, { Schema, Document } from "mongoose";

/**
 * SMS OTP record. One row per outstanding OTP — purpose-scoped so a
 * signup OTP can't satisfy a recovery verify and vice versa. Indexed
 * on (phone, purpose) so lookups are O(1) and a fresh send replaces
 * the previous outstanding code.
 *
 * Mongo TTL on `expiresAt` cleans expired rows automatically.
 *
 * Lifecycle:
 *   - send-otp / forgot-pin/start writes a new doc
 *   - verify-otp / forgot-pin/verify reads + verifies + deletes
 *   - expired rows are TTL-deleted by Mongo
 */
export type OtpPurpose = "signup" | "login" | "recovery";

export interface IOtpRecord extends Document {
  phone: string;
  purpose: OtpPurpose;
  /** Hashed OTP code — bcrypt to keep raw codes out of the DB at rest. */
  codeHash: string;
  /** Wrong-code attempt counter. Used to surface attemptsRemaining + 429. */
  attempts: number;
  /** When the underlying SMS code expires. */
  expiresAt: Date;
  /** When the resend button is allowed to fire again. */
  resendAvailableAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const OtpRecordSchema: Schema<IOtpRecord> = new Schema(
  {
    phone: { type: String, required: true, index: true },
    purpose: {
      type: String,
      enum: ["signup", "login", "recovery"],
      required: true,
      index: true,
    },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    resendAvailableAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// One outstanding OTP per phone × purpose. send-otp deletes the prior
// entry before insert so a fresh send always replaces.
OtpRecordSchema.index({ phone: 1, purpose: 1 }, { unique: true });

export default mongoose.model<IOtpRecord>("OtpRecord", OtpRecordSchema);
