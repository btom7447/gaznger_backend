import mongoose, { Schema, Document } from "mongoose";
import crypto from "crypto";

/**
 * Rider invite — the lightweight handshake that ties a rider to a
 * vendor before there's a proper Affiliation table (Phase 5+ scope).
 *
 * Vendor enters a phone number on the "invite rider" screen. We mint
 * a row here and send an SMS with a deep link. When that rider signs
 * up (or signs in on an existing account) and the phone matches,
 * the bootstrap accepts the invite — the rider now sees that
 * vendor's orders preferentially in the dispatch queue, and the
 * vendor sees them in their Team screen even before they've delivered
 * any orders.
 *
 * Status:
 *   - "pending"  : SMS sent, no signup / acknowledgement yet
 *   - "accepted" : rider's User row has confirmed the phone match
 *   - "expired"  : 7-day TTL elapsed
 *   - "revoked"  : vendor pulled the invite
 *
 * `token` is a 16-byte url-safe random string carried in the deep
 * link; we look invites up by token, not phone, so an attacker who
 * scrapes the SMS body can't bind to another phone.
 */
export type RiderInviteStatus = "pending" | "accepted" | "expired" | "revoked";

export interface IRiderInvite extends Document {
  vendor: mongoose.Types.ObjectId;
  /** Phone in E.164 (e.g. +2348012345678). */
  phone: string;
  /** Optional human-friendly note shown to the vendor. */
  displayName?: string;
  token: string;
  status: RiderInviteStatus;
  /** Soft-bind when the rider signs up with the matching phone. */
  acceptedBy?: mongoose.Types.ObjectId;
  acceptedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const RiderInviteSchema: Schema = new Schema(
  {
    vendor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    phone: { type: String, required: true, trim: true },
    displayName: { type: String, trim: true },
    token: {
      type: String,
      required: true,
      unique: true,
      default: () => crypto.randomBytes(16).toString("hex"),
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "expired", "revoked"],
      default: "pending",
    },
    acceptedBy: { type: Schema.Types.ObjectId, ref: "User" },
    acceptedAt: { type: Date },
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + INVITE_TTL_MS),
    },
  },
  { timestamps: true },
);

RiderInviteSchema.index({ vendor: 1, status: 1 });
RiderInviteSchema.index({ phone: 1, vendor: 1 });

export default mongoose.model<IRiderInvite>("RiderInvite", RiderInviteSchema);
