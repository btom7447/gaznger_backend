import mongoose, { Schema, Document } from "mongoose";

/**
 * RefreshToken doubles as our "active session" record. Each row maps
 * one device to one auth grant. The Active Sessions screen lists these
 * (filtered to current user) and lets the user revoke individual rows
 * without nuking every login.
 *
 * Optional device metadata is captured at login time. We keep the User
 * Agent string verbatim (parsed client-side for "iPhone · Safari" etc.)
 * and a short device label the client may supply. Both are best-effort
 * — older clients won't send them and the screen falls back to a
 * generic "Device".
 */
export interface IRefreshToken extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  token: string;
  expiresAt: Date;
  /** Raw User-Agent header at login time. */
  userAgent?: string;
  /** Free-form device label (e.g. "iPhone 15 Pro"). */
  device?: string;
  /** First-seen IP at login time. Useful for "this isn't me" reviews. */
  ip?: string;
  /** Bumped each time the token is refreshed so "last active" is honest. */
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const RefreshTokenSchema: Schema<IRefreshToken> = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    token: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    userAgent: { type: String },
    device: { type: String },
    ip: { type: String },
    lastUsedAt: { type: Date },
  },
  { timestamps: true }
);

RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
RefreshTokenSchema.index({ user: 1 });

export default mongoose.model<IRefreshToken>("RefreshToken", RefreshTokenSchema);
