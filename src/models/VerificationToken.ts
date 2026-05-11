import mongoose, { Schema, Document } from "mongoose";

/**
 * Single-use opaque token issued by /auth/verify-otp +
 * /auth/forgot-pin/verify. Consumed by the next step (signup, login
 * with new device, recovery reset). Mongo TTL on `expiresAt` cleans
 * expired rows automatically.
 *
 * The token value is itself unique-indexed so a stolen verifyToken
 * can be invalidated by deleting the row.
 */
export type VerificationTokenPurpose = "signup" | "login" | "recovery";

export interface IVerificationToken extends Document {
  /** Opaque random string. Never reveal — pass back as-is to the next step. */
  token: string;
  phone: string;
  purpose: VerificationTokenPurpose;
  /** Device that proved phone ownership. Required to match on login/signup. */
  deviceId?: string;
  expiresAt: Date;
  createdAt: Date;
}

const VerificationTokenSchema: Schema<IVerificationToken> = new Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    phone: { type: String, required: true, index: true },
    purpose: {
      type: String,
      enum: ["signup", "login", "recovery"],
      required: true,
    },
    deviceId: { type: String },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

export default mongoose.model<IVerificationToken>(
  "VerificationToken",
  VerificationTokenSchema
);
