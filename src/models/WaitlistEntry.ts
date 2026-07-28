import mongoose, { Document, Schema } from "mongoose";

/**
 * Pre-launch waitlist signup from the public website (web/).
 *
 * Public, unauthenticated writes — keep the surface tiny. Email is the
 * identity key; repeat signups are idempotent upserts so the endpoint
 * never leaks whether an address is already on the list.
 */
export interface IWaitlistEntry extends Document {
  email: string;
  /** Which side of the marketplace they're interested in. */
  role: "customer" | "vendor" | "rider";
  /** Free-text city/LGA — used for launch-city planning. */
  city?: string;
  /** Where the signup came from (future-proofing for QR / social links). */
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

const waitlistEntrySchema = new Schema<IWaitlistEntry>(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["customer", "vendor", "rider"],
      default: "customer",
    },
    city: { type: String, trim: true, maxlength: 80 },
    source: { type: String, trim: true, default: "website", maxlength: 40 },
  },
  { timestamps: true }
);

export default mongoose.model<IWaitlistEntry>(
  "WaitlistEntry",
  waitlistEntrySchema
);
